import { execFile } from "node:child_process";
import { getViewer, getViewerTeams, ghGraphQl, ghJson, parsePrId, prId } from "./gh";
import {
  addNotification,
  hasSeenAnyPrs,
  kvGet,
  kvSet,
  listPrStates,
  dedupeReviewRequests,
  markNotificationsRead,
  markPrsSeen,
  pendingNotifications,
  updateNotificationContext,
  pruneNotifications,
} from "./db";
import { loadConfig } from "./config";
import { listPrs } from "./github/list";
import { MY_PRS } from "./github/queries";
import type { AppConfig, AppNotification, PrSummary } from "./types";

interface GhThread {
  id: string;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string | null; type: string };
  repository: { name: string; owner: { login: string }; full_name: string };
}

const BROWSER_SEEN_KEY = "notifications:browserSeenAt";
const BROWSER_QUEUE_KEY = "notifications:browserQueue";
/** An open tab polls every 30-60s; past this it's presumed closed. */
const BROWSER_FRESH_MS = 150_000;

/**
 * Called by an open tab that is allowed to show notifications. Marks the
 * browser as the active notifier and hands over whatever is queued. The first
 * tab to ask takes the queue, so several open tabs don't all alert.
 */
export function takeBrowserAlerts(): AppNotification[] {
  const lastSeen = Number(kvGet(BROWSER_SEEN_KEY) ?? 0);
  kvSet(BROWSER_SEEN_KEY, String(Date.now()));
  const queued = JSON.parse(kvGet(BROWSER_QUEUE_KEY) ?? "[]") as AppNotification[];
  if (queued.length > 0) kvSet(BROWSER_QUEUE_KEY, "[]");
  // Queued for a tab that has since closed: popping them up on reopen, maybe
  // hours later, is noise. They're still in the bell.
  return Date.now() - lastSeen < BROWSER_FRESH_MS ? queued : [];
}

/**
 * Browser notifications open the PR when clicked. osascript ones can't carry
 * a click action at all — macOS attributes them to Script Editor and opens
 * that instead — so they're only the fallback for when no tab is open.
 */
function announce(created: AppNotification[]): void {
  const browserActive = Date.now() - Number(kvGet(BROWSER_SEEN_KEY) ?? 0) < BROWSER_FRESH_MS;
  if (browserActive) {
    const queued = JSON.parse(kvGet(BROWSER_QUEUE_KEY) ?? "[]") as AppNotification[];
    kvSet(BROWSER_QUEUE_KEY, JSON.stringify([...queued, ...created].slice(-50)));
    return;
  }
  if (created.length <= 3) {
    for (const n of created) desktopNotify(n.title, n.body);
  } else {
    desktopNotify("PR Reviewer", `${created.length} new items need your attention`);
  }
}

function desktopNotify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const escape = (s: string) => s.replace(/["\\]/g, "\\$&").slice(0, 200);
  execFile(
    "osascript",
    ["-e", `display notification "${escape(body)}" with title "${escape(title)}" sound name "Ping"`],
    () => {
      /* best effort */
    },
  );
}

/** Turns an API subject URL into the browser URL for the PR. */
function subjectToHtmlUrl(thread: GhThread): { url: string; number: number | null } {
  const apiUrl = thread.subject.url ?? "";
  const match = /\/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)/.exec(apiUrl);
  if (match) {
    const kind = match[3] === "pulls" ? "pull" : "issues";
    return {
      url: `https://github.com/${match[1]}/${match[2]}/${kind}/${match[4]}`,
      number: Number(match[4]),
    };
  }
  return { url: `https://github.com/${thread.repository.full_name}`, number: null };
}

const REASON_KIND: Record<string, AppNotification["kind"]> = {
  mention: "mention",
  team_mention: "mention",
  review_requested: "review_request",
  comment: "reply",
  author: "reply",
  subscribed: "reply",
};

/**
 * Explains a "review requested" notification. GitHub expands a *team* request
 * to every member, so the PR page shows only the team and the recipient can't
 * find themselves anywhere on it. Resolving the team turns a baffling ping into
 * "via team X" — and tells us when the request has already been satisfied.
 */
