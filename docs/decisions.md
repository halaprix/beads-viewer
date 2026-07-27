# Decisions

Each of these was settled by probing `bd` directly or by looking at what comparable tools actually ship. Where a claim came from measurement, the number is here; where it did not, it says so.

## The data layer is the CLI, because nothing else exists

Probed against `bd 1.1.0` with an embedded-Dolt store:

- `bd sql` → `"not yet supported in embedded mode"`.
- No SQL server, no port, no socket. The `dolt-server.*` and `bd.sock` names in `.beads/.gitignore` are written defensively by `bd init`; **the files do not exist**.
- `bd daemon` / `bd serve` do not exist. `--proxied-server` reports `"not yet implemented"`.

So: shell out to `bd`, or nothing.

### The number that shapes everything: ~130–190ms per invocation

A fixed floor, cold or warm, for process start plus opening the embedded engine. `bd count` on a 2000-issue store still costs 191ms. Measured, 5 runs each, on a 29-issue store: `export` 328ms, `list --all --limit 0 --json` 234ms, `show` 216ms, `ready` 158ms. At 2000 issues: `export` 1025ms, `list` 437ms.

Consequences, none of them optional:

- **Hydrate once into memory**, from `bd list --all --limit 0 --json` — it carries `parent`, `labels`, and `dependencies` in one call.
- **Never poll `bd`.** At 1Hz a `bd count` costs ~13% of a core forever.
- **Every mutation is optimistic.** 200–400ms is tolerable for a user-initiated write only if the UI does not wait for it.
- Comments need a second call: `bd export` is the only source of comment bodies, and no single command returns both comments and `parent`.

### Reads are `--readonly`, which is free privilege separation

Every read command works under `--readonly`, and it genuinely refuses writes. Note it is not filesystem-read-only: even `--readonly` reads touch `.beads/last-touched`.

### Writes are field-level, because there is no optimistic concurrency

No ETag, no version column, no `--if-match`. Two `bd update --description` calls are last-write-wins with silent loss, and a human in a terminal is a real concurrent writer here. Therefore: **write only the field the user touched**, and re-read before rendering an edit form. A full-record save form is not implementable safely and will not be built.

`--claim` is the one atomic operation — four simultaneous claims produced exactly one winner.

### Never trust the exit shape

- Success envelopes are inconsistent: `create` returns a bare object, `update` returns an array of one, `orphans` returns bare `null`.
- **Errors are not always JSON.** `--claim` conflicts, `supersede`, and every `--readonly` refusal print plain text on stderr *even with `--json`*.

So every call is wrapped in an adapter that branches on exit code first and treats stderr as authoritative.

### Dependency direction

The `dependencies` array lives on the **dependent** record: `issue_id` is the dependent/child, `depends_on_id` is the blocker/parent. The blocker's own record carries nothing, so reverse edges must be built by inverting the whole set. Verified by constructing a known relationship and exporting it.

`bd` rejects cycles itself (`{"error":"adding dependency would create a cycle"}`), so drag-to-connect gets correctness for free. One edge per ordered pair regardless of type — re-typing an edge is remove-then-add.

### Change detection: watch a file, verify with a token

The signal that survived probing is the size of the Dolt noms journal (`journal.idx`), which was byte-stable across 9 reads and grew on every write. Rejected alternatives:

- `interactions.jsonl` — logs **status transitions only**. It grew 2 lines across ~15 writes.
- `last-touched` — bumped by reads too, including `--readonly` reads.
- mtime on the store — bumped by reads.
- `--watch` — an ANSI terminal redraw, not a stream.

Design: `fs.watch` non-recursive on the store directory → 120ms debounce → compare a `stat()`-derived token → broadcast only if it moved, plus a slow poll as a missed-event net (Node documents that events can be missed). The watcher is a hint; the token is the truth.

**Resolve the store path at startup** via `bd where`, and assert the prefix. Never hardcode `.beads/`: an exported `BEADS_DIR` silently wins over repository discovery, and a research pass on this very project misread which store was live because of it.

## Do not draw the whole graph

The strongest finding in the survey, and it is nearly unanimous:

- **Backstage** catalog-graph: dagre plus hand-rolled SVG, no clustering of any kind, unusable around 200 nodes. Its zoom is capped at `scaleExtent([1, Infinity])` — you cannot zoom out.
- **Obsidian** global graph: force-directed, so position carries no meaning and layout is not reproducible between runs. Widely described by its own users as decorative.
- **Sourcegraph** has the best cross-repo semantic graph in the industry and deliberately never shipped a node-link view of it.
- **Nx**, the one interactive dependency graph people report using, exposes only question-shaped affordances: focus a project, trace the path between two, collapse folders into composite nodes.
- **Bazel** answers "too big" with a query language, not a viewport — you narrow before you draw.
- **webpack-bundle-analyzer** *has* the module DAG and throws it away for a treemap, because the real question is bytes.

Measured readability limits: path-finding degrades above ~50 nodes at high density and ~100 at low density, with cognitive load rising and then falling as participants gave up. Global properties (total size, crossings) dominate local ones.

Node-link is justified here for exactly one reason: above ~20 vertices matrices beat node-link on most tasks, and the sole consistent exception is **path following** — which is precisely the task ("what blocks this, through what"). So the form is right and the node count must be bounded.

## Layered, never force-directed

Position must encode topological depth, and layout must be reproducible. A spring embedder optimises a symmetric energy function, so edge direction contributes nothing to placement, and random initialisation makes every reload a different picture. Column index = depth = readiness is the whole point.

Ordering within a column is seeded by declaration order, which makes the layout a pure function of the data.

## Transitive reduction before drawing

