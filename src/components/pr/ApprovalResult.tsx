"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { apiPrPath, fetcher } from "@/lib/client";
import { Spinner } from "@/components/ui";
import type { CheckRun } from "@/lib/types";

interface ChecksResponse {
  state: string;
  mergeable: string;
  reviewDecision: string | null;
  viewerHasApproved: boolean;
  checkState: string;
  gateCheck: CheckRun | null;
  gateCheckName: string;
}

interface Step {
  step: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

function Line({
  state,
  label,
  detail,
}: {
  state: "ok" | "pending" | "fail" | "skip";
  label: string;
  detail?: string;
}) {
  const color =
    state === "ok"
      ? "var(--status-good)"
      : state === "fail"
        ? "var(--status-critical)"
        : state === "pending"
          ? "var(--status-warning)"
          : "var(--ink-muted)";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 9, alignItems: "baseline" }}>
      <span aria-hidden style={{ color, fontWeight: 700, fontSize: 13 }}>
        {state === "ok" ? "✓" : state === "fail" ? "✕" : state === "pending" ? "◷" : "–"}
      </span>
      <div>
        <span style={{ fontSize: 12.5 }}>{label}</span>
        {detail ? (
          <div className="muted mono" style={{ fontSize: 11, whiteSpace: "pre-wrap", marginTop: 2 }}>
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What you see after the approval sequence runs. Approving is only half the
 * job — the PR isn't actually mergeable until the policy gate re-evaluates, so
 * this keeps watching until that check reports, rather than dropping you back
 * into a UI that looks untouched.
 */
export function ApprovalResult({
  owner,
  repo,
  number,
  steps,
  onDismiss,
}: {
  owner: string;
  repo: string;
  number: number;
  steps: Step[];
  onDismiss: () => void;
}) {
  const [watching, setWatching] = useState(true);

  const { data } = useSWR<ChecksResponse>(
    `${apiPrPath(owner, repo, number)}/checks`,
    fetcher,
    { refreshInterval: watching ? 8000 : 0, revalidateOnFocus: false },
  );

  const gate = data?.gateCheck ?? null;
  const gateSettled = gate ? gate.state === "SUCCESS" || gate.state === "FAILURE" || gate.state === "ERROR" : false;

  // Stop polling once the gate settles, or after five minutes of nothing.
  useEffect(() => {
    if (gateSettled) setWatching(false);
    const stop = setTimeout(() => setWatching(false), 5 * 60_000);
    return () => clearTimeout(stop);
  }, [gateSettled]);

  const allOk = steps.every((s) => s.ok);
  const approved = data?.viewerHasApproved ?? allOk;

  const gateState: "ok" | "pending" | "fail" | "skip" = !gate
    ? watching
      ? "pending"
      : "skip"
    : gate.state === "SUCCESS"
      ? "ok"
      : gate.state === "FAILURE" || gate.state === "ERROR"
        ? "fail"
        : "pending";

  const tone = !allOk || gateState === "fail" ? "var(--status-critical)" : approved ? "var(--status-good)" : "var(--status-warning)";

  return (
    <div
      style={{
        marginTop: 14,
        padding: "14px 16px",
        borderRadius: 9,
        border: `1px solid ${tone}`,
        background: `color-mix(in srgb, ${tone} 10%, transparent)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11 }}>
        <span aria-hidden style={{ fontSize: 17, color: tone }}>
          {!allOk ? "!" : approved ? "✓" : "◷"}
        </span>
        <strong style={{ fontSize: 14, color: tone }}>
          {!allOk
            ? "Approval sequence finished with problems"
            : gateState === "ok"
              ? "Approved and cleared to merge"
              : gateState === "fail"
                ? "Approved, but the merge gate is red"
                : "Approved — waiting for the merge gate"}
        </strong>
        <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {steps.map((step, index) => (
          <Line
            key={`${step.step}-${index}`}
            state={step.skipped ? "skip" : step.ok ? "ok" : "fail"}
            label={step.step}
            detail={step.ok && !step.skipped ? undefined : step.detail}
          />
        ))}

        <div style={{ height: 1, background: "var(--border)", margin: "5px 0" }} />

        <Line
          state={approved ? "ok" : "pending"}
          label={approved ? "GitHub shows your approval" : "Confirming your approval on GitHub…"}
        />

        <Line
          state={gateState}
          label={
            gate
              ? `${gate.name} — ${(gate.conclusion ?? gate.state).toLowerCase()}`
              : watching
                ? `Waiting for ${data?.gateCheckName ?? "the merge gate"} to report…`
                : `No ${data?.gateCheckName ?? "merge gate"} check on this PR`
          }
        />

        {data?.mergeable ? (
          <Line
            state={data.mergeable === "MERGEABLE" ? "ok" : data.mergeable === "CONFLICTING" ? "fail" : "pending"}
            label={
              data.mergeable === "MERGEABLE"
                ? "Mergeable"
                : data.mergeable === "CONFLICTING"
                  ? "Has merge conflicts"
                  : "Mergeability still being computed"
            }
          />
        ) : null}
      </div>

      {watching && !gateSettled ? (
        <div style={{ marginTop: 11 }}>
          <Spinner label="Re-checking every few seconds — safe to navigate away" />
        </div>
      ) : null}
    </div>
  );
}
