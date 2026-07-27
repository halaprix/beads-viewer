import test from "node:test";
import assert from "node:assert/strict";
import {
  browserCommand,
  canOpenBrowser,
  openBrowser
} from "../server/browser.mjs";

test("browser opening is disabled for explicit opt-out, SSH, and headless Linux", () => {
  assert.equal(canOpenBrowser({ noOpen: true, env: {}, platform: "darwin" }), false);
  assert.equal(canOpenBrowser({ env: { BROWSER: "none" }, platform: "darwin" }), false);
  assert.equal(canOpenBrowser({ env: { SSH_CONNECTION: "host" }, platform: "darwin" }), false);
  assert.equal(canOpenBrowser({ env: {}, platform: "linux" }), false);
  assert.equal(canOpenBrowser({ env: { DISPLAY: ":0" }, platform: "linux" }), true);
});

test("browser commands pass the URL as one argument without a shell", () => {
  const url = "http://127.0.0.1:7373/#t=secret";
  assert.deepEqual(browserCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserCommand(url, "win32"), { command: "explorer.exe", args: [url] });
  assert.deepEqual(browserCommand(url, "linux"), { command: "xdg-open", args: [url] });

  let invocation;
  let unrefCalled = false;
  openBrowser(url, {
    platform: "linux",
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return {
        once() {},
        unref() {
          unrefCalled = true;
        }
      };
    }
  });

  assert.deepEqual(invocation, {
    command: "xdg-open",
    args: [url],
    options: { detached: true, stdio: "ignore", windowsHide: true }
  });
  assert.equal(unrefCalled, true);
});
