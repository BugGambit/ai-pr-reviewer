"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { apiPrPath, fetcher, postJson, relativeTime } from "@/lib/client";
import {
  CheckBadge,
  Collapsible,
  Empty,
  ErrorBox,
  LabelChip,
  Markdown,
  Section,
  Spinner,
  VerdictBadge,
} from "@/components/ui";
import { ChurnBars, DiffStat, FileKindBar } from "@/components/charts";
import { GitHubBody } from "@/components/GitHubBody";
import { ReviewPanel } from "@/components/pr/ReviewPanel";
import { SincePanel } from "@/components/pr/SincePanel";
import { ActionBar } from "@/components/pr/ActionBar";
import { DiffViewer } from "@/components/pr/DiffViewer";
import { ChecksList, CommitList, Conversation } from "@/components/pr/Conversation";
import { Screenshots } from "@/components/pr/Screenshots";
import { StackView } from "@/components/pr/StackView";
import type {
  AppConfig,
  HeuristicReport,
  JobState,
  PrDetail,
  ReviewFinding,
  ScreenshotRecord,
  StoredReview,
  SuggestedReviewComment,
} from "@/lib/types";

interface DetailResponse {
  pr: PrDetail;
  heuristics: HeuristicReport;
  review: StoredReview | null;
  staleReview: StoredReview | null;
  history: StoredReview[];
  screenshots: ScreenshotRecord[];
  approvalConfig: AppConfig["approval"];
  reviewConfig: AppConfig["review"];
  screenshotConfigured: boolean;
}

type Tab = "overview" | "files" | "conversation" | "commits" | "checks" | "visual";

