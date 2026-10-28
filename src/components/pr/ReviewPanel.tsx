"use client";

import { useState } from "react";
import { Mermaid } from "@/components/Mermaid";
import {
  Collapsible,
  Empty,
  ErrorBox,
  Markdown,
  RiskHero,
  SeverityBadge,
  Section,
  Spinner,
  VERDICT_META,
} from "@/components/ui";
import type {
  ReviewResult,
  HeuristicReport,
  HeuristicSignal,
  JobState,
  ReviewFinding,
  StoredReview,
} from "@/lib/types";

function FindingCard({
  finding,
  onUseAsComment,
}: {
  finding: ReviewFinding;
  onUseAsComment?: (finding: ReviewFinding) => void;
}) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
      }}
    >
      <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <SeverityBadge severity={finding.severity} />
        <strong style={{ fontSize: 13.5 }}>{finding.title}</strong>
        <span className="chip muted">{finding.category}</span>
        {finding.file ? (
          <span className="mono muted">
            {finding.file}
            {finding.line ? `:${finding.line}` : ""}
          </span>
        ) : null}
      </div>

      <div className="secondary" style={{ fontSize: 13, lineHeight: 1.6 }}>
        {finding.detail}
      </div>

      {finding.suggestion ? (
        <div
          style={{
            marginTop: 9,
            padding: "8px 11px",
            borderLeft: "3px solid var(--series-1)",
            background: "var(--surface-0)",
            borderRadius: "0 6px 6px 0",
            fontSize: 12.5,
          }}
        >
          <span className="muted">Suggested fix: </span>
          {finding.suggestion}
        </div>
      ) : null}

      {finding.suggestedCode ? (
        <pre
          className="mono"
          style={{
            margin: "9px 0 0",
            padding: 11,
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            overflowX: "auto",
            color: "var(--ink-secondary)",
          }}
        >
          {finding.suggestedCode}
        </pre>
      ) : null}

      {onUseAsComment && finding.file && finding.line ? (
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginTop: 9 }}
          onClick={() => onUseAsComment(finding)}
        >
          Use as review comment
        </button>
      ) : null}
    </div>
  );
}

function SignalList({ signals }: { signals: HeuristicSignal[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? signals : signals.slice(0, 6);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {shown.map((signal, index) => (
        <div
          key={`${signal.title}-${signal.file}-${signal.line}-${index}`}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "baseline",
            padding: "8px 11px",
            background: "var(--surface-2)",
            borderRadius: 7,
            border: "1px solid var(--border)",
          }}
        >
          <SeverityBadge severity={signal.severity} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13 }}>{signal.title}</div>
            {signal.file ? (
              <div className="mono muted">
                {signal.file}
                {signal.line ? `:${signal.line}` : ""}
              </div>
            ) : null}
            {signal.evidence ? (
              <div
                className="mono"
                style={{
                  marginTop: 4,
                  color: "var(--ink-secondary)",
                  background: "var(--surface-0)",
                  padding: "4px 8px",
                  borderRadius: 5,
                  overflowX: "auto",
                  whiteSpace: "pre",
                }}
              >
                {signal.evidence}
              </div>
            ) : null}
          </div>
        </div>
      ))}
      {signals.length > 6 ? (
        <button type="button" className="btn btn-sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show all ${signals.length}`}
        </button>
      ) : null}
    </div>
  );
}

const CHECK_STATUS: Record<string, { icon: string; color: string }> = {
  ok: { icon: "✓", color: "var(--status-good)" },
  warn: { icon: "!", color: "var(--status-warning)" },
  fail: { icon: "✕", color: "var(--status-critical)" },
  na: { icon: "–", color: "var(--ink-muted)" },
};

/**
 * What the reader sees while the model is still writing. The schema emits the
 * verdict and headline first, so this is usually populated within a few seconds
 * of starting — long before the diagrams and checklist land.
 */
