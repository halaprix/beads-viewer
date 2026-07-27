import { spawn } from "node:child_process";

// Every `bd` invocation costs ~130-190ms of process start plus opening the embedded
// Dolt engine, cold or warm. That floor is why reads hydrate a cache once instead of
// being fetched per request, and why nothing ever polls the CLI.
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Subcommands are chosen from this map, never assembled from request input. Anything
// beginning with "-" that is not listed here is refused: `--db` and `-C` would
// silently repoint the store, which is flag injection with the whole database as the
// blast radius.
const READ_COMMANDS = new Set(["list", "show", "export", "children", "dep", "ready", "blocked", "count", "where", "version"]);
// `dep` appears in both sets on purpose: `dep tree`/`dep list` read, `dep add`/`dep
// remove` write. The subcommand is validated by the caller.
const WRITE_COMMANDS = new Set(["create", "update", "close", "comment", "label", "defer", "undefer", "priority", "dep"]);

export class BdError extends Error {
  constructor(message, { code, stderr, stdout }) {
    super(message);
    this.name = "BdError";
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

function run(argv, { beadsDir, bin = "bd", cwd = process.cwd() }) {
  return new Promise((resolve, reject) => {
    // shell: false is the default and must stay that way. Node's own docs say never
    // to pass unsanitized input to a shell, and `shell: true` with an args array is
    // deprecated precisely because the arguments are concatenated, not escaped.
    const child = spawn(bin, argv, {
      shell: false,
      windowsHide: true,
      // Passed explicitly: bd discovers the store by walking up from its working
      // directory, so dropping this would resolve a different project's issues.
      cwd,
      timeout: TIMEOUT_MS,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Always explicit: an inherited BEADS_DIR wins over repository discovery and
        // would route every read and write into a different project's store.
        BEADS_DIR: beadsDir
      }
    });
    let stdout = "";
    let stderr = "";
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BUFFER) {
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(new BdError(error.message, { code: 1, stderr, stdout })));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// bd's response shapes are not uniform: `create` returns a bare object, `update`
// returns an array of one, `orphans` returns bare null. Errors are worse - a --claim
// conflict, a supersede failure, and every --readonly refusal print plain text on
// stderr even with --json. So the exit code is the only reliable signal, and JSON is
// attempted only after it says success.
// bd sometimes reports a failure as JSON on stderr ({"error":"...","schema_version":1})
// and sometimes as bare prose. Unwrap the JSON so the UI shows the sentence rather than
// a blob, but keep the raw text when it is not JSON.
function failureMessage(result, argv) {
  const detail = (result.stderr || result.stdout).trim();
  if (!detail) {
    return `bd ${argv[0]} exited ${result.code}`;
  }
  try {
    const parsed = JSON.parse(detail);
    if (parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Not JSON, which is the common case for --claim and --readonly refusals.
  }
  return detail;
}

function parse(result, argv) {
  if (result.code !== 0) {
    throw new BdError(failureMessage(result, argv), result);
  }
  const text = result.stdout.trim();
  if (!text) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BdError(`bd ${argv[0]} returned unparseable output`, result);
  }
  // Collapse array-of-one to the object, and null to nothing, so callers see one shape.
  return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
}

function assertArgs(args) {
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error("bd arguments must be strings");
    }
    // NUL, CR and LF are rejected because they are how a second argument gets smuggled
    // into an argv. Written as includes() rather than a regex so no lint rule has to be
    // suppressed to express it.
    if (arg.includes("\u0000") || arg.includes("\r") || arg.includes("\n")) {
      throw new Error("bd arguments must not contain NUL or newlines");
    }
  }
}

export function createBd({ beadsDir, bin = "bd", cwd = process.cwd() }) {
  // Serialized deliberately, not for safety alone: bd opens the database in-process,
  // so concurrent writes contend on its lock, and the cost is startup rather than
  // overlappable I/O. Parallelism buys nothing here and loses lock errors.
  let tail = Promise.resolve();
  const enqueue = (fn) => {
    const next = tail.then(fn, fn);
    tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  async function read(command, args = []) {
    if (!READ_COMMANDS.has(command)) {
      throw new Error(`refusing unknown read command: ${command}`);
    }
    assertArgs(args);
    // --readonly is free privilege separation: it genuinely refuses every mutation.
    const argv = ["--readonly", "--json", command, ...args];
    return parse(await run(argv, { beadsDir, bin, cwd }), argv);
  }

  async function write(command, args = []) {
    if (!WRITE_COMMANDS.has(command)) {
      throw new Error(`refusing unknown write command: ${command}`);
    }
    assertArgs(args);
    const argv = ["--json", command, ...args];
    return enqueue(async () => parse(await run(argv, { beadsDir, bin, cwd }), argv));
  }

  return {
    read,
    write,

    // The widest single read: carries parent, labels and dependencies together, and
    // costs 437ms even at 2000 issues, so one call hydrates the whole cache.
    listAll: () => read("list", ["--all", "--limit", "0"]),

    // Comment bodies exist only in the export, and the export has no `parent` field,
    // so neither call alone is sufficient. This one is a secondary hydrate, never the
    // hot path - it is the slowest bulk read. Never pass `-o -`: bd writes a file
    // literally named "-" rather than using stdout.
    async exportRecords() {
      const argv = ["--readonly", "export"];
      const result = await run(argv, { beadsDir, bin, cwd });
      if (result.code !== 0) {
        throw new BdError(failureMessage(result, argv), result);
      }
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
  };
}

// Resolves the store from bd itself rather than assuming `.beads/`. An exported
// BEADS_DIR silently overrides repository discovery, so guessing the path is how you
// end up reading a different project's issues and believing it is yours.
export async function resolveStore({ cwd = process.cwd(), bin = "bd" } = {}) {
  const argv = ["--readonly", "--json", "where"];
  const result = await run(argv, { beadsDir: process.env.BEADS_DIR ?? "", bin, cwd });
  if (result.code !== 0) {
    throw new BdError(
      `bd could not resolve a Beads store from ${cwd}. Run \`bd init --quiet\` first.`,
      result
    );
  }
  const where = JSON.parse(result.stdout);
  if (where.schema_version !== 1) {
    throw new BdError(
      `unsupported Beads schema_version ${where.schema_version}; refusing to run`,
      result
    );
  }
  return { beadsDir: where.path, databasePath: where.database_path, prefix: where.prefix };
}
