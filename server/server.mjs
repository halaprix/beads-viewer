import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createBd, resolveStore, BdError } from "./bd.mjs";
import { watchStore } from "./watch.mjs";
import {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  checkHost,
  checkMutationShape,
  checkOrigin,
  checkToken,
  createToken
} from "./security.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

// A hardcoded manifest, never "any path minus a denylist". Seven separate Vite CVEs
// exist because denylists lose: ?raw??, ?import, .svg, invalid request targets,
// symlinks, and an html fallback that skipped the check entirely.
const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  // The lazily-imported layout engine. Named deterministically in vite.config.ts so
  // this manifest can stay a literal.
  ["/elk.js", { file: "elk.js", type: "text/javascript; charset=utf-8" }],
  ["/app.css", { file: "app.css", type: "text/css; charset=utf-8" }]
]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8" });
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireString(body, field, { max = 4000 } = {}) {
  const value = body?.[field];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${field} must be a string of 1-${max} characters`);
  }
  return value;
}

// Beads ids are the only thing ever interpolated into an argv, so they are pinned to a
// shape that cannot begin with "-" and therefore cannot become a flag.
function requireId(body, field = "id") {
  const value = requireString(body, field, { max: 200 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${field} is not a valid bead id`);
  }
  return value;
}

export async function startServer({ port = 7373, host = "127.0.0.1", cwd = process.cwd(), distDir } = {}) {
  const store = await resolveStore({ cwd });
  const bd = createBd({ beadsDir: store.beadsDir });
  const token = createToken();
  const clients = new Set();

  const watcher = watchStore({
    databasePath: store.databasePath,
    onChange(version) {
      for (const client of clients) {
        // The version goes out as the SSE id, so a reconnect's Last-Event-ID lets us
        // detect "changed while you were disconnected" for free.
        client.write(`id: ${version}\nevent: store-changed\ndata: {}\n\n`);
      }
    }
  });

  const routes = {
    "GET /api/store": async () => ({ ...store, version: watcher.current() }),
    "GET /api/issues": async () => ({ version: watcher.current(), issues: (await bd.listAll()) ?? [] }),

    "POST /api/issues": async (body) => {
      const args = [requireString(body, "title", { max: 500 })];
      if (body.description) args.push("-d", requireString(body, "description", { max: 20000 }));
      if (body.type) args.push("-t", requireString(body, "type", { max: 40 }));
      if (body.priority !== undefined) args.push("-p", String(Number(body.priority)));
      if (body.parent) args.push("--parent", requireId(body, "parent"));
      return bd.write("create", args);
    },

    // One field per request, because bd has no optimistic concurrency - no ETag, no
    // version column, no --if-match. A whole-record save would silently clobber a
    // concurrent `bd` edit from a terminal, so it is not offered at all.
    "PATCH /api/issue": async (body) => {
      const id = requireId(body);
      const field = requireString(body, "field", { max: 40 });
      const flags = {
        title: "--title",
        description: "-d",
        design: "--design",
        acceptance: "--acceptance",
        status: "-s",
        priority: "-p"
      };
      if (!Object.hasOwn(flags, field)) {
        throw new Error(`field ${field} is not editable`);
      }
      const value = field === "priority" ? String(Number(body.value)) : requireString(body, "value", { max: 20000 });
      return bd.write("update", [id, flags[field], value]);
    },

    // bd rejects cycles itself, so the graph gets correctness for free and the refusal
    // is passed through verbatim rather than being re-guessed here.
    "POST /api/dependency": async (body) => {
      const dependent = requireId(body, "dependent");
      const blocker = requireId(body, "blocker");
      const type = body.type ? requireString(body, "type", { max: 40 }) : "blocks";
      // Argument order is the trap: `bd dep add <dependent> <blocker>` reads as
      // "dependent depends on blocker", and the `bd dep <blocker> --blocks <dependent>`
      // alias reverses it. Only this spelling is used.
      return bd.write("dep", ["add", dependent, blocker, "-t", type]);
    },

    "DELETE /api/dependency": async (body) =>
      bd.write("dep", ["remove", requireId(body, "dependent"), requireId(body, "blocker")])
  };

  const server = createServer(async (req, res) => {
    // Order matters: Host before anything else, because a rebound request is
    // same-origin to the browser and no later check would notice.
    const hostProblem = checkHost(req, port);
    if (hostProblem) {
      return send(res, 403, hostProblem);
    }
    const originProblem = checkOrigin(req, port);
    if (originProblem) {
      return send(res, 403, originProblem);
    }
    // No Access-Control-Allow-* header is ever emitted, so a preflight is simply refused.
    if (req.method === "OPTIONS") {
      return send(res, 403, "forbidden");
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    const asset = req.method === "GET" ? STATIC_FILES.get(url.pathname) : undefined;
    if (asset) {
      if (!distDir) {
        return send(res, 503, "no built assets; run `npm run build`");
      }
      const body = await readFile(path.join(distDir, asset.file)).catch(() => null);
      return body
        ? send(res, 200, body, { "Content-Type": asset.type, "Content-Security-Policy": CONTENT_SECURITY_POLICY })
        : send(res, 404, "not found");
    }

    // Every non-static route requires the token, with no exemptions. AutoGen Studio's
    // RCE was exactly one exempted route prefix.
    const tokenProblem = checkToken(req, token);
    if (tokenProblem) {
      return send(res, 403, tokenProblem);
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/event-stream",
        // Never compressed: gzip buffers the stream and events never flush.
        "Content-Encoding": "identity",
        Connection: "keep-alive"
      });
      res.write("retry: 500\n\n");
      const lastSeen = req.headers["last-event-id"];
      if (lastSeen && lastSeen !== watcher.current()) {
        res.write(`id: ${watcher.current()}\nevent: store-changed\ndata: {}\n\n`);
      }
      const keepalive = setInterval(() => res.write(": ping\n\n"), 20_000);
      clients.add(res);
      req.on("close", () => {
        clearInterval(keepalive);
        clients.delete(res);
      });
      return undefined;
    }

    const key = `${req.method} ${url.pathname}`;
    const handler = Object.hasOwn(routes, key) ? routes[key] : null;
    if (!handler) {
      return sendJson(res, 404, { error: `no route for ${key}` });
    }

    if (req.method !== "GET") {
      const shapeProblem = checkMutationShape(req);
      if (shapeProblem) {
        return sendJson(res, 403, { error: shapeProblem });
      }
    }

    try {
      const body = req.method === "GET" ? {} : await readBody(req);
      return sendJson(res, 200, { ok: true, data: (await handler(body)) ?? null });
    } catch (error) {
      // A BdError carries bd's own words, which are often the most useful thing we can
      // show - "adding dependency would create a cycle" needs no translation.
      const status = error instanceof BdError ? 409 : 400;
      return sendJson(res, status, { ok: false, error: error.message });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));

  return {
    store,
    // The token travels in the URL fragment: fragments are never sent to a server,
    // never land in a Referer, and never reach an access log.
    url: `http://${host === "127.0.0.1" ? "127.0.0.1" : host}:${port}/#t=${token}`,
    token,
    address: server.address(),
    async close() {
      watcher.close();
      for (const client of clients) {
        client.end();
      }
      await new Promise((resolve) => server.close(resolve));
      // An open SSE response counts as an active request, so close() alone would hang.
      server.closeAllConnections();
    }
  };
}
