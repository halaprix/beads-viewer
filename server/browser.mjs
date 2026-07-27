import { spawn } from "node:child_process";

export function canOpenBrowser({
  noOpen = false,
  env = process.env,
  platform = process.platform
} = {}) {
  if (noOpen || env.BROWSER === "none") {
    return false;
  }
  if (env.SSH_TTY || env.SSH_CONNECTION) {
    return false;
  }
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return false;
  }
  return true;
}

export function browserCommand(url, platform = process.platform) {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "explorer.exe", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

// Use a detached process so the viewer neither waits for the browser nor keeps it
// alive. The URL is generated locally and passed as one argv value, never through a
// shell.
export function openBrowser(
  url,
  { platform = process.platform, spawnImpl = spawn, onError = () => {} } = {}
) {
  const { command, args } = browserCommand(url, platform);
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.once("error", onError);
  child.unref();
}