async function describeReviewRequest(
  prIdValue: string,
  myTeams: string[],
  viewer: string,
): Promise<{ via: string | null; resolved: boolean; mutedTeam: string | null }> {
  const target = parsePrId(prIdValue);
  if (!target) return { via: null, resolved: false, mutedTeam: null };

  try {
    const data = await ghGraphQl<{
      repository: {
        pullRequest: {
          state: string;
          reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[] };
          timelineItems: {
            nodes: { requestedReviewer?: { __typename: string; login?: string; slug?: string } | null }[];
          };
        } | null;
      };
    }>(
      `query($owner:String!,$repo:String!,$number:Int!){
         repository(owner:$owner,name:$repo){
           pullRequest(number:$number){
             state
             reviewRequests(first:25){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug}}}}
             timelineItems(last:40,itemTypes:[REVIEW_REQUESTED_EVENT]){
               nodes{... on ReviewRequestedEvent{requestedReviewer{__typename ... on User{login} ... on Team{slug}}}}
             }
           }
         }
       }`,
      { owner: target.owner, repo: target.repo, number: target.number },
    );

    const pr = data.repository?.pullRequest;
    if (!pr) return { via: null, resolved: false, mutedTeam: null };

    const teamSet = new Set(myTeams);
    const current = pr.reviewRequests.nodes.map((n) => n.requestedReviewer).filter(Boolean);
    const historic = pr.timelineItems.nodes.map((n) => n.requestedReviewer).filter(Boolean);

    const currentTeam = current.find((r) => r!.slug && teamSet.has(r!.slug))?.slug ?? null;
    // Other people requested by name say nothing about whether *I* was asked.
    const currentUser = current.some((r) => r!.login === viewer);
    const pastTeam = historic.find((r) => r!.slug && teamSet.has(r!.slug))?.slug ?? null;

    const team = currentTeam ?? pastTeam;
    const stillOpen = pr.state === "OPEN";
    // Nothing outstanding for me once the request is gone, or the PR closed.
    const resolved = !stillOpen || (!currentTeam && !currentUser);

    return {
      via: team ? `via team ${team}` : currentUser ? "requested directly" : null,
      resolved,
      mutedTeam: team,
    };
  } catch (err) {
    console.warn("[notifications] could not describe review request:", err instanceof Error ? err.message : err);
    return { via: null, resolved: false, mutedTeam: null };
  }
}

/** Runs tasks with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * GitHub pings every member of a team that is requested or @-mentioned, which
 * across a dozen teams is mostly noise. Those only count when the PR is one my
 * filters already care about; pings addressed to me personally always count.
 * `inScope` is null when the filtered list is unavailable, in which case
 * nothing is dropped — a missed ping is worse than a spare one.
 */
async function pollGithubNotifications(
  config: AppConfig,
  inScope: Set<string> | null,
): Promise<AppNotification[]> {
  const myTeams = await getViewerTeams(config.org);
  const viewer = config.viewer || (await getViewer()).login;
  const wanted = (prIdValue: string | null) => !inScope || (prIdValue !== null && inScope.has(prIdValue));
  const since = kvGet("notifications:since");
  const args = ["api", "notifications?per_page=50&participating=true"];
  if (since) args[1] += `&since=${encodeURIComponent(since)}`;

  let threads: GhThread[] = [];
  try {
    threads = await ghJson<GhThread[]>(args);
  } catch (err) {
    console.warn("[notifications] GitHub poll failed:", err instanceof Error ? err.message : err);
    return [];
  }

  const created: AppNotification[] = [];
  for (const thread of threads) {
    if (thread.subject.type !== "PullRequest") continue;

    const kind = REASON_KIND[thread.reason];
    if (!kind) continue;
    if (kind === "mention" && !config.notifications.mentions) continue;
    if (kind === "reply" && !config.notifications.replies) continue;
    if (kind === "review_request" && !config.notifications.reviewRequests) continue;

    const { url, number } = subjectToHtmlUrl(thread);
    const owner = thread.repository.owner.login;
    const repo = thread.repository.name;

    // A reply genuinely is new each time the thread moves, but a review
    // request is one standing ask — keying it on updated_at produced a fresh
    // "review requested" every time anything happened on the PR.
    const stableId =
      kind === "review_request" ? `gh:${thread.id}:review_request` : `gh:${thread.id}:${thread.updated_at}`;

    const prIdValue = number ? `${owner}/${repo}#${number}` : null;
    if (thread.reason === "team_mention" && !wanted(prIdValue)) continue;

    const notification: Omit<AppNotification, "readAt"> = {
      id: stableId,
      kind,
      prId: prIdValue,
      owner,
      repo,
      number,
      title: thread.subject.title,
      body:
        kind === "mention"
          ? `You were mentioned in ${thread.repository.full_name}`
          : kind === "review_request"
            ? `Review requested in ${thread.repository.full_name}`
            : `New activity in ${thread.repository.full_name}`,
      url,
      actor: "github",
      createdAt: new Date(thread.updated_at).getTime(),
    };

    if (kind === "review_request") {
      // One extra query per *new* request, not per poll.
      const detail = await describeReviewRequest(notification.prId ?? "", myTeams, viewer);

      if (detail.mutedTeam && config.notifications.mutedTeams.includes(detail.mutedTeam)) continue;
      const personal = detail.via === "requested directly";
      if (!personal && !wanted(prIdValue)) continue;

      notification.via = detail.via;
      notification.resolved = detail.resolved;
      if (detail.via) notification.body = `Review requested in ${thread.repository.full_name} — ${detail.via}`;
      if (detail.resolved) notification.body += " (already handled)";
    }

    if (addNotification(notification)) created.push({ ...notification, readAt: null });
  }

  kvSet("notifications:since", new Date().toISOString());
  return created;
}

