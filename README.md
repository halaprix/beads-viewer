# beads-viewer

An interactive graph editor for [Beads](https://github.com/gastownhall/beads) issues. Run one command in a repository that has a `.beads` store and a browser opens on a dependency graph you can actually edit — create issues, drag to connect dependencies, change status, all written straight back through the `bd` CLI.

```bash
npx @halaprix/beads-viewer   # in a repo with a .beads store
```

![The Everything view: 29 beads laid out left to right, column position showing dependency depth](https://raw.githubusercontent.com/halaprix/beads-viewer/main/docs/img/everything-view.png)

*The `Everything` view on this project's own store. Column position is dependency depth, so
the leftmost work is startable; solid edges are `blocks`, dashed are `parent-child`. The
default view is narrower than this on purpose.*

## Why this exists

`bd graph --html` loads D3 from a CDN, so it needs the network and cannot be archived. `bd graph` in a terminal is static. Both are read-only. Meanwhile the graph is the one place where a dependency mistake is obvious at a glance — and the one place you cannot fix it.

## What it is not

Not a Beads replacement, and not a second source of truth. The `bd` CLI is the only writer; this is a lens on the store that happens to be able to write through itself. Close the tab and nothing is lost or pending.

## Current scope

The design principle, taken from what actually works in comparable tools: **a graph that answers a question, never a graph of everything.** Rendering the whole store is how Backstage's catalog graph and Obsidian's global graph became things people call pretty and don't use.

In 0.2.0:

1. **Scoped graph by default** — one epic, or a bounded focus around a chosen issue. The whole store is an explicit opt-in, with a warning past the readability cliff.
2. **Layered layout, left to right**, where the column *is* topological depth: column 0 is startable work. Deterministic — the same store always draws the same picture.
3. **Detail panel** with field-level editing. Only the field you touched is written.
4. **Create a child issue** from the detail panel.
5. **Drag to connect a dependency**, select an edge to remove it. Grouped edges are read-only until expanded. `bd` rejects cycles for us, and the rejection is surfaced verbatim.
6. **Live refresh** — a human or an agent running `bd` in a terminal shows up in the UI within about a second.

## Requirements

- Node >= 22.13.0
- `bd` on `PATH`, and a `.beads` store discoverable from the working directory

## CLI

```text
beads-viewer [--port <number>] [--strict-port] [--no-open] [--debug]
beads-viewer --help
beads-viewer --version
```

The server binds to `127.0.0.1` only. Its printed URL carries a one-time token in the
fragment; if a browser cannot be opened automatically, open that URL exactly as printed.

## Developing

```bash
npm install
npm run check      # lint, typecheck, tests, and production build
npm start          # from any repo with a .beads store
```

The CLI and security integration tests use temporary isolated stores and skip cleanly
when `bd` is not installed.

## Status

Version 0.2.0 provides scoped graph views, a detail panel with field-level edits,
child creation, dependency editing, and live refresh. `Everything` remains an explicit
view and warns when it is too crowded to answer anything.

Known gaps: no test covers the React components (the graph model and the server are
tested); collapse state is not persisted across reloads; layout runs on the main thread,
which is fine at these sizes but would want a worker past a few hundred nodes; the
`elk.js` chunk is 442kB gzipped and only loads when a graph is first laid out.

## Releasing

The package is public and has zero runtime dependencies: `prepack` builds the SPA, and
the tarball contains the server plus prebuilt assets. The release workflow checks that
the `vX.Y.Z` tag matches `package.json`, publishes with npm provenance, and creates the
matching GitHub Release. See [CHANGELOG.md](CHANGELOG.md) for shipped changes.

## Licence

MIT. Bundles [elkjs](https://github.com/kieler/elkjs) (EPL-2.0) for layout — see [docs/decisions.md](docs/decisions.md#layout-engine) for why, and `NOTICE` for its terms.
