import { gh, ghGraphQl, getViewer, prId } from "../gh";
import { cachePr, readCachedPr, saveDiffSnapshot } from "../db";
import type { AppConfig, PrDetail } from "../types";
import { PR_CHECKS, PR_DETAIL } from "./queries";
import { normalizeChecks, normalizePrSummary, type RawPrNode, type RawRollup } from "./normalize";
import { parseDiff } from "../analysis/diff";

interface RawDetail extends Omit<RawPrNode, "commits" | "files"> {
  body: string;
  bodyHTML: string;
  state: string;
  files: {
    nodes: { path: string; additions: number; deletions: number; changeType: string }[];
    pageInfo: { hasNextPage: boolean };
  };
  commits: {
    nodes: {
      commit: {
        oid: string;
        messageHeadline: string;
        messageBody: string;
        committedDate: string;
        url: string;
        author: { name: string | null; user: { login: string } | null } | null;
      };
    }[];
  };
  comments: {
    nodes: {
      id: string;
      body: string;
      bodyHTML: string;
      createdAt: string;
      url: string;
      author: { login: string; avatarUrl: string | null } | null;
    }[];
  };
  reviews: {
    nodes: {
      id: string;
      body: string;
      bodyHTML: string;
      state: string;
      submittedAt: string | null;
      url: string;
      author: { login: string; avatarUrl: string | null } | null;
      commit: { oid: string } | null;
    }[];
  };
  reviewThreads: {
    nodes: {
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string | null;
      line: number | null;
      comments: {
        nodes: {
          id: string;
          body: string;
          bodyHTML: string;
          createdAt: string;
          url: string;
          diffHunk: string | null;
          path: string | null;
          line: number | null;
          author: { login: string; avatarUrl: string | null } | null;
        }[];
      };
    }[];
  };
}

const USER = (a: { login: string; avatarUrl: string | null } | null) => ({
  login: a?.login ?? "ghost",
  avatarUrl: a?.avatarUrl ?? null,
});

