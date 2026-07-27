import type { Edge } from "./model.ts";

// The one boundary the layout engine lives behind. ELK is here rather than dagre
// because dagre documents no incremental mode, which makes "the graph jumps whenever
// you add a dependency" structural rather than tunable - and rearranging the picture
// someone is reading destroys the three mental-map invariants. Swapping engines means
// replacing this file and nothing else.
// Loaded on first layout rather than at startup. elkjs is GWT-compiled and ~1.4MB
// minified - code that is not needed until there is a graph to lay out. The dynamic
// import keeps the shell at ~120kB gzipped; the promise is cached so the cost is paid
// once. The chunk name is fixed in vite.config.ts because the server serves a literal
// manifest and cannot look up a hashed filename.
function loadElk() {
  return import("elkjs/lib/elk.bundled.js").then((module) => new module.default());
}

let elkPromise: ReturnType<typeof loadElk> | null = null;

function getElk() {
  elkPromise ??= loadElk();
  return elkPromise;
}

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 76;

export type Positioned = { id: string; x: number; y: number };

export async function layoutGraph(
  ids: string[],
  edges: Edge[],
  { interactive }: { interactive?: Map<string, Positioned> } = {}
): Promise<Map<string, Positioned>> {
  // Sorted input, so layout is a pure function of the data. Unstable ordering breaks
  // serialization before it breaks anything you can see.
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      // Left to right, so the column index *is* topological depth: column 0 is
      // startable work. That is the whole reason to prefer layered over force-directed,
      // where position encodes nothing and every reload differs.
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      "elk.spacing.nodeNode": "24",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      // Straight long edges: readers follow the line that continues toward the target,
      // so a kinked spanning edge is where they lose the thread.
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.edgeRouting": "ORTHOGONAL",
      // When previous coordinates exist, derive order from them instead of recomputing,
      // so an edit nudges the drawing rather than reshuffling it.
      ...(interactive
        ? {
            "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
            "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
            "elk.interactiveLayout": "true"
          }
        : {})
    },
    children: sorted.map((id) => {
      const previous = interactive?.get(id);
      return {
        id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        ...(previous ? { x: previous.x, y: previous.y } : {})
      };
    }),
    // Containment is drawn but must not push a child rightward: an epic does not block
    // its own children, and treating it as a blocker would report every epic child as
    // unstartable.
    edges: edges
      .filter((edge) => edge.kind === "ordering")
      .map((edge, index) => ({ id: `e${index}`, sources: [edge.from], targets: [edge.to] }))
  };

  try {
    const elk = await getElk();
    const result = await elk.layout(graph);
    const positions = new Map<string, Positioned>();
    for (const child of result.children ?? []) {
      positions.set(child.id!, { id: child.id!, x: child.x ?? 0, y: child.y ?? 0 });
    }
    return positions;
  } catch {
    // If the layout chunk fails to load, degrade to depth columns rather than stacking
    // every node at the origin. A rough graph is readable; a blank canvas is not, and it
    // looks identical to a data problem.
    return fallbackLayout(sorted, edges);
  }
}

/** Longest-path columns computed directly, as a floor under any layout failure. */
export function fallbackLayout(ids: string[], edges: Edge[]): Map<string, Positioned> {
  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  const ordering = edges.filter((edge) => edge.kind === "ordering");
  // Relax repeatedly rather than recursing, so a cycle cannot blow the stack.
  for (let pass = 0; pass < ids.length; pass += 1) {
    let moved = false;
    for (const edge of ordering) {
      const from = depth.get(edge.from);
      const to = depth.get(edge.to);
      if (from === undefined || to === undefined) continue;
      if (to < from + 1) {
        depth.set(edge.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const rows = new Map<number, number>();
  const positions = new Map<string, Positioned>();
  for (const id of ids) {
    const column = depth.get(id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    positions.set(id, {
      id,
      x: column * (NODE_WIDTH + 96),
      y: row * (NODE_HEIGHT + 24)
    });
  }
  return positions;
}
