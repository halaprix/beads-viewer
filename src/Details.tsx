import { useEffect, useState } from "react";
import type { Issue } from "./graph/model.ts";

const STATUSES = ["open", "in_progress", "blocked", "deferred", "closed"];

type Props = {
  issue: Issue;
  unblocks: string[];
  onClose: () => void;
  onFocus: () => void;
  onField: (field: string, value: string | number) => Promise<void> | void;
  onCreateChild: (title: string) => Promise<void> | void;
};

export function Details({ issue, unblocks, onClose, onFocus, onField, onCreateChild }: Props) {
  // Re-seeded from the server whenever the record changes: bd has no ETag, so an edit
  // form rendered from stale data is how a concurrent terminal edit gets clobbered.
  const [title, setTitle] = useState(issue.title);
  const [child, setChild] = useState("");
  useEffect(() => setTitle(issue.title), [issue.id, issue.title]);

  // One field per request, on commit rather than per keystroke - each write costs a
  // ~250ms process start, and only the field actually touched is sent.
  const commitTitle = () => {
    if (title.trim() && title !== issue.title) {
      void onField("title", title.trim());
    }
  };

  return (
    <aside className="details" aria-label={`Details for ${issue.id}`}>
      <header>
        <span className="id">{issue.id}</span>
        <button type="button" onClick={onFocus}>
          Focus
        </button>
        <button type="button" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>

      <label>
        Title
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTitle();
          }}
        />
      </label>

      <div className="row">
        <label>
          Status
          <select value={issue.status} onChange={(event) => void onField("status", event.target.value)}>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            value={String(issue.priority ?? 2)}
            onChange={(event) => void onField("priority", Number(event.target.value))}
          >
            {[0, 1, 2, 3, 4].map((priority) => (
              <option key={priority} value={priority}>
                P{priority}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section>
        <h2>Unblocks</h2>
        {unblocks.length === 0 ? (
          <p className="muted">Finishing this frees nothing else in view.</p>
        ) : (
          <ul>
            {unblocks.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        )}
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (child.trim()) {
            void onCreateChild(child.trim());
            setChild("");
          }
        }}
      >
        <label>
          New child issue
          <input value={child} onChange={(event) => setChild(event.target.value)} placeholder="Title" />
        </label>
        <button type="submit" disabled={!child.trim()}>
          Create
        </button>
      </form>
    </aside>
  );
}
