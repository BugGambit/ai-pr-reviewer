"use client";

import { useMemo, useState } from "react";
import { parseDiff, classifyFile } from "@/lib/analysis/diff";
import type { SuggestedReviewComment } from "@/lib/types";

function FileDiff({
  file,
  onComment,
  defaultOpen,
}: {
  file: ReturnType<typeof parseDiff>[number];
  onComment: (comment: SuggestedReviewComment) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [commentOn, setCommentOn] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 10,
          padding: "9px 12px",
          background: "var(--surface-2)",
          border: "none",
          borderBottom: open ? "1px solid var(--border)" : "none",
          cursor: "pointer",
          color: "inherit",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <span className="muted" aria-hidden style={{ fontSize: 11 }}>
          {open ? "▾" : "▸"}
        </span>
        <span className="mono" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
          {file.path}
        </span>
        <span className="chip muted">{classifyFile(file.path)}</span>
        {file.isNew ? <span className="chip" style={{ color: "var(--status-good)" }}>new</span> : null}
        {file.isDeleted ? <span className="chip" style={{ color: "var(--status-critical)" }}>deleted</span> : null}
        <span className="tabular" style={{ fontSize: 12 }}>
          <span style={{ color: "var(--status-good)" }}>+{file.additions}</span>{" "}
          <span style={{ color: "var(--status-critical)" }}>−{file.deletions}</span>
        </span>
      </button>

      {open ? (
        file.isBinary ? (
          <div className="muted" style={{ padding: 14, fontSize: 12.5 }}>
            Binary file — no textual diff.
          </div>
        ) : (
          <div style={{ background: "var(--surface-0)", overflowX: "auto" }}>
            {file.hunks.map((hunk, hunkIndex) => (
              <div key={`${hunk.header}-${hunkIndex}`}>
                <div className="diff-line diff-hunk">
                  <span className="gutter" />
                  <span className="gutter" />
                  <span style={{ paddingLeft: 8 }}>{hunk.header}</span>
                </div>
                {hunk.lines.map((line, lineIndex) => {
                  const key = `${hunkIndex}-${lineIndex}`;
                  const canComment = line.type !== "del" && line.newLine !== null;
                  return (
                    <div key={key}>
                      <div
                        className={`diff-line ${line.type === "add" ? "diff-add" : line.type === "del" ? "diff-del" : ""}`}
                        onDoubleClick={() => {
                          if (canComment) {
                            setCommentOn(line.newLine);
                            setDraft("");
                          }
                        }}
                        title={canComment ? "Double-click to comment on this line" : undefined}
                      >
                        <span className="gutter">{line.oldLine ?? ""}</span>
                        <span className="gutter">{line.newLine ?? ""}</span>
                        <span style={{ paddingLeft: 8 }}>
                          <span className="muted" aria-hidden>
                            {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                          </span>
                          {line.content}
                        </span>
                      </div>

                      {canComment && commentOn === line.newLine ? (
                        <div style={{ padding: "9px 12px", background: "var(--surface-2)" }}>
                          <textarea
                            className="textarea"
                            style={{ minHeight: 64 }}
                            autoFocus
                            placeholder={`Comment on ${file.path}:${line.newLine}`}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                          />
                          <div style={{ display: "flex", gap: 8, marginTop: 7 }}>
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={!draft.trim()}
                              onClick={() => {
                                onComment({ file: file.path, line: line.newLine!, body: draft });
                                setCommentOn(null);
                                setDraft("");
                              }}
                            >
                              Attach to review
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => setCommentOn(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

export function DiffViewer({
  diff,
  truncated,
  onComment,
}: {
  diff: string;
  truncated: boolean;
  onComment: (comment: SuggestedReviewComment) => void;
}) {
  const [query, setQuery] = useState("");
  const files = useMemo(() => parseDiff(diff), [diff]);

  const visible = query.trim()
    ? files.filter((f) => f.path.toLowerCase().includes(query.trim().toLowerCase()))
    : files;

  // Opening every hunk of a 200-file PR locks the browser up; only small
  // diffs expand by default.
  const expandAll = files.length <= 6;

  return (
    <div>
      <div style={{ display: "flex", gap: 9, marginBottom: 11, alignItems: "center" }}>
        <input
          className="input"
          style={{ maxWidth: 300 }}
          placeholder="Filter files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {visible.length} of {files.length} files · double-click a line to comment
        </span>
      </div>

      {truncated ? (
        <div
          style={{
            padding: "9px 12px",
            marginBottom: 11,
            borderRadius: 7,
            border: "1px solid var(--status-warning)",
            background: "color-mix(in srgb, var(--status-warning) 10%, transparent)",
            fontSize: 12.5,
            color: "var(--status-warning)",
          }}
        >
          This diff was truncated because it exceeds the configured size limit. Raise it in Settings → Review.
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {visible.map((file) => (
          <FileDiff key={file.path} file={file} onComment={onComment} defaultOpen={expandAll} />
        ))}
      </div>
    </div>
  );
}
