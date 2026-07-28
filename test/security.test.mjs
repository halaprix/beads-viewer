import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startServer } from "../server/server.mjs";
import {
  createBeadsWorkspace,
  fixtureEnv,
  hasBd,
  removeBeadsWorkspace
} from "./beads-fixture.mjs";

// `Host` is a forbidden header name in fetch, so fetch silently sends the real one and
// a rebinding test written with it passes while verifying nothing. Raw http.request is
// the only way to actually forge it.
function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: 7391, path, method: "GET", headers, setHost: false },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Every CVE this design was built against would have been caught by one of the tests
// below: MCP Inspector (9.4), Cline (9.6), OpenCode (8.8), Storybook, AutoGen Studio,
// webpack-dev-server, and the Vite fs.deny family. They are the point of the file.
let server;
let workspace;

test.before(async () => {
  if (!hasBd) return;
  workspace = await createBeadsWorkspace();
  // fixtureEnv() strips BEADS_DIR. Without it the server resolves whatever an exported
  // BEADS_DIR points at, so a suite that builds its own store would still read another
  // one - and would only fail on a machine that has the variable set.
  server = await startServer({ port: 7391, cwd: workspace, env: fixtureEnv() });
});

test.after(async () => {
  await server?.close();
  await removeBeadsWorkspace(workspace);
});

const base = "http://127.0.0.1:7391";
const auth = () => ({ Authorization: `Bearer ${server.token}` });
const integration = { skip: !hasBd };

test("a rebound Host is refused before routing", integration, async () => {
  // The DNS-rebinding case: the browser treats this as same-origin, so CORS cannot
  // help and the Host header is the only signal that distinguishes the attack.
  const response = await rawGet("/api/issues", { ...auth(), Host: "evil.example.com" });
  assert.equal(response.status, 403);
  assert.match(response.body, /disallowed Host/);

  // A missing Host is refused too, and the legitimate authorities still pass.
  assert.equal((await rawGet("/api/store", { ...auth(), Host: "127.0.0.1:7391" })).status, 200);
  assert.equal((await rawGet("/api/store", { ...auth(), Host: "localhost:7391" })).status, 200);
  assert.equal((await rawGet("/api/store", { ...auth(), Host: "127.0.0.1:7391.evil.com" })).status, 403);
});

test("a foreign Origin is refused", integration, async () => {
  const response = await fetch(`${base}/api/issues`, {
    headers: { ...auth(), Origin: "https://evil.example.com" }
  });
  assert.equal(response.status, 403);
});

test("no route is reachable without the token, including the event stream", integration, async () => {
  for (const path of ["/api/issues", "/api/store", "/api/events"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 403, `${path} was reachable unauthenticated`);
  }
});

test("an invalid token is refused", integration, async () => {
  const response = await fetch(`${base}/api/issues`, {
    headers: { Authorization: "Bearer not-the-token" }
  });
  assert.equal(response.status, 403);
});

test("no CORS header is ever emitted and preflight is refused", integration, async () => {
  const response = await fetch(`${base}/api/issues`, { method: "OPTIONS", headers: auth() });
  assert.equal(response.status, 403);
  for (const header of response.headers.keys()) {
    assert.doesNotMatch(header, /^access-control-/i);
  }
});

test("a mutation without exact application/json is refused", integration, async () => {
  // text/plain and form encodings are precisely what a cross-origin simple request can
  // send, so refusing them is what makes form CSRF structurally impossible.
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const response = await fetch(`${base}/api/issues`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": contentType },
      body: "title=pwned"
    });
    assert.equal(response.status, 403, `${contentType} was accepted`);
  }
});

test("mutating routes are unreachable by GET", integration, async () => {
  const response = await fetch(`${base}/api/issue`, { headers: auth() });
  assert.equal(response.status, 404);
});

test("static assets come from a manifest, so traversal cannot reach outside dist", integration, async () => {
  // Anything not in the manifest simply is not a static route, so it falls through to
  // the token check and is refused. What matters is only that it never returns content.
  for (const path of ["/../package.json", "/../../etc/passwd", "/app.js?raw", "/index.html%00.js"]) {
    const response = await fetch(`${base}${path}`);
    assert.notEqual(response.status, 200, `${path} returned content`);
    assert.doesNotMatch(await response.text(), /beads-viewer|root:/);
  }
});

test("a bead id that could become a flag is refused", integration, async () => {
  // Flag injection is the real risk: --db or -C in an id position would repoint the
  // store, so ids are pinned to a shape that cannot start with a dash.
  const response = await fetch(`${base}/api/dependency`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ dependent: "--db=/tmp/evil", blocker: "x-1" })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not a valid bead id/);
});

test("priorities outside the Beads range are refused before invoking bd", integration, async () => {
  for (const priority of [-1, 5, 1.5, "2"]) {
    const response = await fetch(`${base}/api/issues`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "invalid priority", priority })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /priority must be an integer from 0 to 4/);
  }
});

test("reads reach the isolated fixture store through bd", integration, async () => {
  const response = await fetch(`${base}/api/store`, { headers: auth() });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(typeof data.prefix, "string");
  assert.equal(typeof data.beadsDir, "string");
});

test("a store holding exactly one issue still returns a list", integration, async () => {
  // `bd show` returns an array of one, so the adapter collapses that shape - and a store
  // with exactly one issue makes `bd list` indistinguishable from it. A new repository
  // with a single bead therefore handed the UI an object instead of an array and the
  // graph rendered nothing. This is the count that used to break.
  const created = await fetch(`${base}/api/issues`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ title: "the only bead" })
  });
  assert.equal(created.status, 200);

  const listed = await fetch(`${base}/api/issues`, { headers: auth() });
  const { data } = await listed.json();
  assert.ok(Array.isArray(data.issues), "issues must always be an array");
  assert.equal(data.issues.length, 1);
  assert.equal(data.issues[0].title, "the only bead");
});