function StreamingPreview({ partial, message }: { partial: Partial<ReviewResult>; message: string }) {
  const hasVerdict = Boolean(partial.verdict);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="spinner" />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {message || "Analysing…"}
        </span>
      </div>

      {hasVerdict ? (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
          <RiskHero
            score={typeof partial.riskScore === "number" ? partial.riskScore : 0}
            verdict={partial.verdict!}
          />
          <div style={{ flex: 1, minWidth: 260 }}>
            {partial.oneLiner ? (
              <p style={{ margin: "0 0 9px", fontSize: 16, fontWeight: 550, lineHeight: 1.45 }}>
                {partial.oneLiner}
              </p>
            ) : (
              <p className="muted pulse" style={{ margin: "0 0 9px", fontSize: 14 }}>
                writing the summary…
              </p>
            )}
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              Preliminary — the full review is still being written.
            </p>
          </div>
        </div>
      ) : null}

      {partial.summary ? <Markdown>{partial.summary}</Markdown> : null}

      {partial.securityFlags?.length ? (
        <div>
          <h3 style={{ fontSize: 13.5, margin: "0 0 9px", color: "var(--status-critical)" }}>
            ⚠ Security concerns so far ({partial.securityFlags.length})
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {partial.securityFlags.filter((f) => f?.title).map((flag, index) => (
              <FindingCard key={`${flag.title}-${index}`} finding={flag} />
            ))}
          </div>
        </div>
      ) : null}

      {partial.findings?.length ? (
        <div>
          <h3 style={{ fontSize: 13.5, margin: "0 0 9px" }}>Findings so far ({partial.findings.length})</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {partial.findings.filter((f) => f?.title).map((finding, index) => (
              <FindingCard key={`${finding.title}-${index}`} finding={finding} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ReviewPanel({
  review,
  heuristics,
  job,
  onRun,
  onUseAsComment,
  busy,
}: {
  review: StoredReview | null;
  heuristics: HeuristicReport | null;
  job: JobState | null;
  onRun: (opts: { force: boolean; mode: "standard" | "deep" }) => void;
  onUseAsComment: (finding: ReviewFinding) => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState<"standard" | "deep">("standard");
  const running = job?.status === "running" || review?.status === "running";
  const result = review?.result ?? null;

  const injectionHits = heuristics?.injectionSuspects ?? [];

  const runButtons = (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <select
        className="select"
        style={{ width: 150 }}
        value={mode}
        onChange={(e) => setMode(e.target.value as "standard" | "deep")}
        disabled={running}
      >
        <option value="standard">Standard (diff only)</option>
        <option value="deep">Deep (clone repo)</option>
      </select>
      <button
        type="button"
        className="btn btn-primary"
        disabled={running || busy}
        onClick={() => onRun({ force: Boolean(result), mode })}
      >
        {running ? <Spinner /> : null}
        {running ? "Reviewing…" : result ? "Re-run review" : "Run Claude review"}
      </button>
    </div>
  );

  return (
    <>
      {/* The injection banner is driven by the deterministic scanner, so it
          shows even when no model review has run. */}
      {injectionHits.length > 0 ? (
        <div
          style={{
            padding: "14px 16px",
            marginBottom: 16,
            borderRadius: 9,
            border: "2px solid var(--status-critical)",
            background: "color-mix(in srgb, var(--status-critical) 13%, transparent)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              color: "var(--status-critical)",
              fontWeight: 650,
              fontSize: 14,
              marginBottom: 7,
            }}
          >
            <span aria-hidden>⛔</span>
            Possible prompt-injection in this PR
          </div>
          <p className="secondary" style={{ margin: "0 0 11px", fontSize: 13 }}>
            This PR&rsquo;s text matches patterns used to manipulate automated reviewers. Treat any AI summary
            below as unreliable and review this PR by hand.
          </p>
          <SignalList signals={injectionHits} />
        </div>
      ) : null}

      <Section
        title="Claude review"
        subtitle={
          review?.status === "done"
            ? `${review.mode} mode · ${review.model ?? "model"} · $${(review.costUsd ?? 0).toFixed(3)} · cached for this commit`
            : "Runs once per commit — re-running costs tokens."
        }
        action={runButtons}
      >
        {running ? (
          <div style={{ padding: "6px 0" }}>
            {job?.partial ? (
              <StreamingPreview partial={job.partial} message={job.message} />
            ) : (
              <Spinner label={job?.message ?? "Working…"} />
            )}
            {job?.logs?.length ? (
              <details style={{ marginTop: 14 }}>
                <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                  Progress log
                </summary>
                <pre
                  className="mono"
                  style={{
                    marginTop: 8,
                    maxHeight: 180,
                    overflowY: "auto",
                    padding: 11,
                    background: "var(--surface-0)",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    color: "var(--ink-secondary)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {job.logs.slice(-40).join("\n")}
                </pre>
              </details>
            ) : null}
          </div>
        ) : review?.status === "error" ? (
          <ErrorBox>{review.error ?? "The review failed."}</ErrorBox>
        ) : !result ? (
          <Empty>
            No review yet for this commit. Run one to get a plain-language summary, diagrams and a risk verdict.
          </Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Verdict + headline */}
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
              <RiskHero score={result.riskScore} verdict={result.verdict} />
              <div style={{ flex: 1, minWidth: 260 }}>
                <p
                  style={{
                    margin: "0 0 9px",
                    fontSize: 16,
                    fontWeight: 550,
                    lineHeight: 1.45,
                  }}
                >
                  {result.oneLiner}
                </p>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    color: VERDICT_META[result.verdict].color,
                  }}
                >
                  {VERDICT_META[result.verdict].blurb} Confidence: {result.confidence}.
                </p>
              </div>
            </div>

            {result.summary ? <Markdown>{result.summary}</Markdown> : null}

            {/* Does the description match the code? */}
            <div
              style={{
                padding: "11px 14px",
                borderRadius: 8,
                border: `1px solid ${result.descriptionAccuracy.matchesCode ? "var(--border)" : "var(--status-warning)"}`,
                background: result.descriptionAccuracy.matchesCode
                  ? "var(--surface-2)"
                  : "color-mix(in srgb, var(--status-warning) 10%, transparent)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <span
                  aria-hidden
                  style={{ color: result.descriptionAccuracy.matchesCode ? "var(--status-good)" : "var(--status-warning)" }}
                >
                  {result.descriptionAccuracy.matchesCode ? "✓" : "!"}
                </span>
                <strong style={{ fontSize: 13 }}>
                  {result.descriptionAccuracy.matchesCode
                    ? "The description matches the code"
                    : "The description does not fully match the code"}
                </strong>
              </div>
              <div className="secondary" style={{ fontSize: 12.5 }}>
                {result.descriptionAccuracy.notes || "No discrepancies noted."}
              </div>
            </div>

            {/* What changed, by area */}
            {result.whatChanged.length > 0 ? (
              <div>
                <h3 style={{ fontSize: 13.5, margin: "0 0 10px" }}>What changed</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {result.whatChanged.map((area) => (
                    <div
                      key={area.area}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "6px 1fr",
                        gap: 12,
                        padding: "10px 12px",
                        background: "var(--surface-2)",
                        borderRadius: 8,
                        border: "1px solid var(--border)",
                      }}
                    >
                      <div
                        style={{
                          background:
                            area.impact === "high"
                              ? "var(--status-serious)"
                              : area.impact === "medium"
                                ? "var(--status-warning)"
                                : "var(--series-1)",
                          borderRadius: 3,
                        }}
                        aria-hidden
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 3 }}>
                          <strong style={{ fontSize: 13 }}>{area.area}</strong>
                          <span className="chip muted">{area.impact} impact</span>
                        </div>
                        <div className="secondary" style={{ fontSize: 12.5 }}>
                          {area.description}
                        </div>
                        {area.files?.length ? (
                          <div className="mono muted" style={{ marginTop: 5 }}>
                            {area.files.slice(0, 6).join(" · ")}
                            {area.files.length > 6 ? ` · +${area.files.length - 6} more` : ""}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Diagrams */}
            {result.diagrams.length > 0 ? (
              <div>
                <h3 style={{ fontSize: 13.5, margin: "0 0 10px" }}>Diagrams</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  {result.diagrams.map((diagram, index) => (
                    <div key={`${diagram.title}-${index}`}>
                      <Mermaid chart={diagram.mermaid} title={diagram.title} />
                      {diagram.caption ? (
                        <p className="muted" style={{ fontSize: 12.5, margin: "7px 0 0" }}>
                          {diagram.caption}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Blast radius */}
            <Collapsible
              title="Blast radius"
              badge={
                [
                  result.blastRadius.userFacing && "user-facing",
                  result.blastRadius.breakingChange && "breaking",
                  result.blastRadius.dataMigration && "migration",
                  result.blastRadius.apiChange && "API change",
                ]
                  .filter(Boolean)
                  .join(" · ") || "internal only"
              }
            >
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 9 }}>
                {[
                  ["User-facing", result.blastRadius.userFacing],
                  ["Data migration", result.blastRadius.dataMigration],
                  ["API change", result.blastRadius.apiChange],
                  ["Breaking change", result.blastRadius.breakingChange],
                ].map(([label, active]) => (
                  <span
                    key={String(label)}
                    className="chip"
                    style={{
                      color: active ? "var(--status-serious)" : "var(--ink-muted)",
                      borderColor: active ? "var(--status-serious)" : "var(--border)",
                    }}
                  >
                    <span aria-hidden>{active ? "●" : "○"}</span>
                    {label}
                  </span>
                ))}
              </div>
              <div className="secondary" style={{ fontSize: 12.5 }}>
                {result.blastRadius.scope} {result.blastRadius.notes}
              </div>
            </Collapsible>

            {/* Security flags */}
            {result.securityFlags.length > 0 ? (
              <div>
                <h3 style={{ fontSize: 13.5, margin: "0 0 10px", color: "var(--status-critical)" }}>
                  ⚠ Security concerns ({result.securityFlags.length})
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {result.securityFlags.map((flag, index) => (
                    <FindingCard key={`${flag.title}-${index}`} finding={flag} onUseAsComment={onUseAsComment} />
                  ))}
                </div>
              </div>
            ) : null}

            {/* Findings */}
            {result.findings.length > 0 ? (
              <div>
                <h3 style={{ fontSize: 13.5, margin: "0 0 10px" }}>Findings ({result.findings.length})</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {result.findings.map((finding, index) => (
                    <FindingCard
                      key={`${finding.title}-${index}`}
                      finding={finding}
                      onUseAsComment={onUseAsComment}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 13 }}>
                No code findings were raised.
              </div>
            )}

            {/* Dependencies */}
            {result.dependencyChanges.length > 0 ? (
              <Collapsible
                title="Dependency changes"
                badge={`${result.dependencyChanges.length} package(s)${
                  result.dependencyChanges.some((d) => d.concern) ? " · some flagged" : ""
                }`}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr className="muted" style={{ textAlign: "left" }}>
                      <th style={{ padding: "5px 9px" }}>Package</th>
                      <th style={{ padding: "5px 9px" }}>Change</th>
                      <th style={{ padding: "5px 9px" }}>From → To</th>
                      <th style={{ padding: "5px 9px" }}>Concern</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.dependencyChanges.map((dep) => (
                      <tr key={dep.name} style={{ borderTop: "1px solid var(--border)" }}>
                        <td className="mono" style={{ padding: "6px 9px" }}>
                          {dep.name}
                        </td>
                        <td style={{ padding: "6px 9px" }}>{dep.changeType}</td>
                        <td className="mono" style={{ padding: "6px 9px" }}>
                          {dep.from || "—"} → {dep.to || "—"}
                        </td>
                        <td style={{ padding: "6px 9px", color: dep.concern ? "var(--status-warning)" : undefined }}>
                          {dep.concern || "routine"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Collapsible>
            ) : null}

            {/* Checklist */}
            {result.checklist.length > 0 ? (
              <Collapsible
                title="Risk checklist"
                badge={(() => {
                  const bad = result.checklist.filter((c) => c.status === "fail").length;
                  const warn = result.checklist.filter((c) => c.status === "warn").length;
                  return bad || warn
                    ? `${bad ? `${bad} fail · ` : ""}${warn} to check`
                    : "all clear";
                })()}
                tone={
                  result.checklist.some((c) => c.status === "fail") ? "var(--status-critical)" : undefined
                }
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {result.checklist.map((item, index) => {
                    const meta = CHECK_STATUS[item.status] ?? CHECK_STATUS.na;
                    return (
                      <div
                        key={`${item.item}-${index}`}
                        style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 9, padding: "4px 0" }}
                      >
                        <span aria-hidden style={{ color: meta.color, fontWeight: 700 }}>
                          {meta.icon}
                        </span>
                        <div>
                          <span style={{ fontSize: 12.5 }}>{item.item}</span>
                          {item.note ? (
                            <span className="muted" style={{ fontSize: 12.5 }}>
                              {" "}
                              — {item.note}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Collapsible>
            ) : null}

            {/* Tests */}
            <Collapsible
              title="Test coverage"
              badge={result.testCoverage.assessment.replace("_", " ")}
              tone={
                result.testCoverage.assessment === "none" ? "var(--status-warning)" : undefined
              }
            >
              <div className="secondary" style={{ fontSize: 12.5 }}>
                {result.testCoverage.notes}
              </div>
            </Collapsible>
          </div>
        )}
      </Section>

      {heuristics && heuristics.signals.length > 0 ? (
        <section className="card" style={{ padding: "4px 18px 10px", marginBottom: 16 }}>
          <Collapsible
            title="Static pre-scan"
            badge={`${heuristics.signals.length} pattern match(es) — leads to confirm, not conclusions`}
          >
            <SignalList signals={heuristics.signals} />
          </Collapsible>
        </section>
      ) : null}
    </>
  );
}
