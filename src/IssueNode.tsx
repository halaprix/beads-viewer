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
      {/* The toggle lives in the header rather than below the title: as a third row it
          overflowed the fixed node height and clipped the title it sat on top of. */}
      <header>
        <span className="glyph" aria-hidden="true">
          {STATUS_GLYPH[issue.status] ?? "○"}
        </span>
        <span className="id">{issue.id}</span>
        {issue.priority !== undefined ? <span className="priority">P{issue.priority}</span> : null}
        {isEpic && memberCount > 0 ? (
          <button
            type="button"
            className="toggle"
            onClick={onToggle}
            title={collapsed ? `Expand ${memberCount} children` : "Collapse children"}
          >
            {collapsed ? `+${memberCount}` : "−"}
          </button>
        ) : null}
      </header>
      <p className="title">{issue.title}</p>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