export default function PrDetailPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; number: string }>;
}) {
  const { owner, repo, number } = use(params);
  const base = apiPrPath(owner, repo, Number(number));

  const [tab, setTab] = useState<Tab>("overview");
  const [pending, setPending] = useState<SuggestedReviewComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, isLoading, mutate } = useSWR<DetailResponse>(base, fetcher, {
    revalidateOnFocus: false,
  });

  // Poll the job endpoints only while something is actually in flight.
  const { data: reviewJob, mutate: mutateReview } = useSWR<{
    review: StoredReview | null;
    job: JobState | null;
  }>(`${base}/review`, fetcher, {
    // Fast while a review streams; still polling when idle, because a review
    // can start without this tab asking for it — background prefetch, or
    // another tab. Dropping to 0 here means a started review is never noticed.
    refreshInterval: (latest) => (latest?.job?.status === "running" ? 900 : 5000),
  });
  const { data: shotJob, mutate: mutateShots } = useSWR<{
    screenshots: ScreenshotRecord[];
    job: JobState | null;
  }>(`${base}/screenshots`, fetcher, {
    refreshInterval: (latest) => (latest?.job?.status === "running" ? 3000 : 0),
  });

  const review = reviewJob?.review ?? data?.review ?? null;
  const job = reviewJob?.job ?? null;
  const wasRunning = job?.status === "running";

  const runReview = useCallback(
    async (opts: { force: boolean; mode: "standard" | "deep" }) => {
      setBusy(true);
      setActionError(null);
      try {
        await postJson(`${base}/review`, opts);
        // Revalidate the review key itself, not just the detail payload, so the
        // streaming preview appears immediately rather than on the next tick.
        await mutateReview();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [base, mutateReview],
  );

  const captureShots = useCallback(async () => {
    setActionError(null);
    try {
      await postJson(`${base}/screenshots`, {});
      await mutateShots();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [base, mutateShots]);

  // Opening a PR is the signal that you intend to review it, so the review
  // starts here rather than waiting for a button press. It is still cached per
  // commit, so this costs nothing on a second visit.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !data) return;
    if (!data.reviewConfig?.autoReviewOnOpen) return;
    if (review || reviewJob?.job?.status === "running") return;

    autoStarted.current = true;
    void runReview({ force: false, mode: data.reviewConfig.mode });
  }, [data, review, reviewJob?.job?.status, runReview]);

  const addPending = useCallback((comment: SuggestedReviewComment) => {
    setPending((current) => [...current, comment]);
  }, []);

  const useFindingAsComment = useCallback(
    (finding: ReviewFinding) => {
      if (!finding.file || !finding.line) return;
      addPending({
        file: finding.file,
        line: finding.line,
        body: `**${finding.title}**\n\n${finding.detail}${finding.suggestion ? `\n\n${finding.suggestion}` : ""}`,
        suggestedCode: finding.suggestedCode,
      });
    },
    [addPending],
  );

  if (isLoading) {
    return (
      <div className="card" style={{ padding: 44, textAlign: "center" }}>
        <Spinner label={`Loading ${owner}/${repo} #${number}…`} />
      </div>
    );
  }

  if (error || !data) {
    return <ErrorBox>{String((error as Error)?.message ?? "Could not load this pull request.")}</ErrorBox>;
  }

  const { pr, heuristics } = data;
  const shots = shotJob?.screenshots ?? data.screenshots;

  const tabs: { id: Tab; label: string; badge?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "files", label: "Files", badge: String(pr.changedFiles) },
    { id: "conversation", label: "Conversation", badge: String(pr.comments.length + pr.reviews.length) },
    { id: "commits", label: "Commits", badge: String(pr.commits.length) },
    {
      id: "checks",
      label: "Checks",
      badge: pr.failingChecks.length > 0 ? `${pr.failingChecks.length} failing` : String(pr.checks.length),
    },
    { id: "visual", label: "Visual proof", badge: shots.length > 0 ? String(shots.length) : undefined },
  ];

  return (
    <>
      {/* ------------------------------ header ------------------------------ */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 7 }}>
          <span className="mono muted">
            {pr.owner}/{pr.repo} #{pr.number}
          </span>
          <span
            className="chip"
            style={{
              color: pr.state === "MERGED" ? "var(--series-7)" : pr.state === "CLOSED" ? "var(--status-critical)" : "var(--status-good)",
            }}
          >
            {pr.state.toLowerCase()}
          </span>
          {pr.isDraft ? <span className="chip">draft</span> : null}
          <CheckBadge
            state={pr.checkState}
            detail={pr.failingChecks.length > 0 ? `${pr.failingChecks.length} checks failing` : undefined}
          />
          {review?.result ? <VerdictBadge verdict={review.result.verdict} size="sm" /> : null}
        </div>

        <h1 style={{ margin: "0 0 9px", fontSize: 23, fontWeight: 650, lineHeight: 1.3 }}>{pr.title}</h1>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", fontSize: 12.5 }} className="muted">
          <span>@{pr.author.login}</span>
          <span>opened {relativeTime(pr.createdAt)}</span>
          <span>
            <span className="mono">{pr.headRefName}</span> → <span className="mono">{pr.baseRefName}</span>
          </span>
          <DiffStat additions={pr.additions} deletions={pr.deletions} />
          <span>{pr.changedFiles} files</span>
          {pr.labels.map((label) => (
            <LabelChip key={label.name} name={label.name} color={label.color} />
          ))}
        </div>
      </div>

      <ActionBar
        pr={pr}
        approval={data.approvalConfig}
        pendingComments={pending}
        onClearPending={() => setPending([])}
        onDone={() => void mutate()}
      />

      {actionError ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorBox>{actionError}</ErrorBox>
        </div>
      ) : null}

      {/* ------------------------------- tabs ------------------------------- */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 16,
          borderBottom: "1px solid var(--border)",
          overflowX: "auto",
        }}
      >
        {tabs.map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => setTab(item.id)}
            style={{
              padding: "9px 14px",
              border: "none",
              background: "none",
              color: tab === item.id ? "var(--ink-primary)" : "var(--ink-muted)",
              borderBottom: `2px solid ${tab === item.id ? "var(--series-1)" : "transparent"}`,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: tab === item.id ? 600 : 500,
              whiteSpace: "nowrap",
            }}
          >
            {item.label}
            {item.badge ? (
              <span className="chip" style={{ marginLeft: 7, fontSize: 10.5 }}>
                {item.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* ------------------------------ content ----------------------------- */}
      {tab === "overview" ? (
        <>
          <StackView owner={owner} repo={repo} number={Number(number)} />

          <SincePanel base={base} autoRun={Boolean(data.reviewConfig?.autoReviewOnOpen)} />

          {!review && data.staleReview ? (
            <div
              style={{
                padding: "11px 14px",
                marginBottom: 16,
                borderRadius: 8,
                border: "1px solid var(--status-warning)",
                background: "color-mix(in srgb, var(--status-warning) 10%, transparent)",
                fontSize: 12.5,
                color: "var(--status-warning)",
              }}
            >
              <span aria-hidden>!</span> The last review read commit{" "}
              <span className="mono">{data.staleReview.headSha.slice(0, 8)}</span>, but the PR is now at{" "}
              <span className="mono">{pr.headSha.slice(0, 8)}</span>. Re-run the review to cover the new commits.
            </div>
          ) : null}

          <ReviewPanel
            review={review ?? data.staleReview}
            heuristics={heuristics}
            job={job}
            onRun={runReview}
            onUseAsComment={useFindingAsComment}
            busy={busy}
          />

          {(review ?? data.staleReview)?.result?.suggestedComments?.length ? (
            <Section
              title={`Suggested review comments (${(review ?? data.staleReview)!.result!.suggestedComments.length})`}
              subtitle="Attach the ones you agree with, then submit them as a review."
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {(review ?? data.staleReview)!.result!.suggestedComments.map((comment, index) => {
                  const attached = pending.some(
                    (p) => p.file === comment.file && p.line === comment.line && p.body === comment.body,
                  );
                  return (
                    <div
                      key={`${comment.file}-${comment.line}-${index}`}
                      style={{
                        padding: "11px 13px",
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                      }}
                    >
                      <div className="mono muted" style={{ marginBottom: 5 }}>
                        {comment.file}:{comment.line}
                      </div>
                      <Markdown>{comment.body}</Markdown>
                      {comment.suggestedCode ? (
                        <pre
                          className="mono"
                          style={{
                            margin: "8px 0 0",
                            padding: 10,
                            background: "var(--surface-0)",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            overflowX: "auto",
                            color: "var(--ink-secondary)",
                          }}
                        >
                          {comment.suggestedCode}
                        </pre>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ marginTop: 9 }}
                        disabled={attached}
                        onClick={() => addPending(comment)}
                      >
                        {attached ? "✓ Attached" : "Attach to review"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </Section>
          ) : null}

          <section className="card" style={{ padding: "4px 18px 10px", marginBottom: 16 }}>
            <Collapsible
              title="Change composition"
              badge={`${pr.changedFiles} files · +${pr.additions} / −${pr.deletions}`}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ fontSize: 12, margin: "0 0 11px" }} className="muted">
                    BY FILE KIND
                  </h3>
                  <FileKindBar files={pr.files} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ fontSize: 12, margin: "0 0 11px" }} className="muted">
                    TOP FILES BY CHURN
                  </h3>
                  <ChurnBars files={pr.files} />
                </div>
              </div>
            </Collapsible>

            <Collapsible
              title="Author's description"
              badge="what the author claims — the review above checks it against the code"
            >
              {pr.body.trim() || pr.bodyHtml.trim() ? (
                <GitHubBody html={pr.bodyHtml} markdown={pr.body} prId={pr.id} />
              ) : (
                <Empty>No description provided.</Empty>
              )}
            </Collapsible>
          </section>
        </>
      ) : null}

      {tab === "files" ? (
        <Section title="Files changed" subtitle={`${pr.changedFiles} files · +${pr.additions} / −${pr.deletions}`}>
          <DiffViewer diff={pr.diff} truncated={pr.diffTruncated} onComment={addPending} />
        </Section>
      ) : null}

      {tab === "conversation" ? (
        <Section title="Conversation">
          <Conversation pr={pr} />
        </Section>
      ) : null}

      {tab === "commits" ? (
        <Section title={`Commits (${pr.commits.length})`}>
          <CommitList pr={pr} />
        </Section>
      ) : null}

      {tab === "checks" ? (
        <Section title="CI checks" subtitle={`Rollup: ${pr.checkState.toLowerCase()}`}>
          <ChecksList pr={pr} />
        </Section>
      ) : null}

      {tab === "visual" ? (
        <Section
          title="Visual proof"
          subtitle="Boot the PR branch locally and capture the pages this change affects."
        >
          <Screenshots
            shots={shots}
            job={shotJob?.job ?? null}
            configured={data.screenshotConfigured}
            suggestions={review?.result?.screenshotSuggestions ?? []}
            onCapture={captureShots}
          />
        </Section>
      ) : null}

      {/* Refresh the page data once a background review finishes. */}
      {wasRunning ? <RefreshOnIdle onIdle={() => void mutate()} running={wasRunning} /> : null}
    </>
  );
}

/** Triggers a single refetch when a tracked job stops running. */
function RefreshOnIdle({ onIdle, running }: { onIdle: () => void; running: boolean }) {
  const [wasRunning, setWasRunning] = useState(running);
  if (wasRunning && !running) {
    setWasRunning(false);
    onIdle();
  } else if (!wasRunning && running) {
    setWasRunning(true);
  }
  return null;
}
