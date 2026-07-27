import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type Node as FlowNode
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, ApiError, subscribe } from "./api.ts";
import { IssueNode } from "./IssueNode.tsx";
import { Details } from "./Details.tsx";
import { NODE_HEIGHT, NODE_WIDTH, layoutGraph, type Positioned } from "./graph/layout.ts";
import {
  collapseGroups,
  collectEdges,
  foldFinished,
  groupMembership,
  indexIssues,
  restrict,
  selectScope,
  transitiveReduction,
  unblockedBy,
  type Issue,
  type ViewMode
} from "./graph/model.ts";

const nodeTypes = { issue: IssueNode };

// Past this, path-finding measurably degrades and the drawing stops answering
// questions. The full-store view stays available, but it says so first.
const CROWDED = 60;

export function App() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [mode, setMode] = useState<ViewMode>("ready");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Finished work is folded away by default: it is most of a mature store and none of it
  // is actionable. Still one click from view, because "why is this closed" is a real
  // question.
  const [showDone, setShowDone] = useState(false);
  const [positions, setPositions] = useState<Map<string, Positioned>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const previous = useRef<Map<string, Positioned>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const { issues: next } = await api.issues();
      setIssues(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // A terminal `bd` or an agent is a real concurrent writer, so the UI follows the
    // store rather than assuming it owns it.
    return subscribe(() => void refresh());
  }, [refresh]);

  const { members, epics } = useMemo(() => groupMembership(issues), [issues]);
  const byId = useMemo(() => indexIssues(issues), [issues]);

  const { visible, edges, folded } = useMemo(() => {
    const all = collectEdges(issues);
    const selectedScope = selectScope(issues, all, mode, anchor);
    const { kept, folded: foldedCount } = showDone
      ? { kept: selectedScope, folded: 0 }
      : foldFinished(selectedScope, byId);
    const scope = kept;
    // Reduce before collapsing: a redundant edge merged into a group count would inflate
    // the number and imply constraints that do not exist.
    const reduced = transitiveReduction(restrict(all, scope));
    const collapsedEdges = collapseGroups(reduced, members, collapsed);
    const hiddenByCollapse = new Set(
      [...scope].filter((id) => {
        const owner = members.get(id);
        return owner && collapsed.has(owner) && owner !== id;
      })
    );
    return {
      visible: [...scope].filter((id) => !hiddenByCollapse.has(id)),
      edges: collapsedEdges,
      folded: foldedCount
    };
  }, [issues, mode, anchor, members, collapsed, showDone, byId]);

  useEffect(() => {
    let cancelled = false;
    void layoutGraph(visible, edges, {
      // Feeding the previous coordinates back makes an edit nudge the drawing instead of
      // reshuffling it - the mental-map invariants that a global reflow destroys.
      interactive: previous.current.size > 0 ? previous.current : undefined
    }).then((result) => {
      if (!cancelled) {
        previous.current = result;
        setPositions(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visible, edges]);

  const flowNodes: FlowNode[] = useMemo(
    () =>
      visible.map((id) => {
        const issue = byId.get(id);
        const position = positions.get(id) ?? { x: 0, y: 0 };
        const memberCount = [...members.values()].filter((owner) => owner === id).length;
        return {
          id,
          type: "issue",
          position: { x: position.x, y: position.y },
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          data: {
            issue: issue ?? { id, title: id, status: "open" },
            isEpic: epics.has(id),
            collapsed: collapsed.has(id),
            memberCount,
            selected: selected === id,
            onToggle: () =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) {
                  next.delete(id);
                } else {
                  next.add(id);
                }
                return next;
              })
          }
        };
      }),
    [visible, byId, positions, epics, collapsed, selected, members]
  );

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: `${edge.from}->${edge.to}:${edge.kind}`,
        source: edge.from,
        target: edge.to,
        // An aggregate edge says how many real edges it stands for. Silent merging
        // would make the picture claim a single dependency where several exist.
        label: edge.count > 1 ? String(edge.count) : undefined,
        animated: false,
        className: edge.kind,
        style:
          edge.kind === "containment"
            ? { strokeDasharray: "3 4", stroke: "var(--edge-soft)" }
            : { stroke: "var(--edge)" }
      })),
    [edges]
  );

  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        setError(null);
        await action();
      } catch (cause) {
        // bd rejects cycles itself, so its refusal is shown verbatim rather than
        // pre-empted with a guess about what is legal.
        setError(cause instanceof ApiError ? cause.message : String(cause));
      } finally {
        // The CLI is authoritative and may have partially applied, so re-read either way.
        await refresh();
      }
    },
    [refresh]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      // Dragging from a blocker's right handle to a dependent's left handle reads as
      // "this comes first", matching the left-to-right flow.
      void mutate(() => api.addDependency(connection.target!, connection.source!));
    },
    [mutate]
  );

  const onEdgesDelete = useCallback(
    (removed: FlowEdge[]) => {
      for (const edge of removed) {
        if (edge.className === "containment") continue;
        void mutate(() => api.removeDependency(edge.target, edge.source));
      }
    },
    [mutate]
  );

  const current = selected ? byId.get(selected) : null;

  return (
    <div className="shell">
      <header>
        <div className="views" role="group" aria-label="View">
          {(
            [
              ["ready", "Ready & what it unblocks"],
              ["epic", "Epic"],
              ["focus", "Focus"],
              ["all", "Everything"]
            ] as [ViewMode, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={(value === "epic" || value === "focus") && !anchor}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="fold">
          <input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} />
          Show done
        </label>
        <p className="meta">
          {loading ? "loading…" : `${visible.length} shown of ${issues.length} · ${edges.length} edges`}
          {folded > 0 ? ` · ${folded} done folded` : ""}
          {mode === "all" && visible.length > CROWDED ? " · crowded, prefer a scoped view" : ""}
        </p>
      </header>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          onNodeClick={(_, node) => {
            setSelected(node.id);
            setAnchor(node.id);
          }}
          nodesDraggable
          nodesConnectable
          fitView
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {current ? (
        <Details
          issue={current}
          unblocks={unblockedBy(current.id, edges)}
          onClose={() => setSelected(null)}
          onFocus={() => {
            setAnchor(current.id);
            setMode("focus");
          }}
          onField={(field, value) => mutate(() => api.updateField(current.id, field, value))}
          onCreateChild={(title) =>
            mutate(() => api.createIssue({ title, parent: current.id }))
          }
        />
      ) : null}
    </div>
  );
}
