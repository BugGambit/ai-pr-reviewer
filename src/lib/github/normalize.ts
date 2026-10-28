import type { CheckRun, CheckState, PrSummary } from "../types";

/* Raw GraphQL node shapes (only the fields we read). */
export interface RawCheckContext {
  __typename: string;
  name?: string;
  conclusion?: string | null;
  status?: string | null;
  detailsUrl?: string | null;
  context?: string;
  state?: string | null;
  targetUrl?: string | null;
  isRequired?: boolean;
}

export interface RawRollup {
  state: string | null;
  contexts: { nodes: RawCheckContext[] };
}

export interface RawPrNode {
  __typename?: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  headRefName: string;
  mergeable: string;
  reviewDecision: string | null;
  author: { login: string; avatarUrl: string | null } | null;
  repository: { name: string; owner: { login: string }; defaultBranchRef?: { name: string } | null };
  labels: { nodes: { name: string; color: string }[] };
  assignees: { nodes: { login: string }[] };
  reviewRequests: {
    nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[];
  };
  latestReviews: { nodes: { state: string; author: { login: string } | null }[] };
  files?: { nodes: { path: string }[]; pageInfo: { hasNextPage: boolean } };
  commits: { nodes: { commit: { oid: string; statusCheckRollup: RawRollup | null } }[] };
}

/** Maps a CheckRun conclusion or a StatusContext state onto one scale. */
function contextState(ctx: RawCheckContext): CheckState {
  if (ctx.__typename === "CheckRun") {
    if (ctx.status && ctx.status !== "COMPLETED") return "PENDING";
    switch (ctx.conclusion) {
      case "SUCCESS":
        return "SUCCESS";
      case "NEUTRAL":
      case "SKIPPED":
        return "SUCCESS";
      case "FAILURE":
      case "TIMED_OUT":
      case "STARTUP_FAILURE":
        return "FAILURE";
      case "CANCELLED":
      case "ACTION_REQUIRED":
        return "ERROR";
      case "STALE":
        return "PENDING";
      default:
        return "PENDING";
    }
  }
  switch (ctx.state) {
    case "SUCCESS":
      return "SUCCESS";
    case "FAILURE":
      return "FAILURE";
    case "ERROR":
      return "ERROR";
    case "PENDING":
      return "PENDING";
    default:
      return "EXPECTED";
  }
}

export function normalizeChecks(rollup: RawRollup | null | undefined): {
  state: CheckState;
  checks: CheckRun[];
  failing: string[];
} {
  if (!rollup) return { state: "NONE", checks: [], failing: [] };

  const checks: CheckRun[] = (rollup.contexts?.nodes ?? [])
    .filter(Boolean)
    .map((ctx) => ({
      name: ctx.name ?? ctx.context ?? "check",
      state: contextState(ctx),
      conclusion: ctx.conclusion ?? ctx.state ?? null,
      url: ctx.detailsUrl ?? ctx.targetUrl ?? null,
      isRequired: Boolean(ctx.isRequired),
    }));

  const failing = checks.filter((c) => c.state === "FAILURE" || c.state === "ERROR").map((c) => c.name);

  // Prefer the rollup's own verdict; fall back to deriving it from contexts so
  // a missing rollup state doesn't hide a red build.
  let state: CheckState = (rollup.state as CheckState) ?? "NONE";
  if (!rollup.state) {
    if (failing.length > 0) state = "FAILURE";
    else if (checks.some((c) => c.state === "PENDING")) state = "PENDING";
    else if (checks.length > 0) state = "SUCCESS";
    else state = "NONE";
  }

  return { state, checks, failing };
}

export function normalizePrSummary(node: RawPrNode, viewer: string): PrSummary {
  const owner = node.repository.owner.login;
  const repo = node.repository.name;
  const headCommit = node.commits?.nodes?.[0]?.commit;
  const { state: checkState, failing } = normalizeChecks(headCommit?.statusCheckRollup);

  const requestedTeams: string[] = [];
  const requestedReviewers: string[] = [];
  for (const req of node.reviewRequests?.nodes ?? []) {
    const r = req?.requestedReviewer;
    if (!r) continue;
    if (r.__typename === "Team" && r.slug) requestedTeams.push(r.slug);
    else if (r.login) requestedReviewers.push(r.login);
  }

  const viewerHasApproved = (node.latestReviews?.nodes ?? []).some(
    (r) => r?.author?.login === viewer && r.state === "APPROVED",
  );

  return {
    id: `${owner}/${repo}#${node.number}`,
    owner,
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    author: {
      login: node.author?.login ?? "ghost",
      avatarUrl: node.author?.avatarUrl ?? null,
    },
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    isDraft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    labels: node.labels?.nodes ?? [],
    reviewDecision: (node.reviewDecision as PrSummary["reviewDecision"]) ?? null,
    checkState,
    failingChecks: failing,
    headSha: headCommit?.oid ?? "",
    baseRefName: node.baseRefName,
    headRefName: node.headRefName,
    defaultBranch: node.repository.defaultBranchRef?.name ?? null,
    mergeable: (node.mergeable as PrSummary["mergeable"]) ?? "UNKNOWN",
    filePaths: node.files?.nodes?.map((f) => f.path) ?? [],
    filesTruncated: Boolean(node.files?.pageInfo?.hasNextPage),
    requestedTeams,
    requestedReviewers,
    assignees: node.assignees?.nodes?.map((a) => a.login) ?? [],
    viewerHasApproved,
    matchedFilters: [],
  };
}
