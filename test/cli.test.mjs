import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This file exists because the CLI shipped a crash that every other test missed:
// startServer returns `address` as a value and cli.mjs called it as a function. Nothing
// launched the binary, so nothing noticed. Import-level tests cannot cover a process.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "cli.mjs");

function launch(args = []) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return {
    child,
    output: () => ({ stdout, stderr }),
    // Resolves once the URL is printed, or rejects with whatever the process said on the
    // way out - a crash must surface as the failure message, not as a timeout.
    ready: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no URL within 15s: ${stderr || stdout}`)), 15_000);
        child.stdout.on("data", () => {
          const match = /http:\/\/127\.0\.0\.1:(\d+)\/#t=([A-Za-z0-9_-]+)/.exec(stdout);
          if (match) {
            clearTimeout(timer);
            resolve({ url: match[0], port: Number(match[1]), token: match[2] });
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`exited ${code} before printing a URL: ${stderr}`));
        });
      })
  };
}

test("the CLI starts, prints a tokenised URL, and serves the store behind it", { timeout: 30_000 }, async () => {
  const instance = launch(["--port", "7396", "--no-open"]);
  try {
    const { port, token } = await instance.ready();
    assert.equal(port, 7396);

    // The token in the fragment is the real credential, so it must actually work.
    const authorized = await fetch(`http://127.0.0.1:${port}/api/store`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(authorized.status, 200);

    // And the same route must be closed without it.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/store`)).status, 403);

    // Whatever it claims to have bound must be loopback. Printing one address while
    // binding another is how Prisma Studio exposed itself on 0.0.0.0.
    const { stdout } = instance.output();
    if (stdout.includes("bound")) {
      assert.match(stdout, /bound\s+127\.0\.0\.1:7396/);
    }
  } finally {
    instance.child.kill("SIGINT");
  }
});

test("a second instance steps to the next port instead of dying", { timeout: 30_000 }, async () => {
  const first = launch(["--port", "7394", "--no-open"]);
  try {
    await first.ready();
    const second = launch(["--port", "7394", "--no-open"]);
    try {
      const { port } = await second.ready();
      assert.equal(port, 7395, "expected the collision to step to the next port");
      assert.match(second.output().stderr, /in use/);
    } finally {
      second.child.kill("SIGINT");
    }
  } finally {
    first.child.kill("SIGINT");
  }
});

test("SIGINT shuts down rather than hanging on an open stream", { timeout: 30_000 }, async () => {
  const instance = launch(["--port", "7393", "--no-open"]);
  const { port, token } = await instance.ready();

  // Hold the event stream open. An SSE response counts as an active request, so a
  // server that only called close() would wait for it forever.
  const controller = new AbortController();
  void fetch(`http://127.0.0.1:${port}/api/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal
  }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));

  const exited = new Promise((resolve) => instance.child.on("exit", resolve));
  instance.child.kill("SIGINT");
  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))
  ]);
  controller.abort();
  assert.notEqual(code, "timeout", "the process did not exit while a stream was open");
});
