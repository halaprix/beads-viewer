#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

// A memorable default rather than an ephemeral scan: developers reload from history.
// On collision we increment and say so, which is Vite's behaviour; --strict-port is
// for CI. There is no interactive prompt - Storybook removed theirs because it blocks CI.
const DEFAULT_PORT = 7373;
const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

async function listen(port, attempt = 0) {
  try {
    return await startServer({ port, cwd: process.cwd(), distDir });
  } catch (error) {
    if (error.code === "EADDRINUSE" && !flag("strict-port") && attempt < 10) {
      process.stderr.write(`port ${port} is in use, trying ${port + 1}\n`);
      return listen(port + 1, attempt + 1);
    }
    throw error;
  }
}

// Never open a browser where there cannot be one: no DISPLAY on Linux/BSD, or an SSH
// session. Streamlit's heuristic, and it is the difference between a hang and a URL.
function canOpenBrowser() {
  if (flag("no-open") || process.env.BROWSER === "none") {
    return false;
  }
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return false;
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false;
  }
  return true;
}

const server = await listen(Number(value("port", DEFAULT_PORT)));

// Report what was actually bound, derived from the socket - Prisma Studio printed
// "localhost" while binding 0.0.0.0, which is how that bug survived so long.
const bound = server.address();
if (process.stdout.isTTY) {
  process.stdout.write(`\n  beads-viewer  ${server.store.prefix}\n`);
  process.stdout.write(`  store         ${server.store.beadsDir}\n`);
  process.stdout.write(`  bound         ${bound.address}:${bound.port}\n\n`);
  process.stdout.write(`  Local:        ${server.url}\n\n`);
} else {
  process.stdout.write(`${server.url}\n`);
}

if (canOpenBrowser()) {
  process.stderr.write("  (pass --no-open to skip opening a browser)\n");
}

// Two-stage interrupt: the first asks politely, the second stops waiting. An open SSE
// response is an active request, so a single close() would appear to hang forever.
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (closing) {
      process.stderr.write("\nforce-closing\n");
      process.exit(0);
    }
    closing = true;
    process.stderr.write("\nshutting down, press again to force\n");
    server.close().then(() => process.exit(0));
  });
}