/** Fetches the raw unified diff, truncating on a file boundary when oversized. */
export async function fetchDiff(
  owner: string,
  repo: string,
  number: number,
  maxBytes: number,
): Promise<{ diff: string; truncated: boolean; bytes: number }> {
  let diff = "";
  try {
    diff = await gh([
      "api",
      `repos/${owner}/${repo}/pulls/${number}`,
      "-H",
      "Accept: application/vnd.github.v3.diff",
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { diff: `(diff unavailable: ${message})`, truncated: false, bytes: 0 };
  }
  return truncateDiff(diff, maxBytes);
}

/**
 * The net diff of an older head commit against the base branch, for PR
 * versions we never snapshotted. GitHub keeps force-pushed-away commits
 * reachable for a while, but not forever, hence the null.
 */
export async function fetchDiffAt(
  owner: string,
  repo: string,
  baseRef: string,
  sha: string,
  maxBytes: number,
): Promise<{ diff: string; truncated: boolean } | null> {
  try {
    const diff = await gh([
      "api",
      `repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${sha}`,
      "-H",
      "Accept: application/vnd.github.v3.diff",
    ]);
    return truncateDiff(diff, maxBytes);
  } catch {
    return null;
  }
}

function truncateDiff(diff: string, maxBytes: number): { diff: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(diff, "utf8");
  if (bytes <= maxBytes) return { diff, truncated: false, bytes };

  const slice = diff.slice(0, maxBytes);
  const lastFile = slice.lastIndexOf("\ndiff --git ");
  const cut = lastFile > maxBytes * 0.4 ? slice.slice(0, lastFile) : slice;
  return {
    diff: `${cut}\n\n[diff truncated: ${bytes} bytes total, showing ${Buffer.byteLength(cut, "utf8")}]`,
    truncated: true,
    bytes,
  };
}

/**
 * The GraphQL `files` connection caps at 100 per page. Rather than paginate,
 * anything beyond that is recovered from the diff we already fetched.
 */
function mergeFiles(
  connection: RawDetail["files"],
  diff: string,
): PrDetail["files"] {
  const files: PrDetail["files"] = connection.nodes.map((f) => ({
    path: f.path,
    previousPath: null,
    changeType: f.changeType,
    additions: f.additions,
    deletions: f.deletions,
  }));

  if (!connection.pageInfo.hasNextPage || !diff) return files;

  const known = new Set(files.map((f) => f.path));
  for (const file of parseDiff(diff)) {
    if (known.has(file.path)) continue;
    known.add(file.path);
    files.push({
      path: file.path,
      previousPath: file.isRename ? file.oldPath : null,
      changeType: file.isNew ? "ADDED" : file.isDeleted ? "DELETED" : file.isRename ? "RENAMED" : "MODIFIED",
      additions: file.additions,
      deletions: file.deletions,
    });
  }
  return files;
}

export async function fetchPrDetail(
  owner: string,
  repo: string,
  number: number,
  config: AppConfig,
  opts: { maxAgeMs?: number; skipDiff?: boolean } = {},
): Promise<PrDetail> {
  const id = prId(owner, repo, number);
  const maxAge = opts.maxAgeMs ?? 0;
  if (maxAge > 0) {
    const cached = readCachedPr<PrDetail>(id, maxAge);
    if (cached) return cached;
  }

  const viewer = config.viewer || (await getViewer()).login;

  const [data, checksData, diffResult] = await Promise.all([
    ghGraphQl<{
      repository: { defaultBranchRef: { name: string } | null; pullRequest: RawDetail | null };
    }>(PR_DETAIL, { owner, repo, number }),
    ghGraphQl<{
      repository: {
        pullRequest: { commits: { nodes: { commit: { oid: string; statusCheckRollup: RawRollup | null } }[] } } | null;
      };
    }>(PR_CHECKS, { owner, repo, number }).catch(() => null),
    opts.skipDiff
      ? Promise.resolve({ diff: "", truncated: false, bytes: 0 })
      : fetchDiff(owner, repo, number, config.review.maxDiffBytes),
  ]);

  const node = data.repository?.pullRequest;
  if (!node) throw new Error(`Pull request ${id} not found (or no access)`);

  const headCommit = checksData?.repository?.pullRequest?.commits?.nodes?.[0]?.commit;
  const rollup = headCommit?.statusCheckRollup ?? null;
  const { state: checkState, checks, failing } = normalizeChecks(rollup);

  // The summary normalizer expects the search-shaped `commits(last: 1)` node.
  const summary = normalizePrSummary(
    {
      ...node,
      files: {
        nodes: node.files.nodes.map((f) => ({ path: f.path })),
        pageInfo: node.files.pageInfo,
      },
      commits: { nodes: headCommit ? [{ commit: headCommit }] : [] },
    },
    viewer,
  );

  const detail: PrDetail = {
    ...summary,
    checkState,
    failingChecks: failing,
    checks,
    body: node.body ?? "",
    bodyHtml: node.bodyHTML ?? "",
    state: (node.state as PrDetail["state"]) ?? "OPEN",
    baseRepoDefaultBranch: data.repository?.defaultBranchRef?.name ?? "master",
    files: mergeFiles(node.files, diffResult.diff),
    commits: node.commits.nodes.map(({ commit }) => ({
      oid: commit.oid,
      messageHeadline: commit.messageHeadline,
      messageBody: commit.messageBody ?? "",
      author: commit.author?.user?.login ?? commit.author?.name ?? "unknown",
      committedDate: commit.committedDate,
      url: commit.url,
    })),
    comments: node.comments.nodes.map((c) => ({
      id: c.id,
      author: USER(c.author),
      body: c.body ?? "",
      bodyHtml: c.bodyHTML ?? "",
      createdAt: c.createdAt,
      url: c.url,
    })),
    reviews: node.reviews.nodes
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({
        id: r.id,
        author: USER(r.author),
        state: r.state,
        body: r.body ?? "",
        bodyHtml: r.bodyHTML ?? "",
        submittedAt: r.submittedAt,
        url: r.url,
        commitOid: r.commit?.oid ?? null,
      })),
    reviewThreads: node.reviewThreads.nodes.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line,
      comments: t.comments.nodes.map((c) => ({
        id: c.id,
        author: USER(c.author),
        body: c.body ?? "",
        bodyHtml: c.bodyHTML ?? "",
        createdAt: c.createdAt,
        url: c.url,
        path: c.path,
        line: c.line,
        diffHunk: c.diffHunk,
      })),
    })),
    diff: diffResult.diff,
    diffTruncated: diffResult.truncated,
    diffBytes: diffResult.bytes,
  };

  cachePr(id, detail.headSha, detail);
  if (!opts.skipDiff && !diffResult.diff.startsWith("(diff unavailable")) {
    saveDiffSnapshot(id, detail.headSha, diffResult.diff, diffResult.truncated);
  }
  return detail;
}