/** The PRs my filters match — the same set the queue shows. Null if unavailable. */
async function listFilteredPrs(config: AppConfig): Promise<PrSummary[] | null> {
  if (!config.filters.some((f) => f.enabled)) return null;
  try {
    const { prs, errors } = await listPrs(config, { limitPerQuery: 50 });
    // A partial result would wrongly drop pings for PRs the failed query covers.
    if (errors.length > 0) return null;
    return prs;
  } catch (err) {
    console.warn("[notifications] PR poll failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

function pollNewPrs(config: AppConfig, prs: PrSummary[] | null): AppNotification[] {
  if (!config.notifications.newPrs || !prs) return [];

  // On the very first run everything looks new; record the baseline silently.
  const firstRun = !hasSeenAnyPrs();
  const fresh = markPrsSeen(prs.map((p) => p.id));
  if (firstRun) return [];

  const created: AppNotification[] = [];
  for (const id of fresh) {
    const pr = prs.find((p) => p.id === id);
    if (!pr) continue;
    const notification: Omit<AppNotification, "readAt"> = {
      id: `newpr:${pr.id}`,
      kind: "new_pr",
      prId: pr.id,
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      body: `New PR by @${pr.author.login} in ${pr.owner}/${pr.repo} — matches: ${pr.matchedFilters.join(", ")}`,
      url: pr.url,
      actor: pr.author.login,
      createdAt: new Date(pr.createdAt).getTime(),
    };
    if (addNotification(notification)) created.push({ ...notification, readAt: null });
  }
  return created;
}


export interface MyPrNode {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  reviewDecision: string | null;
  repository: { name: string; owner: { login: string } };
  latestReviews: { nodes: { state: string; submittedAt: string | null; author: { login: string } | null }[] };
  commits: { nodes: { commit: { oid: string; statusCheckRollup: { state: string | null } | null } }[] };
}

/**
 * Maps one of my pull requests onto the notifications it should raise. Pure, so
 * the approval/rejection/CI branches can be tested without GitHub in the loop.
 */
export function myPrNotifications(
  node: MyPrNode,
  settings: AppConfig["notifications"],
): Omit<AppNotification, "readAt">[] {
  const owner = node.repository.owner.login;
  const repo = node.repository.name;
  const id = prId(owner, repo, node.number);
  const out: Omit<AppNotification, "readAt">[] = [];

  const base = { prId: id, owner, repo, number: node.number, title: node.title, url: node.url };

  for (const review of node.latestReviews?.nodes ?? []) {
    const who = review?.author?.login;
    if (!who) continue;

    const isApproval = review.state === "APPROVED" && settings.myPrApproved;
    const isRejection = review.state === "CHANGES_REQUESTED" && settings.myPrChangesRequested;
    if (!isApproval && !isRejection) continue;

    out.push({
      ...base,
      // Keyed on the submission time so a re-review notifies again, but the
      // same approval never does.
      id: `myreview:${id}:${who}:${review.state}:${review.submittedAt ?? ""}`,
      kind: isApproval ? "approved" : "changes_requested",
      body: isApproval
        ? `@${who} approved your PR in ${owner}/${repo}`
        : `@${who} requested changes on your PR in ${owner}/${repo}`,
      actor: who,
      createdAt: review.submittedAt ? new Date(review.submittedAt).getTime() : Date.now(),
    });
  }

  if (settings.myPrCiFailed) {
    const commit = node.commits?.nodes?.[0]?.commit;
    const rollup = commit?.statusCheckRollup?.state;
    if (commit && (rollup === "FAILURE" || rollup === "ERROR")) {
      out.push({
        ...base,
        // Per commit, so a fix-then-break cycle notifies each time.
        id: `myci:${id}:${commit.oid}`,
        kind: "ci_failed",
        body: `CI is failing on your PR in ${owner}/${repo}`,
        actor: "ci",
        createdAt: new Date(node.updatedAt).getTime(),
      });
    }
  }

  return out;
}

/**
 * Watches the PRs *I* opened. Being approved is the event that unblocks me, and
 * nothing else here was reporting it — GitHub's participating feed buries it
 * among review requests.
 */
async function pollMyPrs(config: AppConfig, muted: Set<string>): Promise<AppNotification[]> {
  const settings = config.notifications;
  if (!settings.myPrApproved && !settings.myPrChangesRequested && !settings.myPrCiFailed) return [];

  let nodes: (MyPrNode | null)[];
  try {
    const data = await ghGraphQl<{ search: { nodes: (MyPrNode | null)[] } }>(MY_PRS, {
      q: `is:pr is:open archived:false author:@me${config.org ? ` org:${config.org}` : ""}`,
    });
    nodes = data.search.nodes ?? [];
  } catch (err) {
    console.warn("[notifications] own-PR poll failed:", err instanceof Error ? err.message : err);
    return [];
  }

  const created: AppNotification[] = [];
  for (const node of nodes) {
    if (!node?.number) continue;
    if (muted.has(prId(node.repository.owner.login, node.repository.name, node.number))) continue;

    for (const notification of myPrNotifications(node, settings)) {
      if (addNotification(notification)) created.push({ ...notification, readAt: null });
    }
  }
  return created;
}

export async function pollNotifications(
  opts: { sweep?: boolean } = {},
): Promise<{ created: AppNotification[]; polledAt: number }> {
  const config = loadConfig();
  if (!config.notifications.enabled) return { created: [], polledAt: Date.now() };

  // Muted PRs stay in the list but stop alerting.
  const muted = new Set(
    [...listPrStates().values()].filter((s) => s.status === "muted").map((s) => s.prId),
  );

  const [filtered, mineNew] = await Promise.all([listFilteredPrs(config), pollMyPrs(config, muted)]);
  const ghNew = await pollGithubNotifications(config, filtered && new Set(filtered.map((p) => p.id)));
  const prNew = pollNewPrs(config, filtered);
  const created = [...ghNew, ...prNew, ...mineNew].filter((n) => !n.prId || !muted.has(n.prId));

  // The very first poll would otherwise dump every open review request into the
  // bell as unread. Record them, but don't claim they're new to the user.
  if (!kvGet("notifications:bootstrapped")) {
    kvSet("notifications:bootstrapped", String(Date.now()));
    markNotificationsRead();
    return { created: [], polledAt: Date.now() };
  }

  if (config.notifications.desktop && created.length > 0) announce(created);

  dedupeReviewRequests();

  // Annotating standing review requests costs one query each. Worth doing on
  // the background loop; far too slow to sit behind a button press.
  if (opts.sweep) {
    try {
      const myTeams = await getViewerTeams(config.org);
      const pending = pendingNotifications("review_request", 25);

      // One PR can back several rows; query each PR once.
      const byPr = new Map<string, typeof pending>();
      for (const row of pending) {
        const key = row.prId ?? "";
        byPr.set(key, [...(byPr.get(key) ?? []), row]);
      }

      const keys = [...byPr.keys()];
      const viewer = config.viewer || (await getViewer()).login;
      const details = await mapLimit(keys, 5, (key) => describeReviewRequest(key, myTeams, viewer));

      keys.forEach((key, index) => {
        const detail = details[index];
        const repoName = key.split("#")[0];
        const body = detail.via
          ? `Review requested in ${repoName} — ${detail.via}${detail.resolved ? " (already handled)" : ""}`
          : undefined;
        for (const row of byPr.get(key) ?? []) {
          updateNotificationContext(row.id, { via: detail.via, resolved: detail.resolved, body });
        }
      });
    } catch (err) {
      console.warn("[notifications] review-request sweep failed:", err instanceof Error ? err.message : err);
    }
  }

  kvSet("notifications:lastPoll", String(Date.now()));
  pruneNotifications();
  return { created, polledAt: Date.now() };
}

let timer: NodeJS.Timeout | null = null;

/** Starts the background poll loop. Safe to call repeatedly. */
export function startNotificationPoller(): void {
  if (timer) return;
  const schedule = () => {
    const config = loadConfig();
    const intervalMs = Math.max(60, config.notifications.intervalSeconds) * 1000;
    timer = setTimeout(async () => {
      try {
        if (loadConfig().notifications.enabled) await pollNotifications({ sweep: true });
      } catch (err) {
        console.warn("[notifications] poll error:", err instanceof Error ? err.message : err);
      }
      timer = null;
      schedule();
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  void getViewer().catch(() => undefined);
}
