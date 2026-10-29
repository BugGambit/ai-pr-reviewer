"use client";

import { useState } from "react";
import { apiPrPath, postJson } from "@/lib/client";
import { ErrorBox, Spinner } from "@/components/ui";
import { ApprovalResult } from "./ApprovalResult";
import type { AppConfig, PrDetail, SuggestedReviewComment } from "@/lib/types";

interface ActionStep {
  step: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

function StepList({ steps }: { steps: ActionStep[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 11 }}>
      {steps.map((step, index) => (
        <div
          key={`${step.step}-${index}`}
          style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 8, fontSize: 12.5 }}
        >
          <span
            aria-hidden
            style={{ color: step.skipped ? "var(--ink-muted)" : step.ok ? "var(--status-good)" : "var(--status-critical)" }}
          >
            {step.skipped ? "–" : step.ok ? "✓" : "✕"}
          </span>
          <div>
            <span>{step.step}</span>
            {!step.ok || step.skipped ? (
              <div className="muted mono" style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>
                {step.detail}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ActionBar({
  pr,
  approval,
  pendingComments,
  onClearPending,
  onDone,
}: {
  pr: PrDetail;
  approval: AppConfig["approval"];
  pendingComments: SuggestedReviewComment[];
  onClearPending: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"none" | "approve" | "changes" | "comment">("none");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<ActionStep[] | null>(null);
  const [approvedSteps, setApprovedSteps] = useState<ActionStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");

  const base = apiPrPath(pr.owner, pr.repo, pr.number);

  const run = async (
    fn: () => Promise<{ ok: boolean; steps: ActionStep[] }>,
    kind: "approve" | "other" = "other",
  ) => {
    setBusy(true);
    setError(null);
    setSteps(null);
    setApprovedSteps(null);
    try {
      const result = await fn();
      if (kind === "approve") {
        // Approval gets a persistent panel that keeps watching the merge gate,
        // rather than a transient tick that vanishes.
        setApprovedSteps(result.steps);
        setMode("none");
      } else {
        setSteps(result.steps);
      }
      if (result.ok) {
        setBody("");
        onClearPending();
        setTimeout(onDone, 900);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
        {pr.viewerHasApproved && !approvedSteps ? (
          <span
            className="chip"
            style={{
              color: "var(--status-good)",
              borderColor: "var(--status-good)",
              background: "color-mix(in srgb, var(--status-good) 12%, transparent)",
              padding: "7px 13px",
              fontSize: 13,
            }}
          >
            <span aria-hidden>✓</span> You approved this PR
          </span>
        ) : null}
        {/* An approval can stop counting (new commits, stricter policy-bot rules),
            so approving again has to stay possible. */}
        <button
          type="button"
          className="btn btn-approve"
          disabled={busy}
          onClick={() => setMode(mode === "approve" ? "none" : "approve")}
        >
          {busy && mode === "approve" ? <Spinner /> : <span aria-hidden>✓</span>}
          {pr.viewerHasApproved ? "Re-approve" : "Risk-approve"}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => setMode(mode === "changes" ? "none" : "changes")}
        >
          Request changes
          {pendingComments.length > 0 ? ` (${pendingComments.length})` : ""}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => setMode(mode === "comment" ? "none" : "comment")}
        >
          Comment
        </button>

        <a className="btn" href={pr.url} target="_blank" rel="noreferrer noopener" style={{ marginLeft: "auto" }}>
          Open on GitHub ↗
        </a>
      </div>

      {mode === "approve" ? (
        <div
          style={{
            marginTop: 14,
            padding: "13px 15px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
          }}
        >
          <strong style={{ fontSize: 13 }}>This will run your risk-review sequence:</strong>
          <ol className="secondary" style={{ fontSize: 12.5, margin: "8px 0 12px", paddingLeft: 20 }}>
            {approval.approve ? <li>Approve the PR on GitHub</li> : null}
            {approval.assignSelf ? <li>Add yourself as assignee</li> : null}
            {approval.labels.length > 0 ? (
              <li>
                Add label{approval.labels.length > 1 ? "s" : ""}{" "}
                {approval.labels.map((label, index) => (
                  <span key={label}>
                    {index > 0 ? (index === approval.labels.length - 1 ? " and " : ", ") : ""}
                    <code>{label}</code>
                  </span>
                ))}{" "}
                <span className="muted">(one operation)</span>
              </li>
            ) : null}
            {approval.removeLabels.length > 0 ? (
              <li>
                Remove{" "}
                {approval.removeLabels.map((label, index) => (
                  <span key={label}>
                    {index > 0 ? (index === approval.removeLabels.length - 1 ? " and " : ", ") : ""}
                    <code>{label}</code>
                  </span>
                ))}{" "}
                <span className="muted">if present</span>
              </li>
            ) : null}
            {approval.comment ? (
              <li>
                Comment <code>{approval.comment}</code>
              </li>
            ) : null}
          </ol>
          <div style={{ display: "flex", gap: 9 }}>
            <button
              type="button"
              className="btn btn-approve"
              disabled={busy}
              onClick={() => void run(() => postJson(`${base}/approve`, {}), "approve")}
            >
              {busy ? <Spinner /> : null}
              Confirm approval
            </button>
            <button type="button" className="btn" onClick={() => setMode("none")} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode === "changes" || mode === "comment" ? (
        <div style={{ marginTop: 14 }}>
          {pendingComments.length > 0 && mode === "changes" ? (
            <div
              style={{
                marginBottom: 11,
                padding: "10px 13px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                <strong style={{ fontSize: 12.5 }}>
                  {pendingComments.length} inline comment{pendingComments.length === 1 ? "" : "s"} attached
                </strong>
                <button type="button" className="btn btn-sm" onClick={onClearPending}>
                  Clear
                </button>
              </div>
              {pendingComments.map((comment, index) => (
                <div key={`${comment.file}-${comment.line}-${index}`} className="mono muted" style={{ fontSize: 11.5 }}>
                  {comment.file}:{comment.line} — {comment.body.slice(0, 80)}
                  {comment.body.length > 80 ? "…" : ""}
                </div>
              ))}
            </div>
          ) : null}

          <textarea
            className="textarea"
            placeholder={
              mode === "changes"
                ? "What needs to change, and why?"
                : "Leave a comment on this pull request…"
            }
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div style={{ display: "flex", gap: 9, marginTop: 9 }}>
            <button
              type="button"
              className={mode === "changes" ? "btn btn-danger" : "btn btn-primary"}
              disabled={busy || (!body.trim() && pendingComments.length === 0)}
              onClick={() =>
                void run(() =>
                  mode === "changes"
                    ? postJson(`${base}/review-action`, {
                        event: "REQUEST_CHANGES",
                        body,
                        comments: pendingComments,
                      })
                    : postJson(`${base}/comment`, { body }),
                )
              }
            >
              {busy ? <Spinner /> : null}
              {mode === "changes" ? "Submit review" : "Post comment"}
            </button>
            <button type="button" className="btn" onClick={() => setMode("none")} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div style={{ marginTop: 12 }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      {steps ? <StepList steps={steps} /> : null}

      {approvedSteps ? (
        <ApprovalResult
          owner={pr.owner}
          repo={pr.repo}
          number={pr.number}
          steps={approvedSteps}
          onDismiss={() => setApprovedSteps(null)}
        />
      ) : null}
    </div>
  );
}
