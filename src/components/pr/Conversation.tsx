"use client";

import { Empty } from "@/components/ui";
import { GitHubBody } from "@/components/GitHubBody";
import { relativeTime } from "@/lib/client";
import type { PrDetail } from "@/lib/types";

function Avatar({ login, url }: { login: string; url: string | null }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={22} height={22} style={{ borderRadius: "50%", flex: "none" }} />
  ) : (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: "var(--surface-3)",
        display: "grid",
        placeItems: "center",
        fontSize: 11,
        flex: "none",
      }}
      aria-hidden
    >
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}

const REVIEW_STATE: Record<string, { color: string; icon: string; label: string }> = {
  APPROVED: { color: "var(--status-good)", icon: "✓", label: "approved" },
  CHANGES_REQUESTED: { color: "var(--status-critical)", icon: "✕", label: "requested changes" },
  COMMENTED: { color: "var(--ink-muted)", icon: "💬", label: "commented" },
  DISMISSED: { color: "var(--ink-muted)", icon: "–", label: "dismissed" },
};

export function Conversation({ pr }: { pr: PrDetail }) {
  const timeline = [
    ...pr.comments.map((c) => ({ kind: "comment" as const, at: c.createdAt, data: c })),
    ...pr.reviews.map((r) => ({ kind: "review" as const, at: r.submittedAt ?? "", data: r })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));

  const openThreads = pr.reviewThreads.filter((t) => !t.isResolved);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {openThreads.length > 0 ? (
        <div>
          <h3 style={{ fontSize: 13, margin: "0 0 9px" }}>Open review threads ({openThreads.length})</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {openThreads.map((thread) => (
              <div
                key={thread.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  background: "var(--surface-2)",
                  overflow: "hidden",
                }}
              >
                <div
                  className="mono muted"
                  style={{ padding: "6px 11px", borderBottom: "1px solid var(--border)", background: "var(--surface-0)" }}
                >
                  {thread.path ?? "(file-level)"}
                  {thread.line ? `:${thread.line}` : ""}
                  {thread.isOutdated ? " · outdated" : ""}
                </div>
                {thread.comments.map((comment) => (
                  <div key={comment.id} style={{ padding: "10px 12px", borderTop: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 5 }}>
                      <Avatar login={comment.author.login} url={comment.author.avatarUrl} />
                      <strong style={{ fontSize: 12.5 }}>@{comment.author.login}</strong>
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        {relativeTime(comment.createdAt)}
                      </span>
                    </div>
                    <GitHubBody html={comment.bodyHtml} markdown={comment.body} prId={pr.id} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <h3 style={{ fontSize: 13, margin: "0 0 9px" }}>Conversation</h3>
        {timeline.length === 0 ? (
          <Empty>No comments yet.</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {timeline.map((entry) => {
              if (entry.kind === "review") {
                const meta = REVIEW_STATE[entry.data.state] ?? REVIEW_STATE.COMMENTED;
                return (
                  <div key={entry.data.id} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                    <Avatar login={entry.data.author.login} url={entry.data.author.avatarUrl} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, marginBottom: 3 }}>
                        <strong>@{entry.data.author.login}</strong>{" "}
                        <span style={{ color: meta.color }}>
                          <span aria-hidden>{meta.icon}</span> {meta.label}
                        </span>{" "}
                        <span className="muted">{relativeTime(entry.at)}</span>
                      </div>
                      {entry.data.body || entry.data.bodyHtml ? (
                        <GitHubBody html={entry.data.bodyHtml} markdown={entry.data.body} prId={pr.id} />
                      ) : null}
                    </div>
                  </div>
                );
              }
              return (
                <div key={entry.data.id} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                  <Avatar login={entry.data.author.login} url={entry.data.author.avatarUrl} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, marginBottom: 3 }}>
                      <strong>@{entry.data.author.login}</strong>{" "}
                      <span className="muted">{relativeTime(entry.at)}</span>
                    </div>
                    <GitHubBody html={entry.data.bodyHtml} markdown={entry.data.body} prId={pr.id} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function CommitList({ pr }: { pr: PrDetail }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {pr.commits.map((commit) => (
        <a
          key={commit.oid}
          href={commit.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            display: "grid",
            gridTemplateColumns: "80px 1fr auto",
            gap: 11,
            padding: "7px 10px",
            borderRadius: 6,
            alignItems: "baseline",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "")}
        >
          <span className="mono muted">{commit.oid.slice(0, 8)}</span>
          <span style={{ fontSize: 12.5, minWidth: 0, overflowWrap: "anywhere" }}>{commit.messageHeadline}</span>
          <span className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
            @{commit.author} · {relativeTime(commit.committedDate)}
          </span>
        </a>
      ))}
    </div>
  );
}

export function ChecksList({ pr }: { pr: PrDetail }) {
  const order = { FAILURE: 0, ERROR: 1, PENDING: 2, EXPECTED: 3, SUCCESS: 4, NONE: 5 };
  const checks = [...pr.checks].sort((a, b) => order[a.state] - order[b.state]);

  if (checks.length === 0) return <Empty>No CI checks reported for this commit.</Empty>;

  const colorFor = (state: string) =>
    state === "SUCCESS"
      ? "var(--status-good)"
      : state === "FAILURE" || state === "ERROR"
        ? "var(--status-critical)"
        : state === "PENDING"
          ? "var(--status-warning)"
          : "var(--ink-muted)";

  const iconFor = (state: string) =>
    state === "SUCCESS" ? "✓" : state === "FAILURE" || state === "ERROR" ? "✕" : state === "PENDING" ? "◷" : "◌";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {checks.map((check, index) => (
        <div
          key={`${check.name}-${index}`}
          style={{ display: "grid", gridTemplateColumns: "20px 1fr auto", gap: 9, padding: "6px 8px", alignItems: "center" }}
        >
          <span aria-hidden style={{ color: colorFor(check.state) }}>
            {iconFor(check.state)}
          </span>
          <span style={{ fontSize: 12.5, minWidth: 0, overflowWrap: "anywhere" }}>
            {check.name}
            {check.isRequired ? <span className="chip muted" style={{ marginLeft: 7 }}>required</span> : null}
          </span>
          <span style={{ display: "flex", gap: 9, alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {(check.conclusion ?? check.state).toLowerCase()}
            </span>
            {check.url ? (
              <a href={check.url} target="_blank" rel="noreferrer noopener" className="muted" style={{ fontSize: 11.5 }}>
                logs ↗
              </a>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
