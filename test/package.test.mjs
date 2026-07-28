import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBeadsWorkspace, fixtureEnv, hasBd, removeBeadsWorkspace } from "./beads-fixture.mjs";

// This is the manual verification that caught two real bugs (the address() crash and the
// single-issue collapse) turned into a test: `npm pack` the real tarball, `npm install`
// it into a project that has never seen this source tree, run the installed binary, and
// hit it exactly the way a user's browser would. Every other test imports the source
// directly, which is precisely what none of those bugs needed to reproduce.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const integration = { timeout: 60_000, skip: !hasBd };

let workspace;
let tarballPath;

test.before(async () => {
  if (!hasBd) return;
  workspace = await createBeadsWorkspace();
  // `npm pack` runs prepack (the real build) first, and vite's own progress lines land
  // on the same stdout as --json's result - including lines that themselves contain a
  // literal "[", such as its "(!) Some chunks..." warning, so a naive lastIndexOf("[")
  // picks up the wrong bracket. npm pretty-prints its JSON with the array's opening
  // bracket alone on its own line, which nothing else in vite's output does; find that
  // line specifically rather than guessing from bracket position.
  const packOutput = execFileSync("npm", ["pack", "--json"], { cwd: ROOT, encoding: "utf8" });
  const lines = packOutput.split("\n");
  const jsonStartLine = lines.findIndex((line) => line.trim() === "[");
  assert.ok(jsonStartLine !== -1, `no JSON array found in npm pack output:\n${packOutput}`);
  const [{ filename }] = JSON.parse(lines.slice(jsonStartLine).join("\n"));
  tarballPath = path.join(ROOT, filename);
  execFileSync("npm", ["init", "--yes"], { cwd: workspace, env: fixtureEnv(), stdio: "ignore" });
  execFileSync("npm", ["install", tarballPath, "--no-audit", "--no-fund"], {
    cwd: workspace,
    env: fixtureEnv(),
    stdio: "ignore"
  });
});

test.after(async () => {
  await removeBeadsWorkspace(workspace);
  if (tarballPath) {
    await execFileSync("rm", ["-f", tarballPath]);
  }
});

function launchInstalled(port) {
  const bin = path.join(workspace, "node_modules", ".bin", "beads-viewer");
  const child = spawn(bin, ["--no-open", "--port", String(port)], {
    cwd: workspace,
    env: fixtureEnv(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return {
    child,
    output: () => ({ stdout, stderr }),
    ready: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no URL within 15s: ${stderr || stdout}`)), 15_000);
        child.stdout.on("data", () => {
          const match = /http:\/\/127\.0\.0\.1:(\d+)\/#t=([A-Za-z0-9_-]+)/.exec(stdout);
          if (match) {
            clearTimeout(timer);
            resolve({ url: match[0], token: match[2] });
          }
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`exited ${code} before printing a URL: ${stderr}`));
        });
      })
  };
}

test(
  "the published tarball, installed fresh and run, serves the page and the store",
  integration,
  async () => {
    const instance = launchInstalled(7420);
    try {
      const { token } = await instance.ready();
      const auth = { Authorization: `Bearer ${token}` };

      // Every asset the manifest promises, served by the installed package rather than
      // by source files sitting next to the test.
      for (const [route, expectedType] of [
        ["/", "text/html"],
        ["/app.js", "text/javascript"],
        ["/elk.js", "text/javascript"],
        ["/app.css", "text/css"]
      ]) {
        const response = await fetch(`http://127.0.0.1:7420${route}`);
        assert.equal(response.status, 200, `${route} did not serve from the installed package`);
        assert.match(response.headers.get("content-type") ?? "", new RegExp(expectedType));
      }

      // The API layer, through the same installed binary - this is what caught the
      // single-issue collapse, which no import-level test could see.
      const issues = await (
        await fetch("http://127.0.0.1:7420/api/issues", { headers: auth })
      ).json();
      assert.ok(Array.isArray(issues.data.issues), "the installed package must serve a real store");
    } finally {
      instance.child.kill("SIGINT");
    }
  }
);

test("the tarball ships no runtime dependency and no dev-only source", integration, async () => {
  const pkg = JSON.parse(
    await readFile(path.join(workspace, "node_modules", "@halaprix", "beads-viewer", "package.json"), "utf8")
  );
  assert.deepEqual(pkg.dependencies ?? {}, {}, "the published package must have zero runtime dependencies");
  const installedFiles = await execFileSync(
    "find",
    [path.join(workspace, "node_modules", "@halaprix", "beads-viewer"), "-maxdepth", "1"],
    { encoding: "utf8" }
  );
  assert.doesNotMatch(installedFiles, /\/src\b/, "TypeScript source must not ship in the tarball");
  assert.doesNotMatch(installedFiles, /\/test\b/, "tests must not ship in the tarball");
});
