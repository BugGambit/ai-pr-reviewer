// ---------------------------------------------------------------------------
// Shared domain types. Kept in one file so the API routes and the React
// components agree on shapes without a codegen step.
// ---------------------------------------------------------------------------

export type CheckState =
  | "SUCCESS"
  | "FAILURE"
  | "PENDING"
  | "ERROR"
  | "EXPECTED"
  | "NONE";

export interface CheckRun {
  name: string;
  state: CheckState;
  conclusion: string | null;
  url: string | null;
  isRequired: boolean;
}

export interface PrLabel {
  name: string;
  color: string;
}

export interface PrUser {
  login: string;
  avatarUrl: string | null;
}

/** Lightweight shape used by the inbox list. */
export interface PrSummary {
  id: string; // owner/repo#number
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: PrUser;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: PrLabel[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checkState: CheckState;
  failingChecks: string[];
  headSha: string;
  baseRefName: string;
  headRefName: string;
  /** The repo's default branch, used to spot stacked PRs. */
  defaultBranch?: string | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  filePaths: string[];
  filesTruncated: boolean;
  requestedTeams: string[];
  requestedReviewers: string[];
  assignees: string[];
  viewerHasApproved: boolean;
  /** Head commit your still-standing approval was given on. */
  viewerApprovedSha?: string | null;
  /** Which configured filters matched this PR. */
  matchedFilters: string[];
  /** Cached review verdict, if one exists for this head SHA. */
  reviewVerdict?: Verdict | null;
  reviewRiskScore?: number | null;
  /** Ranking and triage state, attached by the list endpoint. */
  attention?: { score: number; bucket: string; reasons: string[] };
  stack?: StackInfo | null;
  triage?: { status: "snoozed" | "ignored" | "muted"; until: number | null; note: string | null } | null;
}

export interface StackInfo {
  /** How many PRs in this chain we can see. */
  size: number;
  /** 1-based position counting from the bottom of the stack. */
  position: number;
  parentId: string | null;
  childIds: string[];
  isBottom: boolean;
  /** Set when the PR targets a branch whose own PR isn't in view. */
  unknownParentBranch: string | null;
  /** Open ancestors that have to merge before this one can. */
  blockedBy: string[];
}

export interface PrFile {
  path: string;
  previousPath: string | null;
  changeType: string;
  additions: number;
  deletions: number;
}

export interface PrComment {
  id: string;
  author: PrUser;
  body: string;
  /** GitHub's own rendered HTML, which carries signed URLs for private assets. */
  bodyHtml: string;
  createdAt: string;
  url: string;
}

export interface ReviewThreadComment extends PrComment {
  path: string | null;
  line: number | null;
  diffHunk: string | null;
}

export interface PrReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface PrReview {
  id: string;
  author: PrUser;
  state: string;
  body: string;
  bodyHtml: string;
  submittedAt: string | null;
  url: string;
  /** Head commit the review was submitted on. */
  commitOid?: string | null;
}

export interface PrCommit {
  oid: string;
  messageHeadline: string;
  messageBody: string;
  author: string;
  committedDate: string;
  url: string;
}

/** Full shape used by the detail page. */
export interface PrDetail extends PrSummary {
  body: string;
  bodyHtml: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  files: PrFile[];
  commits: PrCommit[];
  comments: PrComment[];
  reviews: PrReview[];
  reviewThreads: PrReviewThread[];
  checks: CheckRun[];
  baseRepoDefaultBranch: string;
  diff: string;
  diffTruncated: boolean;
  diffBytes: number;
}

// --------------------------- Claude review output --------------------------

export type Verdict = "approve" | "needs_attention" | "block";
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface ReviewFinding {
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  suggestion?: string;
  suggestedCode?: string;
}

export interface Diagram {
  title: string;
  type: string;
  mermaid: string;
  caption: string;
}

export interface DependencyChange {
  name: string;
  from: string;
  to: string;
  changeType: "added" | "removed" | "upgraded" | "downgraded";
  concern: string;
}

export interface SuggestedReviewComment {
  file: string;
  line: number;
  body: string;
  suggestedCode?: string;
}

export interface ChangeArea {
  area: string;
  description: string;
  files: string[];
  impact: "high" | "medium" | "low";
}

export interface ReviewResult {
  verdict: Verdict;
  confidence: "low" | "medium" | "high";
  riskScore: number;
  oneLiner: string;
  summary: string;
  whatChanged: ChangeArea[];
  descriptionAccuracy: {
    matchesCode: boolean;
    notes: string;
  };
  diagrams: Diagram[];
  dependencyChanges: DependencyChange[];
  findings: ReviewFinding[];
  securityFlags: ReviewFinding[];
  promptInjection: {
    detected: boolean;
    detail: string;
  };
  testCoverage: {
    assessment: "good" | "partial" | "none" | "not_applicable";
    notes: string;
  };
  blastRadius: {
    scope: string;
    userFacing: boolean;
    dataMigration: boolean;
    apiChange: boolean;
    breakingChange: boolean;
    notes: string;
  };
  checklist: { item: string; status: "ok" | "warn" | "fail" | "na"; note: string }[];
  suggestedComments: SuggestedReviewComment[];
  screenshotSuggestions: { route: string; label: string; why: string }[];
}

export interface StoredReview {
  id: number;
  prId: string;
  headSha: string;
  mode: "standard" | "deep";
  status: "running" | "done" | "error";
  result: ReviewResult | null;
  error: string | null;
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
  /** Deterministic signals computed without the model. */
  heuristics: HeuristicReport | null;
}

// ------------------------- Follow-up (since last look) ---------------------

export type FollowupChangeKind =
  | "rebase_conflict"
  | "ci_fix"
  | "review_feedback"
  | "new_behaviour"
  | "refactor"
  | "revert"
  | "other";

export interface FollowupResult {
  verdict: Verdict;
  riskScore: number;
  oneLiner: string;
  /** False when the delta undermines the earlier verdict or its findings. */
  previousReviewStillHolds: boolean;
  changes: { kind: FollowupChangeKind; file: string; description: string }[];
  concerns: ReviewFinding[];
  promptInjection: { detected: boolean; detail: string };
}

export interface StoredFollowup {
  id: number;
  prId: string;
  fromSha: string;
  toSha: string;
  status: "running" | "done" | "error";
  result: FollowupResult | null;
  error: string | null;
  model: string | null;
  costUsd: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface InterdiffLine {
  type: "add" | "del" | "ctx";
  content: string;
  newLine: number | null;
  oldLine: number | null;
  /** True when this change line was not part of the PR at the baseline. */
  novel: boolean;
}

export interface InterdiffFile {
  path: string;
  /** "new" = file entered the PR, "dropped" = no longer touched by the PR. */
  status: "new" | "dropped" | "changed";
  novelLines: number;
  revertedLines: number;
  /** Current hunks that contain at least one novel line. */
  hunks: { header: string; lines: InterdiffLine[] }[];
  /** Change lines (with +/- prefix) that were in the PR at the baseline but are gone now. */
  reverted: string[];
  /**
   * Baseline change lines that left the PR because the base branch now has
   * them, typically a stacked PR below this one being squash-merged.
   */
  landedLines: number;
}

export interface Interdiff {
  fromSha: string;
  toSha: string;
  /** True when the PR's net change is the same, i.e. a pure rebase or squash. */
  identical: boolean;
  files: InterdiffFile[];
  unchangedFiles: number;
  /** Files that left the PR entirely because the base branch caught up with them. */
  landedFiles: string[];
  /** Either side was truncated, so the comparison may be incomplete. */
  partial: boolean;
}

export interface SinceBaseline {
  /**
   * "approval" = your approval, "review" = your last AI review,
   * "other-approval" = someone else's approval (e.g. on your own PR).
   */
  kind: "approval" | "review" | "other-approval";
  sha: string;
  at: number | null;
  by: string | null;
}

export interface SinceInfo {
  baseline: SinceBaseline | null;
  /** Why no comparison could be made, when baseline is set but interdiff isn't. */
  unavailable: string | null;
  interdiff: Interdiff | null;
  followup: StoredFollowup | null;
}

// ------------------------------ Heuristics ---------------------------------

export interface HeuristicSignal {
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface HeuristicReport {
  signals: HeuristicSignal[];
  injectionSuspects: HeuristicSignal[];
  stats: {
    additions: number;
    deletions: number;
    files: number;
    lockfileOnly: boolean;
    testFiles: number;
    sourceFiles: number;
    configFiles: number;
    generatedFiles: number;
    ciFiles: number;
    dependencyFiles: number;
  };
}

// ------------------------------ Config -------------------------------------

export interface PathFilter {
  repo: string; // owner/repo
  globs: string[];
}

export interface PrFilter {
  id: string;
  name: string;
  enabled: boolean;
  repos: string[];
  authors: string[];
  teams: string[];
  paths: PathFilter[];
  labels: string[];
  excludeAuthors: string[];
  includeDrafts: boolean;
  /** Only surface PRs that have requested review from me / my teams. */
  onlyReviewRequested: boolean;
}

export interface ScreenshotRepoConfig {
  enabled: boolean;
  /** Command run once in the checkout, e.g. "pnpm install --frozen-lockfile". */
  setup: string;
  /** Command that starts the dev server, e.g. "pnpm --filter web dev". */
  dev: string;
  /** Working sub-directory inside the repo for the commands above. */
  cwd: string;
  port: number;
  /** Path polled until the server answers, e.g. "/". */
  readyPath: string;
  readyTimeoutSeconds: number;
  env: Record<string, string>;
  routes: { label: string; path: string; waitFor?: string }[];
  /** Also capture the same routes on the base branch for a before/after pair. */
  captureBaseline: boolean;
  viewport: { width: number; height: number };
}

export interface AppConfig {
  /** Default GitHub organisation. Empty means "wherever my filters point". */
  org: string;
  viewer: string;
  filters: PrFilter[];
  approval: {
    approve: boolean;
    approveBody: string;
    assignSelf: boolean;
    labels: string[];
    /** Labels to take off once the risk review is done, when present. */
    removeLabels: string[];
    comment: string;
    /**
     * Substring of the CI check that gates merging once you approve (e.g.
     * "policy-bot"). Watched after approval so you can see it turn green.
     */
    gateCheck: string;
  };
  review: {
    /** Which CLI runs the review. "auto" prefers `claude` and falls back to Cursor's `agent`. */
    provider: "auto" | "claude" | "cursor";
    model: string;
    /** Cursor model id (see `agent models`). Effort is part of the id, e.g. `-high`. */
    cursorModel: string;
    mode: "standard" | "deep";
    maxDiffBytes: number;
    maxBudgetUsd: number;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    autoReviewOnOpen: boolean;
  };
  prefetch: {
    enabled: boolean;
    /** How many unreviewed PRs from the top of the queue to review ahead. */
    maxPrs: number;
    concurrency: number;
    /** Hard stop on spend per calendar day, across prefetch runs only. */
    dailyBudgetUsd: number;
  };
  notifications: {
    enabled: boolean;
    intervalSeconds: number;
    desktop: boolean;
    newPrs: boolean;
    mentions: boolean;
    replies: boolean;
    reviewRequests: boolean;
    /** Activity on pull requests I opened. */
    myPrApproved: boolean;
    myPrChangesRequested: boolean;
    myPrCiFailed: boolean;
    /**
     * Team slugs whose review requests should NOT notify. GitHub expands a
     * team request to every member, so membership in a broad team becomes a
     * firehose unless it can be switched off.
     */
    mutedTeams: string[];
  };
  list: {
    hideFailingCi: boolean;
    hideDrafts: boolean;
    hideApprovedByMe: boolean;
  };
  screenshots: {
    enabled: boolean;
    checkoutRoot: string;
    repos: Record<string, ScreenshotRepoConfig>;
  };
}

export interface AppNotification {
  id: string;
  kind: "new_pr" | "mention" | "reply" | "review_request" | "ci_failed" | "approved" | "changes_requested";
  prId: string | null;
  owner: string | null;
  repo: string | null;
  number: number | null;
  title: string;
  body: string;
  url: string;
  actor: string;
  createdAt: number;
  readAt: number | null;
  /** Why this arrived, e.g. "via team platform-team". */
  via?: string | null;
  /** True when the thing it asked for no longer needs doing. */
  resolved?: boolean;
}

export interface ScreenshotRecord {
  id: number;
  prId: string;
  headSha: string;
  label: string;
  route: string;
  variant: "base" | "head";
  path: string | null;
  status: "ok" | "error";
  error: string | null;
  createdAt: number;
}

export interface JobState {
  id: string;
  kind: string;
  status: "running" | "done" | "error";
  message: string;
  logs: string[];
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  /** The review as far as the model has written it, while still streaming. */
  partial?: Partial<ReviewResult> | null;
  /** The follow-up review as far as the model has written it. */
  followupPartial?: Partial<FollowupResult> | null;
}
