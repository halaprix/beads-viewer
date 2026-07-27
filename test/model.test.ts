import test from "node:test";
import assert from "node:assert/strict";
import {
  collapsedGroupFor,
  collapseGroups,
  collectEdges,
  foldFinished,
  groupMembership,
  isReady,
  indexIssues,
  restrict,
  selectScope,
  transitiveReduction,
  unblockedBy,
  type Issue
} from "../src/graph/model.ts";

function issue(id: string, extra: Partial<Issue> = {}): Issue {
  return { id, title: `Title ${id}`, status: "open", ...extra };
}

function dep(dependent: string, blocker: string, type = "blocks") {
  return { issue_id: dependent, depends_on_id: blocker, type };
}

// e1 blocks e2 blocks e3, and e1 also declares a redundant direct block on e3.
const CHAIN: Issue[] = [
  issue("p-1"),
  issue("p-2", { dependencies: [dep("p-2", "p-1")] }),
  issue("p-3", { dependencies: [dep("p-3", "p-2"), dep("p-3", "p-1")] })
];

test("only ordering and containment become edges; annotations draw nothing", () => {
  const issues = [
    issue("a-1"),
    issue("a-2", {
      dependencies: [dep("a-2", "a-1", "relates-to"), dep("a-2", "a-1", "discovered-from")]
    }),
    issue("a-3", { dependencies: [dep("a-3", "a-1", "parent-child")] })
  ];
  const edges = collectEdges(issues);
  assert.deepEqual(
    edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`),
    ["a-1->a-3:containment"]
  );
});

test("transitive reduction drops an edge a longer path already implies", () => {
  const reduced = transitiveReduction(collectEdges(CHAIN));
  const keys = reduced.map((edge) => `${edge.from}->${edge.to}`);
  assert.deepEqual(keys.sort(), ["p-1->p-2", "p-2->p-3"]);
  // The implied edge is gone but reachability is unchanged - that is what makes this
  // safe in a way edge bundling is not.
  assert.equal(keys.includes("p-1->p-3"), false);
});

test("transitive reduction terminates on a cycle instead of recursing forever", () => {
  const cyclic = [
    issue("c-1", { dependencies: [dep("c-1", "c-2")] }),
    issue("c-2", { dependencies: [dep("c-2", "c-1")] })
  ];
  const reduced = transitiveReduction(collectEdges(cyclic));
  assert.equal(reduced.length, 2);
});

test("collapsing an epic rewrites crossing edges and counts what it merged", () => {
  const issues = [
    issue("e-1", { issue_type: "epic" }),
    issue("e-1.1", { parent: "e-1", dependencies: [dep("e-1.1", "e-1", "parent-child")] }),
    issue("e-1.2", { parent: "e-1", dependencies: [dep("e-1.2", "e-1", "parent-child")] }),
    // Two separate children both block the same outside issue.
    issue("out", { dependencies: [dep("out", "e-1.1"), dep("out", "e-1.2")] })
  ];
  const { members } = groupMembership(issues);
  const edges = collapseGroups(collectEdges(issues), members, new Set(["e-1"]));
  const ordering = edges.filter((edge) => edge.kind === "ordering");

  // The two child edges became one edge from the epic, labelled with how many it stands
  // for. Silently merging them would claim a single dependency where two exist.
  assert.equal(ordering.length, 1);
  assert.equal(ordering[0]!.from, "e-1");
  assert.equal(ordering[0]!.to, "out");
  assert.equal(ordering[0]!.count, 2);
  assert.equal(ordering[0]!.aggregated, true);

  // Containment edges wholly inside the collapsed group have nothing left to say.
  assert.equal(edges.some((edge) => edge.kind === "containment"), false);
});

test("collapsing an outer epic includes descendants of a nested epic", () => {
  const issues = [
    issue("outer", { issue_type: "epic" }),
    issue("inner", { issue_type: "epic", parent: "outer" }),
    issue("child", { parent: "inner" }),
    issue("outside", { dependencies: [dep("outside", "child")] })
  ];
  const { members } = groupMembership(issues);
  const collapsed = new Set(["outer"]);

  assert.equal(collapsedGroupFor("inner", members, collapsed), "outer");
  assert.equal(collapsedGroupFor("child", members, collapsed), "outer");

  const edge = collapseGroups(collectEdges(issues), members, collapsed).find(
    (candidate) => candidate.kind === "ordering"
  );
  assert.deepEqual(edge, {
    from: "outer",
    to: "outside",
    kind: "ordering",
    count: 1,
    aggregated: true
  });
});

test("readiness ignores finished blockers and containment", () => {
  const issues = [
    issue("r-1", { status: "closed" }),
    issue("r-2", { status: "open" }),
    issue("r-3", { dependencies: [dep("r-3", "r-1")] }),
    issue("r-4", { dependencies: [dep("r-4", "r-2")] }),
    issue("r-5", { dependencies: [dep("r-5", "r-1", "parent-child")] })
  ];
  const edges = collectEdges(issues);
  const byId = indexIssues(issues);
  const ready = (id: string) => isReady(byId.get(id)!, edges, byId);

  assert.equal(ready("r-3"), true, "a closed blocker does not block");
  assert.equal(ready("r-4"), false, "an open blocker does block");
  assert.equal(ready("r-5"), true, "a parent does not block its child");
  assert.equal(ready("r-1"), false, "a closed issue is not ready work");
});

test("the default view is startable work plus what it would unblock", () => {
  const issues = [
    issue("s-1"),
    issue("s-2", { dependencies: [dep("s-2", "s-1")] }),
    // Two hops away: reachable, but not part of the answer to "what can I start now".
    issue("s-3", { dependencies: [dep("s-3", "s-2")] })
  ];
  const edges = collectEdges(issues);
  const scope = selectScope(issues, edges, "ready", null);
  assert.deepEqual([...scope].sort(), ["s-1", "s-2"]);
  assert.deepEqual(unblockedBy("s-1", edges), ["s-2"]);
});

test("epic scope takes the epic and its descendants, and edges never dangle", () => {
  const issues = [
    issue("g-1", { issue_type: "epic" }),
    issue("g-1.1", { parent: "g-1", dependencies: [dep("g-1.1", "g-1", "parent-child")] }),
    issue("g-1.1.1", { parent: "g-1.1", dependencies: [dep("g-1.1.1", "g-1.1", "parent-child")] }),
    issue("elsewhere", { dependencies: [dep("elsewhere", "g-1.1")] })
  ];
  const edges = collectEdges(issues);
  const scope = selectScope(issues, edges, "epic", "g-1");
  assert.deepEqual([...scope].sort(), ["g-1", "g-1.1", "g-1.1.1"]);

  const restricted = restrict(edges, scope);
  assert.equal(
    restricted.every((edge) => scope.has(edge.from) && scope.has(edge.to)),
    true
  );
});

test("focus scope is bounded, so it cannot degrade into the whole store", () => {
  // A ten-long chain: focusing the middle must not drag in both ends.
  const issues = Array.from({ length: 10 }, (_, index) =>
    issue(`f-${index}`, index === 0 ? {} : { dependencies: [dep(`f-${index}`, `f-${index - 1}`)] })
  );
  const scope = selectScope(issues, collectEdges(issues), "focus", "f-5");
  assert.equal(scope.has("f-5"), true);
  assert.equal(scope.has("f-3"), true, "two hops upstream is in");
  assert.equal(scope.has("f-7"), true, "two hops downstream is in");
  assert.equal(scope.has("f-2"), false, "three hops is out");
  assert.equal(scope.size, 5);
});

test("group membership resolves through an intermediate task to the nearest epic", () => {
  const issues = [
    issue("m-1", { issue_type: "epic" }),
    issue("m-1.1", { parent: "m-1" }),
    issue("m-1.1.1", { parent: "m-1.1" })
  ];
  const { members, epics } = groupMembership(issues);
  assert.deepEqual([...epics], ["m-1"]);
  assert.equal(members.get("m-1.1"), "m-1");
  assert.equal(members.get("m-1.1.1"), "m-1", "a grandchild still belongs to the epic");
});

test("group membership survives a parent cycle rather than hanging", () => {
  const issues = [
    issue("x-1", { parent: "x-2" }),
    issue("x-2", { parent: "x-1" })
  ];
  const { members } = groupMembership(issues);
  assert.equal(members.size, 0);
});

test("folding finished work is safe because a closed bead constrains nothing", () => {
  const issues = [
    issue("d-1"),
    issue("d-2", { status: "closed", dependencies: [dep("d-2", "d-1")] }),
    issue("d-3", { dependencies: [dep("d-3", "d-2")] }),
    issue("d-4", { status: "deferred" })
  ];
  const byId = indexIssues(issues);
  const { kept, folded } = foldFinished(["d-1", "d-2", "d-3", "d-4"], byId);

  assert.deepEqual([...kept].sort(), ["d-1", "d-3"]);
  assert.equal(folded, 2, "closed and deferred both count as finished");

  // d-1 and d-3 were only ever connected through the closed d-2, so once it is folded
  // they are genuinely unrelated - d-3 is not waiting on d-1. Dropping the dangling
  // edges is therefore correct rather than a cosmetic omission.
  const remaining = restrict(collectEdges(issues), kept);
  assert.deepEqual(remaining, []);
});

test("folding leaves a chain between two open beads intact", () => {
  const issues = [issue("k-1"), issue("k-2", { dependencies: [dep("k-2", "k-1")] })];
  const byId = indexIssues(issues);
  const { kept, folded } = foldFinished(["k-1", "k-2"], byId);
  assert.equal(folded, 0);
  assert.equal(restrict(collectEdges(issues), kept).length, 1);
});
