import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../server/server.mjs";
import { createBeadsWorkspace, fixtureEnv, hasBd, removeBeadsWorkspace } from "./beads-fixture.mjs";

// The bug this file exists for: bd.mjs collapses an array-of-one response, because that
// is the shape `bd show` returns. `bd list` against a store holding exactly one issue
// returns the identical shape, so it was collapsed too, and the API handed the UI an
// object where it expected a list. It surfaced in a brand-new repository with a single
// bead - the first thing anyone tries - and survived every existing test, because
// security.test.mjs shares one server across many tests and never isolates a count.
// Each test here gets its own fresh store, sized exactly, so the boundary is the only
// variable.
const integration = { timeout: 20_000, skip: !hasBd };

async function withCountedStore(count, run) {
  if (!hasBd) return;
  const workspace = await createBeadsWorkspace();
  const server = await startServer({ port: 7398, cwd: workspace, env: fixtureEnv() });
  try {
    const auth = { Authorization: `Bearer ${server.token}` };
    for (let index = 0; index < count; index += 1) {
      const response = await fetch("http://127.0.0.1:7398/api/issues", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ title: `boundary issue ${index}` })
      });
      assert.equal(response.status, 200);
    }
    const listed = await fetch("http://127.0.0.1:7398/api/issues", { headers: auth });
    const { data } = await listed.json();
    await run(data);
  } finally {
    await server.close();
    await removeBeadsWorkspace(workspace);
  }
}

test("an empty store returns an empty array, not null and not an error", integration, async () => {
  await withCountedStore(0, (data) => {
    assert.ok(Array.isArray(data.issues), "issues must be an array even with zero rows");
    assert.equal(data.issues.length, 0);
  });
});

test("a store with exactly one issue returns an array of one", integration, async () => {
  await withCountedStore(1, (data) => {
    assert.ok(Array.isArray(data.issues));
    assert.equal(data.issues.length, 1);
    assert.equal(data.issues[0].title, "boundary issue 0");
  });
});

test("a store with exactly two issues returns an array of two", integration, async () => {
  await withCountedStore(2, (data) => {
    assert.ok(Array.isArray(data.issues));
    assert.equal(data.issues.length, 2);
  });
});

test("an epic with exactly one child still returns both as an array, with parent resolved", integration, async () => {
  if (!hasBd) return;
  const workspace = await createBeadsWorkspace();
  const server = await startServer({ port: 7398, cwd: workspace, env: fixtureEnv() });
  try {
    const auth = { Authorization: `Bearer ${server.token}` };
    const epic = await (
      await fetch("http://127.0.0.1:7398/api/issues", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "the only epic", type: "epic" })
      })
    ).json();
    const epicId = epic.data.id;
    await fetch("http://127.0.0.1:7398/api/issues", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "its only child", parent: epicId })
    });

    const { data } = await (
      await fetch("http://127.0.0.1:7398/api/issues", { headers: auth })
    ).json();
    assert.ok(Array.isArray(data.issues));
    assert.equal(data.issues.length, 2);
    const child = data.issues.find((issue) => issue.parent === epicId);
    assert.ok(child, "the child's parent field must resolve to the epic's id");
  } finally {
    await server.close();
    await removeBeadsWorkspace(workspace);
  }
});
