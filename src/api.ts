import type { Issue } from "./graph/model.ts";

// The token arrives in the URL fragment, which is never sent to a server, never lands
// in a Referer and never reaches an access log. Read it once, scrub it from the address
// bar, keep it in memory.
function claimToken() {
  const match = /(?:^|[#&])t=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (match?.[1]) {
    const token = match[1];
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return token;
  }
  return null;
}

const token = claimToken();

export class ApiError extends Error {}

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token ?? ""}`,
      // Exactly application/json on mutations: a cross-origin simple request cannot set
      // it, which is what makes form CSRF structurally impossible.
      ...(init.body ? { "Content-Type": "application/json" } : {})
    }
  });
  const text = await response.text();
  let payload: { ok?: boolean; data?: unknown; error?: string } = {};
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ApiError(text || `${response.status}`);
  }
  if (!response.ok || payload.ok === false) {
    // bd's own words are usually the best message available - "adding dependency would
    // create a cycle" needs no translation.
    throw new ApiError(payload.error ?? `${response.status}`);
  }
  return payload.data;
}

export const api = {
  hasToken: () => Boolean(token),
  store: () => call("/api/store") as Promise<{ prefix: string; beadsDir: string; version: string }>,
  issues: () => call("/api/issues") as Promise<{ version: string; issues: Issue[] }>,

  createIssue: (body: { title: string; parent?: string; type?: string; priority?: number }) =>
    call("/api/issues", { method: "POST", body: JSON.stringify(body) }),

  // One field per request. bd has no ETag or --if-match, so a whole-record save would
  // silently clobber a concurrent edit made in a terminal.
  updateField: (id: string, field: string, value: string | number) =>
    call("/api/issue", { method: "PATCH", body: JSON.stringify({ id, field, value }) }),

  addDependency: (dependent: string, blocker: string, type = "blocks") =>
    call("/api/dependency", { method: "POST", body: JSON.stringify({ dependent, blocker, type }) }),

  removeDependency: (dependent: string, blocker: string) =>
    call("/api/dependency", { method: "DELETE", body: JSON.stringify({ dependent, blocker }) })
};

/**
 * The store changes underneath us whenever a human or an agent runs `bd`. SSE rather
 * than a WebSocket: no client-to-server frames are needed, reconnection is native, and
 * Node ships no WebSocket server. A watchdog is required because EventSource does not
 * fire `error` on a half-open connection - a laptop waking up would otherwise sit
 * silently stale forever.
 */
export function subscribe(onChange: () => void) {
  // Deliberately NOT EventSource. EventSource cannot set an Authorization header, so
  // using it would force the token into a query string - into access logs and anything
  // that records URLs - which is exactly what putting it in the fragment avoided. A
  // streamed fetch keeps the header, at the cost of writing reconnect by hand.
  const controller = new AbortController();
  let stopped = false;
  let lastEventId: string | null = null;

  const parseFrames = (chunk: string) => {
    for (const frame of chunk.split("\n\n")) {
      if (!frame.trim() || frame.startsWith(":")) continue;
      const lines = frame.split("\n");
      const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      if (id) lastEventId = id;
      if (event === "store-changed") onChange();
    }
  };

  const connect = async () => {
    while (!stopped) {
      try {
        const response = await fetch("/api/events", {
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token ?? ""}`,
            // Sent by hand, since nothing native is tracking it for us. The server
            // compares it to the current version and pushes immediately if it moved,
            // which closes the changed-while-disconnected gap.
            ...(lastEventId ? { "Last-Event-ID": lastEventId } : {})
          }
        });
        if (!response.body) throw new Error("no stream");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          // Keep the trailing partial frame for the next chunk.
          const boundary = buffer.lastIndexOf("\n\n");
          if (boundary !== -1) {
            parseFrames(buffer.slice(0, boundary + 2));
            buffer = buffer.slice(boundary + 2);
          }
        }
      } catch {
        // Fall through to the delay and retry; an aborted controller exits the loop.
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  void connect();
  return () => {
    stopped = true;
    controller.abort();
  };
}
