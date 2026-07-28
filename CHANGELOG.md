# Changelog

All notable changes to this package are documented here.

## 0.2.1 - 2026-07-28

- Always return a list of issues. A store holding exactly one issue made `bd list`
  indistinguishable from `bd show`, whose array-of-one the adapter collapses - so a new
  repository with a single bead handed the UI an object and the graph rendered nothing.

- Resolve the Beads store from an explicitly passed environment rather than reading
  `process.env` directly, so a caller that isolates itself actually is isolated. The
  integration tests built their own store but still opened whatever an exported
  `BEADS_DIR` pointed at, which passed wherever that variable was unset.
- Report a store with no prefix as `null` instead of `undefined`, and print `(no prefix)`
  rather than the word `undefined` as a project name.

## 0.2.0 - 2026-07-27

- Open the viewer in the default browser when a desktop session is available.
- Add `--help`, `--version`, and strict validation for CLI port values.
- Keep nested epic descendants inside a collapsed outer epic.
- Mark grouped dependency edges as read-only until their epic is expanded.
- Validate priority values at the HTTP boundary.
- Make the CLI and security integration tests use isolated temporary Beads stores.

## 0.1.0 - 2026-07-27

- Initial npm release with scoped graph views, field-level editing, dependency editing,
  deterministic layered layout, and live refresh.
