#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { canOpenBrowser, openBrowser } from "./browser.mjs";
import { startServer } from "./server.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const HELP = `beads-viewer ${version}

Interactive dependency graph editor for Beads issues.

Usage:
  beads-viewer [options]

Options:
  --port <number>  Port to bind (default: 7373)
  --strict-port    Fail instead of trying the next port
  --no-open        Print the URL without opening a browser
  --debug          Show a stack trace for startup errors
  -h, --help       Show this help
  -v, --version    Show the version
`;

async function main() {
  let options;
  try {
    ({ values: options } = parseArgs({
      args: process.argv.slice(2),
      options: {
        port: { type: "string", default: "7373" },
        "strict-port": { type: "boolean", default: false },
        "no-open": { type: "boolean", default: false },
        debug: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false }
      },
      strict: true,
      allowPositionals: false
    }));
  } catch (error) {
    process.stderr.write(`beads-viewer: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("Run `beads-viewer --help` for usage.\n");
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write(`beads-viewer: --port must be an integer from 1 to 65535, got ${options.port}\n`);
    process.exitCode = 1;
    return;
  }

  // A memorable default rather than an ephemeral scan: developers reload from history.
  // On collision we increment and say so, which is Vite's behaviour; --strict-port is
  // for CI. There is no interactive prompt - Storybook removed theirs because it blocks CI.
  const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

  async function listen(candidate, attempt = 0) {
    try {
      return await startServer({ port: candidate, cwd: process.cwd(), distDir });
    } catch (error) {
      if (
        error.code === "EADDRINUSE" &&
        !options["strict-port"] &&
        attempt < 10 &&
        candidate < 65_535
      ) {
        process.stderr.write(`port ${candidate} is in use, trying ${candidate + 1}\n`);
        return listen(candidate + 1, attempt + 1);
      }
      throw error;
    }
  }

  // A missing store is the most likely first-run outcome, so it gets a sentence rather
  // than a stack trace. The stack is still available behind --debug for a real crash.
  let server;
  try {
    server = await listen(port);
  } catch (error) {
    if (options.debug) {
      throw error;
    }
    process.stderr.write(`\nbeads-viewer: ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exitCode = 1;
    return;
  }

  // Report what was actually bound, derived from the socket - Prisma Studio printed
  // "localhost" while binding 0.0.0.0, which is how that bug survived so long.
  const bound = server.address;
  if (process.stdout.isTTY) {
    process.stdout.write(`\n  beads-viewer  ${server.store.prefix}\n`);
    process.stdout.write(`  store         ${server.store.beadsDir}\n`);
    process.stdout.write(`  bound         ${bound.address}:${bound.port}\n\n`);
    process.stdout.write(`  Local:        ${server.url}\n\n`);
  } else {
    process.stdout.write(`${server.url}\n`);
  }

  if (canOpenBrowser({ noOpen: options["no-open"] })) {
    try {
      openBrowser(server.url, {
        onError(error) {
          process.stderr.write(`beads-viewer: could not open a browser: ${error.message}\n`);
        }
      });
    } catch (error) {
      process.stderr.write(
        `beads-viewer: could not open a browser: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
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
}

await main();
