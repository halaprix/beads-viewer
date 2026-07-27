import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const hasBd = spawnSync("bd", ["version"], { stdio: "ignore" }).status === 0;

function cleanEnv() {
  const env = { ...process.env };
  delete env.BEADS_DIR;
  return env;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || `exit ${result.status}`}`
    );
  }
}

export async function createBeadsWorkspace() {
  const cwd = await mkdtemp(path.join(tmpdir(), "beads-viewer-test-"));
  try {
    run("git", ["init", "--quiet"], cwd);
    run(
      "bd",
      [
        "init",
        "--quiet",
        "--non-interactive",
        "--skip-agents",
        "--skip-hooks",
        "--prefix",
        "viewer-test"
      ],
      cwd
    );
    return cwd;
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

export async function removeBeadsWorkspace(cwd) {
  if (cwd) {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function fixtureEnv(extra = {}) {
  return { ...cleanEnv(), ...extra };
}
