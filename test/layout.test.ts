import test from "node:test";
import assert from "node:assert/strict";
import { fallbackLayout, NODE_WIDTH } from "../src/graph/layout.ts";
import type { Edge } from "../src/graph/model.ts";

// The fallback is the floor under a failed dynamic import. It is worth testing precisely
// because it only ever runs when something else has already gone wrong - the moment when
// an untested code path is least welcome. Importing layout.ts is safe here: elkjs is
// behind a dynamic import that this path never reaches.
const order = (from: string, to: string): Edge => ({ from, to, kind: "ordering", count: 1 });

test("fallback places nodes in longest-path columns", () => {
  const ids = ["a", "b", "c"];
  const positions = fallbackLayout(ids, [order("a", "b"), order("b", "c"), order("a", "c")]);
  const column = (id: string) => Math.round(positions.get(id)!.x / (NODE_WIDTH + 96));

  assert.equal(column("a"), 0);
  assert.equal(column("b"), 1);
  // Longest path, not shortest: c is behind b even though a also blocks it directly.
  assert.equal(column("c"), 2);
});

test("fallback does not stack nodes in the same column", () => {
  const positions = fallbackLayout(["x", "y", "z"], []);
  const ys = ["x", "y", "z"].map((id) => positions.get(id)!.y);
  assert.equal(new Set(ys).size, 3, "independent nodes overlapped");
  assert.equal(new Set(["x", "y", "z"].map((id) => positions.get(id)!.x)).size, 1);
});

test("fallback terminates on a cycle", () => {
  const positions = fallbackLayout(["m", "n"], [order("m", "n"), order("n", "m")]);
  assert.equal(positions.size, 2);
  for (const position of positions.values()) {
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
  }
});
