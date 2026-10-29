"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { fetcher, postJson, relativeTime } from "@/lib/client";
import type { FollowupResult, InterdiffFile, JobState, SinceInfo } from "@/lib/types";
import { foldContext } from "@/lib/analysis/interdiff";
import { Collapsible, ErrorBox, Markdown, Section, SeverityBadge, Spinner, VerdictBadge } from "@/components/ui";

type SinceResponse = SinceInfo & { headSha: string; job: JobState | null };

const CHANGE_KIND_LABEL: Record<FollowupResult["changes"][number]["kind"], string> = {
  rebase_conflict: "rebase / conflict",
  ci_fix: "CI fix",
  review_feedback: "review feedback",
  new_behaviour: "new behaviour",
  refactor: "refactor",
  revert: "revert",
  other: "other",
};

function baselineLabel(baseline: NonNullable<SinceInfo["baseline"]>): string {
  if (baseline.kind === "approval") return "your approval";
  if (baseline.kind === "other-approval") return `${baseline.by}'s approval`;
  return "your last review";
}

const CONTEXT = 3;

function InterdiffFileView({ file }: { file: InterdiffFile }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          padding: "8px 12px",
          background: "var(--surface-2)",
          fontSize: 12.5,
        }}
      >
        <span className="mono" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
          {file.path}
        </span>
        {file.status !== "changed" ? <span className="chip muted">{file.status === "new" ? "new in PR" : "left PR"}</span> : null}
        <span className="tabular" style={{ fontSize: 12 }}>
          <span style={{ color: "var(--status-good)" }}>{file.novelLines} new</span>
          {file.revertedLines > 0 ? (
            <span style={{ color: "var(--status-critical)" }}> · {file.revertedLines} gone</span>
          ) : null}
          {file.landedLines > 0 ? <span className="muted"> · {file.landedLines} landed upstream</span> : null}
        </span>
      </div>
      <div style={{ background: "var(--surface-0)", overflowX: "auto" }}>
        {file.hunks.map((hunk, h) => (
          <div key={h}>
            <div className="diff-line diff-hunk">
              <span className="gutter" />
              <span className="gutter" />
              <span style={{ paddingLeft: 8 }}>{hunk.header}</span>
            </div>
            {foldContext(hunk.lines, CONTEXT).map((row, r) => {
              if ("folded" in row) {
                return (
                  <div key={`f${r}`} className="diff-line diff-hunk" style={{ opacity: 0.7 }}>
                    <span className="gutter" />
                    <span className="gutter" />
                    <span style={{ paddingLeft: 8 }}>⋯ {row.folded} line(s) already reviewed</span>
                  </div>
                );
              }
              const { line } = row;
              const change = line.type !== "ctx";
              const cls = change && line.novel ? (line.type === "add" ? "diff-add" : "diff-del") : "";
              return (
                <div
                  key={r}
                  className={`diff-line ${cls}`}
                  style={change && !line.novel ? { opacity: 0.45 } : undefined}
                  title={change && !line.novel ? "Already part of the PR at the baseline" : undefined}
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
              );
            })}
          </div>
        ))}
        {file.reverted.length > 0 ? (
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>
              No longer in the PR:
            </div>
            {file.reverted.map((key, i) => (
              <div key={i} className="mono" style={{ fontSize: 12, textDecoration: "line-through", opacity: 0.7 }}>
                {key}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "What changed since you last looked", compared by the PR's net diff so it
 * survives rebases and force-pushes. Renders nothing when there is no earlier
 * look to compare against.
 */
export function SincePanel({ base, autoRun }: { base: string; autoRun: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data, mutate } = useSWR<SinceResponse>(`${base}/since`, fetcher, {
    revalidateOnFocus: false,
    refreshInterval: (latest) => (latest?.job?.status === "running" ? 900 : 0),
  });

  const run = useCallback(
    async (force: boolean) => {
      setBusy(true);
      setError(null);
      try {
        await postJson(`${base}/since`, { force });
        await mutate();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [base, mutate],
  );

  const running = data?.job?.status === "running";
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !autoRun || !data?.interdiff || data.followup || running) return;
    autoStarted.current = true;
    void run(false);
  }, [autoRun, data, running, run]);

  // A finished job only lands in `followup` after a refetch.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void mutate();
    wasRunning.current = running;
  }, [running, mutate]);

  if (!data?.baseline) return null;
  const { baseline, interdiff } = data;
  const result: Partial<FollowupResult> | null =
    data.followup?.result ?? (running ? (data.job?.followupPartial ?? null) : null);

  const subtitle = `${baseline.sha.slice(0, 8)} → ${data.headSha.slice(0, 8)}${
    baseline.at ? ` · ${baselineLabel(baseline)} ${relativeTime(baseline.at)}` : ""
  } · compared by net diff, so rebases and force-pushes don't add noise`;

  return (
    <Section
      title={`Changed since ${baselineLabel(baseline)}`}
      subtitle={subtitle}
      action={
        interdiff && !interdiff.identical ? (
          <button type="button" className="btn btn-sm" disabled={busy || running} onClick={() => void run(true)}>
            {running ? "Summarising…" : data.followup ? "Re-run" : "Summarise changes"}
          </button>
        ) : null
      }
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {data.unavailable ? <div className="muted" style={{ fontSize: 13 }}>{data.unavailable}</div> : null}

      {interdiff ? (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, fontSize: 12.5 }}>
            {interdiff.identical ? (
              <span className="chip" style={{ color: "var(--status-good)", borderColor: "var(--status-good)" }}>
                ✓ No author changes
              </span>
            ) : (
              <span className="chip">{interdiff.files.length} file(s) with author changes</span>
            )}
            {interdiff.unchangedFiles > 0 ? <span className="chip muted">{interdiff.unchangedFiles} unchanged</span> : null}
            {interdiff.landedFiles.length > 0 ? (
              <span className="chip muted" title={interdiff.landedFiles.join("\n")}>
                {interdiff.landedFiles.length} landed on base branch
              </span>
            ) : null}
            {interdiff.partial ? (
              <span className="chip" style={{ color: "var(--status-warning)" }}>
                ! diff truncated, comparison may be incomplete
              </span>
            ) : null}
          </div>

          {running && !result?.verdict ? <Spinner label={data.job?.message ?? "Summarising the changes…"} /> : null}
          {data.followup?.status === "error" ? <ErrorBox>{data.followup.error}</ErrorBox> : null}

          {result?.verdict ? (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                <VerdictBadge verdict={result.verdict} size="sm" />
                {typeof result.riskScore === "number" ? (
                  <span className="muted tabular" style={{ fontSize: 12 }}>
                    delta risk {result.riskScore}
                  </span>
                ) : null}
                {result.previousReviewStillHolds === false ? (
                  <span className="chip" style={{ color: "var(--status-warning)", borderColor: "var(--status-warning)" }}>
                    earlier verdict no longer holds
                  </span>
                ) : result.previousReviewStillHolds ? (
                  <span className="chip muted">earlier verdict still holds</span>
                ) : null}
              </div>
              {result.oneLiner ? (
                <div style={{ marginBottom: 8, fontWeight: 500 }}>
                  <Markdown>{result.oneLiner}</Markdown>
                </div>
              ) : null}
              {result.changes?.length ? (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                  {result.changes.map((c, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>
                      <span className="chip muted" style={{ marginRight: 6 }}>
                        {CHANGE_KIND_LABEL[c.kind] ?? c.kind}
                      </span>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {c.file}
                      </span>
                      <Markdown>{c.description}</Markdown>
                    </li>
                  ))}
                </ul>
              ) : null}
              {result.concerns?.length ? (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {result.concerns.map((c, i) => (
                    <div key={i} style={{ fontSize: 13 }}>
                      <SeverityBadge severity={c.severity} /> <strong>{c.title}</strong>
                      <div className="muted" style={{ marginTop: 2 }}>
                        <Markdown>{c.detail}</Markdown>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {interdiff.files.length > 0 ? (
            <Collapsible
              title="Interdiff"
              badge={`${interdiff.files.reduce((n, f) => n + f.novelLines, 0)} new change lines`}
              defaultOpen={!result?.verdict}
            >
              {interdiff.files.map((file) => (
                <InterdiffFileView key={file.path} file={file} />
              ))}
            </Collapsible>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
