import { Handle, Position } from "@xyflow/react";
import { STATUS_GLYPH, type Issue } from "./graph/model.ts";

type Data = {
  issue: Issue;
  isEpic: boolean;
  collapsed: boolean;
  memberCount: number;
  selected: boolean;
  onToggle: () => void;
};

export function IssueNode({ data }: { data: Data }) {
  const { issue, isEpic, collapsed, memberCount, selected, onToggle } = data;
  return (
    <article
      className={`node status-${issue.status}${isEpic ? " epic" : ""}${selected ? " selected" : ""}`}
      aria-label={`${issue.id} ${issue.title}`}
    >
      {/* Left is "what blocks me", right is "what I block", matching the flow direction
          so a drag reads the same way the graph does. */}
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="glyph" aria-hidden="true">
          {STATUS_GLYPH[issue.status] ?? "○"}
        </span>
        <span className="id">{issue.id}</span>
        {issue.priority !== undefined ? <span className="priority">P{issue.priority}</span> : null}
      </header>
      <p className="title">{issue.title}</p>
      {isEpic && memberCount > 0 ? (
        <button type="button" className="toggle" onClick={onToggle}>
          {collapsed ? `expand + ${memberCount}` : "collapse"}
        </button>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
