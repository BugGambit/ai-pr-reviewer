import type { PrState } from "./db";
import type { PrSummary } from "./types";

export type Bucket = "ready" | "waiting" | "blocked" | "snoozed" | "done";

export interface Attention {
  score: number;
  bucket: Bucket;
  /** Short phrases explaining the ranking, shown on the row. */
  reasons: string[];
}

const DAY = 86_400_000;

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / DAY);
}

/**
 * Ranks a PR by how much it is waiting on *you*. The dominant term is age:
 * an old PR that passes CI and has your review outstanding is someone else
 * blocked on you, and should outrank a shiny new one.
 */
export function scoreAttention(pr: PrSummary, state: PrState | null): Attention {
  void state;
  const reasons: string[] = [];
  let score = 0;

  const age = daysSince(pr.createdAt);
  const stale = daysSince(pr.updatedAt);
  const ciFailing = pr.checkState === "FAILURE" || pr.checkState === "ERROR";
  const ciPending = pr.checkState === "PENDING" || pr.checkState === "EXPECTED";
  const conflicted = pr.mergeable === "CONFLICTING";

  // --- bucket ---
  // A PR with CI still running is perfectly reviewable; pending checks block
  // merging, not reading. In a monorepo with path-filtered workflows many
  // required checks sit in EXPECTED indefinitely, so gating "ready" on fully
  // green CI leaves the section permanently empty.
  // Whether a snooze is *still in effect* is `isHidden`'s call, not this one —
  // deciding it here would keep lapsed snoozes hidden forever.
  let bucket: Bucket;
  if (pr.viewerHasApproved) {
    bucket = "done";
  } else if (ciFailing || conflicted) {
    bucket = "blocked";
  } else {
    bucket = "ready";
  }

  // --- score ---
  if (pr.requestedReviewers.length > 0 || pr.requestedTeams.length > 0) {
    score += 40;
    reasons.push("review requested");
  }

  // Age dominates: 2 points a day, capped so a six-month-old PR doesn't
  // permanently pin itself to the top.
  score += agePoints(age);
  if (age >= 7) reasons.push(`open ${Math.round(age)}d`);

  // A PR nobody has touched in a while is more likely to be stuck on you.
  if (stale >= 3) {
    score += Math.min(stale, 20);
    reasons.push(`quiet ${Math.round(stale)}d`);
  }

  if (pr.reviewVerdict === "approve") {
    score += 20;
    reasons.push("reviewed: low risk");
  } else if (pr.reviewVerdict === "block") {
    score -= 15;
    reasons.push("reviewed: concerns");
  }

  // Stacks merge bottom-up, so the lowest open PR is the one actually ready to
  // review — approving the top of a stack achieves nothing until the rest land.
  const stack = pr.stack;
  if (stack) {
    if (stack.isBottom && stack.size > 1) {
      score += 25;
      reasons.push(`unblocks ${stack.size - 1} stacked PR${stack.size === 2 ? "" : "s"}`);
    } else if (stack.blockedBy.length > 0) {
      score -= Math.min(stack.blockedBy.length * 15, 45);
      reasons.push(`stacked ${stack.position}/${stack.size}`);
    } else if (stack.unknownParentBranch) {
      score -= 10;
      reasons.push("stacked");
    }
  }

  if (pr.changedFiles > 0 && pr.changedFiles <= 5) {
    score += 8;
    reasons.push("small");
  }
  if (pr.changedFiles > 60) score -= 8;

  if (pr.isDraft) {
    score -= 40;
    reasons.push("draft");
  }
  if (ciFailing) {
    score -= 30;
    reasons.push("CI failing");
  }
  if (conflicted) {
    score -= 25;
    reasons.push("conflicts");
  }
  // Green CI still ranks above pending, just within the same section.
  if (pr.checkState === "SUCCESS") {
    score += 10;
    reasons.push("CI green");
  } else if (ciPending) {
    score -= 5;
  }
  if (pr.viewerHasApproved) score -= 100;

  return { score: Math.round(score), bucket, reasons: reasons.slice(0, 3) };
}

function agePoints(age: number): number {
  return Math.min(age, 45) * 2;
}

/**
 * A snooze lapses when its deadline passes or when the author pushes new
 * commits — the thing you were waiting for probably happened.
 */
export function isHidden(pr: PrSummary, state: PrState | null): boolean {
  if (!state) return false;
  if (state.status === "muted") return false;

  if (state.status === "ignored") {
    return true;
  }
  if (state.status === "snoozed") {
    if (state.until && Date.now() > state.until) return false;
    if (state.pinnedSha && pr.headSha && pr.headSha !== state.pinnedSha) return false;
    return true;
  }
  return false;
}
