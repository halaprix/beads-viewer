import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startServer } from "../server/server.mjs";
import { createBeadsWorkspace, fixtureEnv, hasBd, removeBeadsWorkspace } from "./beads-fixture.mjs";

// The bug this exists for: the graph rendered into a canvas with zero height, because a
// grid item auto-placed into a row sized `auto`. The header still showed the right
// counts, so nothing short of looking at the page could have told the difference between
// "no data" and "the layout is broken" - which is exactly why every prior test missed it.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function hasChromium() {
  return spawnSync("node", ["-e", "require('playwright').chromium.executablePath()"], {
    cwd: ROOT
  }).status === 0;
}

const canRun = hasBd && hasChromium();
const integration = { timeout: 30_000, skip: !canRun };

let workspace;
let server;
let browser;

test.before(async () => {
  if (!canRun) return;
  // Rebuilt for the same reason as the asset-manifest test: a stale dist/ would let a
  // real regression through silently.
  execFileSync("npx", ["vite", "build"], { cwd: ROOT, stdio: "ignore" });
  workspace = await createBeadsWorkspace();

  // Seed a small, deterministic graph directly through bd rather than through the API
  // being smoke-tested, so a bug in the write path cannot mask a bug in the render path.
  const run = (args) => execFileSync("bd", args, { cwd: workspace, env: fixtureEnv(), encoding: "utf8" });
  const epic = JSON.parse(run(["create", "--json", "The epic", "-t", "epic"]));
  run(["create", "--json", "First task", "--parent", epic.id]);
  run(["create", "--json", "Second task", "--parent", epic.id]);

  server = await startServer({
    port: 7410,
    cwd: workspace,
    env: fixtureEnv(),
    distDir: path.join(ROOT, "dist")
  });
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  await server?.close();
  await removeBeadsWorkspace(workspace);
});

test("the real built page renders a non-empty, correctly sized graph with no errors", integration, async () => {
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(server.url);
  await page.getByRole("button", { name: "Everything" }).click();
  // Wait for the count in the header rather than a fixed delay: the header text only
  // updates once the initial fetch and the first layout pass have both completed.
  await page.getByText(/3 shown of 3/).waitFor({ timeout: 10_000 });

  // This is the exact assertion the zero-height bug would have failed: the canvas is
  // present in the DOM either way, so only its rendered size tells the two cases apart.
  const canvasBox = await page.locator(".canvas").boundingBox();
  assert.ok(canvasBox, "the canvas element must be present");
  assert.ok(canvasBox.height > 100, `canvas height was ${canvasBox?.height}, expected a real render`);
  assert.ok(canvasBox.width > 100, `canvas width was ${canvasBox?.width}, expected a real render`);

  const nodeCount = await page.locator(".node").count();
  assert.equal(nodeCount, 3, "one node per seeded issue");

  await page.screenshot({ path: path.join(ROOT, "test-results", "smoke.png") });

  assert.deepEqual(consoleErrors, [], "the page must render with no console errors");
  assert.deepEqual(failedRequests, [], "every request the page makes must succeed");

  await page.close();
});
