import { randomBytes, timingSafeEqual } from "node:crypto";

// The pattern in every comparable CVE - MCP Inspector 9.4, Cline 9.6, OpenCode 8.8,
// Storybook, webpack-dev-server - is never "a port was open". It is no token, plus no
// Host/Origin check, plus an endpoint that spawns something. This tool has all three
// ingredients, so all three defences are here and none of them is optional.

export function createToken() {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

// Exact matches only. No suffix matching, no wildcards, no "contains localhost" -
// each of those is a bypass. Covers both stacks because `localhost` resolves to either.
function allowedAuthorities(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

// A DNS-rebound request is same-origin as far as the browser is concerned: the same
// origin policy compares scheme, host and port, never the resolved IP. So CORS cannot
// help and the Host header is the only thing that distinguishes the attack.
export function checkHost(req, port) {
  const authority = req.headers[":authority"] ?? req.headers.host;
  if (!authority || Array.isArray(authority)) {
    return "missing or duplicated Host";
  }
  return allowedAuthorities(port).has(authority) ? null : `disallowed Host: ${authority}`;
}

// Origin is checked when present, but it is explicitly not load-bearing: a locally
// running AI browser agent inherits the localhost origin and defeats this entirely.
// The token is what holds.
export function checkOrigin(req, port) {
  const origin = req.headers.origin;
  if (!origin) {
    return null;
  }
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  return allowed.includes(origin) ? null : `disallowed Origin: ${origin}`;
}

export function checkToken(req, token) {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) {
    return "missing Authorization";
  }
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || !value) {
    return "malformed Authorization";
  }
  // No ?token= query fallback: that would put the secret in access logs and history.
  return safeEqual(value, token) ? null : "invalid token";
}

// Requiring exactly application/json is the load-bearing anti-CSRF control. A simple
// cross-origin request may only send form-urlencoded, multipart or text/plain, and it
// cannot set a custom header without a preflight that is never granted - so requiring
// both a JSON content type and a bearer header makes form and simple-request CSRF
// structurally impossible. No cookies exist, so SameSite never enters into it.
export function checkMutationShape(req) {
  if (!["POST", "PATCH", "DELETE"].includes(req.method)) {
    return `mutations may not use ${req.method}`;
  }
  const type = req.headers["content-type"];
  if (!type || type.split(";")[0].trim().toLowerCase() !== "application/json") {
    return `mutations require Content-Type: application/json, got ${type ?? "none"}`;
  }
  return null;
}

export const SECURITY_HEADERS = {
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store"
};

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");
