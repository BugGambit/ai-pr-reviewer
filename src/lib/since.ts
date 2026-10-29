import type { AppConfig, Interdiff, PrDetail, SinceBaseline, SinceInfo } from "./types";
import { computeInterdiff, creditUpstream, pathsNeedingBase } from "./analysis/interdiff";
import { getDiffSnapshot, getFollowup, getPreviousReview, saveDiffSnapshot } from "./db";
import { ghGraphQl, prId } from "./gh";
import { fetchDiffAt } from "./github/detail";

const MAX_BASE_FILES = 100;

/**
 * Picks what "since" means for this PR, most specific first: your own
 * approval, then your last AI review, then anyone else's approval (useful on
 * your own PRs, where nobody else's review shows up under "you").
 */
export function pickBaseline(pr: PrDetail): SinceBaseline | null {
  if (pr.viewerApprovedSha && pr.viewerApprovedSha !== pr.headSha) {
    const review = pr.reviews.find((r) => r.state === "APPROVED" && r.commitOid === pr.viewerApprovedSha);
    return {
      kind: "approval",
      sha: pr.viewerApprovedSha,
      at: review?.submittedAt ? Date.parse(review.submittedAt) : null,
      by: null,
    };
  }

  const previous = getPreviousReview(prId(pr.owner, pr.repo, pr.number), pr.headSha);
  if (previous) return { kind: "review", sha: previous.headSha, at: previous.createdAt, by: null };

  // Dismissed approvals count: a push dismissing an approval is exactly the
  // moment a reader wants to know what the push changed.
  const approval = [...pr.reviews]
    .reverse()
    .find(
      (r) =>
        (r.state === "APPROVED" || r.state === "DISMISSED") &&
        r.commitOid &&
        r.commitOid !== pr.headSha &&
        r.author.login !== pr.author.login,
    );
  if (approval?.commitOid) {
    return {
      kind: "other-approval",
      sha: approval.commitOid,
      at: approval.submittedAt ? Date.parse(approval.submittedAt) : null,
      by: approval.author.login,
    };
  }
  return null;
}

type BlobNode = { text: string | null; isTruncated: boolean } | null;

/** All files in one GraphQL round trip, one aliased `object` lookup per path. */
async function baseFileContents(
  owner: string,
  repo: string,
  ref: string,
  paths: string[],
): Promise<Map<string, string | null>> {
  const wanted = paths.slice(0, MAX_BASE_FILES);
  const out = new Map<string, string | null>();
  if (wanted.length === 0) return out;

  const variables: Record<string, string> = { owner, repo };
  const fields = wanted.map((path, i) => {
    variables[`e${i}`] = `${ref}:${path}`;
    return `f${i}: object(expression: $e${i}) { ... on Blob { text isTruncated } }`;
  });
  const query = `query BaseFiles($owner: String!, $repo: String!, ${wanted.map((_, i) => `$e${i}: String!`).join(", ")}) {
  repository(owner: $owner, name: $repo) { ${fields.join("\n")} }
}`;

  try {
    const data = await ghGraphQl<{ repository: Record<string, BlobNode> }>(query, variables);
    wanted.forEach((path, i) => {
      const blob = data.repository[`f${i}`];
      // Null object = the base branch doesn't have the file, which is itself an answer.
      // Truncated or binary text can't be compared line by line, so leave those out.
      if (blob === null) out.set(path, null);
      else if (blob && blob.text !== null && !blob.isTruncated) out.set(path, blob.text);
    });
  } catch {
    // Without base contents nothing is credited upstream; the interdiff is still correct, just noisier.
  }
  return out;
}

const interdiffCache = new Map<string, Interdiff>();

export async function computeSince(pr: PrDetail, config: AppConfig): Promise<SinceInfo> {
  const id = prId(pr.owner, pr.repo, pr.number);
  const baseline = pickBaseline(pr);
  if (!baseline) return { baseline: null, unavailable: null, interdiff: null, followup: null };

  const followup = getFollowup(id, baseline.sha, pr.headSha);
  const cacheKey = `${id}:${baseline.sha}:${pr.headSha}`;
  const cached = interdiffCache.get(cacheKey);
  if (cached) return { baseline, unavailable: null, interdiff: cached, followup };

  if (!pr.diff || pr.diff.startsWith("(diff unavailable")) {
    return { baseline, unavailable: "The current diff could not be fetched.", interdiff: null, followup };
  }

  let from = getDiffSnapshot(id, baseline.sha);
  if (!from) {
    const fetched = await fetchDiffAt(pr.owner, pr.repo, pr.baseRefName, baseline.sha, config.review.maxDiffBytes);
    if (!fetched) {
      return {
        baseline,
        unavailable: `GitHub no longer serves commit ${baseline.sha.slice(0, 8)}, and no local snapshot of it exists.`,
        interdiff: null,
        followup,
      };
    }
    saveDiffSnapshot(id, baseline.sha, fetched.diff, fetched.truncated);
    from = { ...fetched, createdAt: Date.now() };
  }

  const raw = computeInterdiff(from.diff, pr.diff, {
    fromSha: baseline.sha,
    toSha: pr.headSha,
    partial: from.truncated || pr.diffTruncated,
  });
  const contents = await baseFileContents(pr.owner, pr.repo, pr.baseRefName, pathsNeedingBase(raw));
  const interdiff = creditUpstream(raw, contents);

  interdiffCache.set(cacheKey, interdiff);
  if (interdiffCache.size > 100) interdiffCache.delete(interdiffCache.keys().next().value as string);
  return { baseline, unavailable: null, interdiff, followup };
}
