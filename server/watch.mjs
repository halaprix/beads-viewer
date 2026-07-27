import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

// Change detection, in order of what survived probing:
//
//   journal.idx size  - byte-stable across 9 reads, grew on every write. Used.
//   interactions.jsonl - status transitions ONLY; grew 2 lines across ~15 writes.
//   last-touched       - bumped by reads too, including --readonly reads.
//   store mtime        - same problem.
//   bd --watch         - an ANSI terminal redraw, not a stream.
//   polling bd         - 130-190ms per call; at 1Hz that is ~13% of a core forever.
//
// journal.idx is an internal Dolt detail with no stability guarantee, so it lives
// behind this one function and is compared for difference, never for growth: `bd gc`
// and `bd compact` legitimately shrink it.
const DEBOUNCE_MS = 120;
const POLL_MS = 4000;

// The journal is not directly under the path `bd where` reports: the real layout is
// <databasePath>/<database name>/.dolt/noms/. Assuming otherwise made the token a
// constant, which silently disabled live refresh rather than failing loudly - exactly
// the trap of hardcoding a store path instead of discovering it.
async function findNomsDir(databasePath) {
  const direct = path.join(databasePath, ".dolt", "noms");
  if (await stat(direct).then(() => true, () => false)) {
    return direct;
  }
  const entries = await readdir(databasePath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const nested = path.join(databasePath, entry.name, ".dolt", "noms");
    if (await stat(nested).then(() => true, () => false)) {
      return nested;
    }
  }
  return null;
}

async function readToken(nomsDir) {
  if (!nomsDir) {
    return null;
  }
  const candidates = [path.join(nomsDir, "journal.idx"), path.join(nomsDir, "LOCK")];
  const parts = [];
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    parts.push(info ? `${path.basename(candidate)}:${info.size}` : "-");
  }
  return parts.join("|");
}

// Watches the directory, never a file. fs.watch resolves a path to an inode, and both
// editors and Dolt write a temp file then rename over the target - so a file watcher
// fires once and then sits on an orphaned inode, permanently silent.
export function watchStore({ databasePath, onChange }) {
  let token = null;
  let timer = null;
  let closed = false;
  let nomsDir = null;
  const watchers = [];

  const check = async () => {
    if (closed) {
      return;
    }
    nomsDir ??= await findNomsDir(databasePath);
    const next = await readToken(nomsDir).catch(() => null);
    if (next && next !== token) {
      token = next;
      onChange(token);
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(check, DEBOUNCE_MS);
  };

  // Watch both the store root and the journal directory. Resolved lazily below, so
  // the initial check populates nomsDir before these are attached on the next tick.
  void findNomsDir(databasePath).then((resolved) => {
    nomsDir ??= resolved;
    for (const dir of [databasePath, resolved].filter(Boolean)) {
      attach(dir);
    }
  });

  function attach(dir) {
    try {
      // The filename argument is ignored on purpose: every event means only "maybe",
      // and the token decides. That makes false positives from locks and backups free.
      const watcher = watch(dir, { recursive: false }, schedule);
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // A missing directory is not fatal - the poll below is the real guarantee.
    }
  }

  // Node documents that fs.watch events can be missed or duplicated, so the poll is
  // the safety net that removes the whole "UI silently stale" class of bug.
  const poll = setInterval(check, POLL_MS);
  poll.unref();

  void check();

  return {
    current: () => token,
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      for (const watcher of watchers) {
        watcher.close();
      }
    }
  };
}