If `A → B` and `B → C`, the `A → C` edge is implied and adds clutter with zero information. Cheapest large readability win available, and unlike edge bundling it preserves meaning exactly.

## No edge bundling, ever

Tempting against a hairball, but bundling "can result in ambiguous connections that do not exist in the data," and this afflicts *all* bundling methods. In a dependency graph the existence of an edge is the load-bearing fact, so a false adjacency is a wrong answer rather than a cosmetic flaw. Confluent drawing — merging only where a biclique genuinely exists — is the principled alternative if this ever matters.

## Collapse by rewriting edges, not hiding nodes

Airflow keeps a closed group's children in the layout model and retargets crossing edges to the group, deduplicating N internal edges into one per source→target pair, labelled `+ N tasks`. Jira draws the aggregate as a dotted line labelled with a link count you can expand. Both are honest about the aggregation; hiding nodes silently is not.

## Layout engine

**elkjs**, with `@xyflow/react` as the interaction layer — the same pairing Airflow 3 ships.

The deciding factor is editing. **dagre documents no incremental or interactive mode**, which makes "the layout jumps on every edit" structural rather than tunable; Nx inherits this. ELK has `INTERACTIVE` variants of crossing-minimisation, layering, and cycle-breaking that derive order from existing coordinates instead of recomputing. Adding one dependency must not rearrange the graph you were reading — the three mental-map invariants (orthogonal ordering, proximity, topology) are exactly what a global reflow destroys.

Cost, recorded honestly: **dagre is MIT; elkjs is EPL-2.0 OR GPL-3.0-or-later.** EPL-2.0 is file-level copyleft, so shipping it unmodified inside an MIT application is standard practice — Airflow does it under Apache-2.0 — but the notice has to travel with it. If that ever becomes unacceptable, the fallback is dagre plus accepting layout instability, not a hand-rolled Sugiyama.

If layout is ever hand-rolled: Brandes–Köpf as published contains two bugs, with a 2020 erratum. Read it first.

## Everything else the graph should do is a derived answer

Critical-path highlighting dates to 1959, and the insight was never "see the whole network" — it was "see the one path that determines the outcome." The overlays worth building are of that kind: what unblocks if I finish this, what is the blast radius of this issue, which chain is longest. They are answers drawn on top of the graph, not layouts.

## The server

`node:http` on `127.0.0.1`, zero runtime dependencies, SPA prebuilt into the package.

Security, because this thing writes. The pattern in every comparable CVE is not "a port was open" — it is *no token* plus *no Host/Origin check* plus *an endpoint that spawns something*. This tool has all three ingredients, and the precedents are unambiguous: MCP Inspector (9.4, one-click RCE), Cline (9.6, unauthenticated WebSocket into an agent PTY), OpenCode (8.8, `cors()` plus an unauthenticated shell endpoint), Storybook (high, unauthenticated WebSocket to a file write), and seven separate Vite `fs.deny` bypasses.

So:

- Bind `127.0.0.1` explicitly. Never the no-host default, which binds every interface. No `--host` flag.
- Exact-match `Host` against `{127.0.0.1:PORT, localhost:PORT, [::1]:PORT}` before routing — this is the DNS-rebinding defence, and CORS is irrelevant to it because the browser considers a rebound request same-origin.
- Emit no `Access-Control-Allow-*` header, ever.
- A 32-byte bearer token per process start, delivered in the **URL fragment** so it never reaches the server, a log, or a `Referer`, then scrubbed with `replaceState` and sent as `Authorization`.
- **No cookies.** `SameSite=Lax`-by-default is Chromium-only, and cookies are scoped by host and not port, so every other localhost tool would share them.
- Require `Content-Type: application/json` exactly on mutations. Combined with the token this makes simple-request and form CSRF structurally impossible.
- Static assets from a hardcoded manifest, never a path minus a denylist. Seven Vite CVEs exist because denylists lose.
- `spawn` with `shell: false`, subcommand from an enum, and reject any argument value starting with `-` unless allowlisted — flag injection via `--db` or `-C` would repoint the store.
- Regression tests asserting 403 for: bad `Host`, bad `Origin`, missing token, `text/plain` POST, form POST, mutating GET, foreign-origin SSE. Every CVE above would have been caught by one of those.

Note the one control that does *not* hold: a locally-running AI browser agent inherits the localhost origin, which defeats Origin checks entirely. The token is what holds.

Live updates use **SSE**, not WebSocket: no client-to-server frames are needed on the live channel, reconnection is native, and Node still ships no WebSocket *server*. The version token goes out as the SSE `id:`, so a reconnect's `Last-Event-ID` closes the changed-while-disconnected gap for free.

## No client state library

TanStack Query's hard problem is cache invalidation at scale; ours is already solved by a push channel that says exactly when to refetch. It also cannot express the one thing actually needed — `takeLatest` coalescing per field. A serialized promise chain plus a pending-ops map is smaller and more capable here.

Writes are serialized through a single queue regardless: `bd` opens the database in-process, so concurrent invocations contend on the write lock, and the ~250ms is process startup rather than overlappable I/O. Parallelism buys nothing and costs lock errors.

## Styling

Plain modern CSS — custom properties for tokens, `@layer`, `light-dark()`, container queries, `:has()`, nesting — plus `<dialog>` and `showModal()` for modals, which gives browser-level background inert-ing and is the single hardest accessibility problem to hand-roll. CSS anchor positioning has shipped in all three engines, so no positioning library. System font stacks, so zero network requests: for a local-first tool that is a correctness property, not a performance one.

The one widget worth a dependency, when it arrives, is a combobox — the APG contract needs `aria-activedescendant` virtual focus and ~30 keyboard behaviours that are realistically 400–700 lines to get right.
