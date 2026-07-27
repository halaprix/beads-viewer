# Changelog

All notable changes to this package are documented here.

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
