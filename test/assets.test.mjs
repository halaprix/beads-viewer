import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATIC_FILES } from "../server/server.mjs";

// The bug this exists to prevent: chunkFileNames in vite.config.ts was changed, the
// manifest in server.mjs was not, and the build silently emitted a file the server never
// registered - a 404 at runtime that every other test missed, because none of them
// compared the two lists against each other. Needs no `bd` and no browser, so it always
// runs.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test.before(() => {
  // Rebuilt unconditionally rather than trusting a leftover dist/ from a previous run or
  // a different branch - the whole point is to catch a build/manifest mismatch, which a
  // stale dist/ would hide.
  execFileSync("npx", ["vite", "build"], { cwd: ROOT, stdio: "ignore" });
});

test("every file the build emits is reachable through the static manifest, and vice versa", async () => {
  const built = (await readdir(path.join(ROOT, "dist")))
    .filter((name) => !name.startsWith("."))
    .sort();
  const registered = [...new Set([...STATIC_FILES.values()].map((entry) => entry.file))].sort();

  assert.deepEqual(
    registered,
    built,
    "the static manifest and the build output must name exactly the same files"
  );
});

test("the manifest declares no path outside dist and no duplicate destination for one URL", () => {
  const paths = [...STATIC_FILES.keys()];
  assert.equal(new Set(paths).size, paths.length, "no URL is registered twice");
  for (const [url, entry] of STATIC_FILES) {
    assert.doesNotMatch(entry.file, /\.\./, `${url} must not escape dist via a relative path`);
    assert.doesNotMatch(entry.file, /^\//, `${url} must be relative to dist, not absolute`);
  }
});
