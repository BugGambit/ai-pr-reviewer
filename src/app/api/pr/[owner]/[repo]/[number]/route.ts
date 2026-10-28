import { loadConfig } from "@/lib/config";
import { fetchPrDetail } from "@/lib/github/detail";
import { getLatestReview, getReviewHistory, listActions, listScreenshots } from "@/lib/db";
import { analyzeDiff } from "@/lib/analysis/heuristics";
import { prId } from "@/lib/gh";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const config = loadConfig();
    const fresh = new URL(request.url).searchParams.get("refresh") === "true";

    const pr = await fetchPrDetail(target.owner, target.repo, target.number, config, {
      maxAgeMs: fresh ? 0 : 60_000,
    });
    const id = prId(target.owner, target.repo, target.number);

    // Heuristics are cheap and deterministic, so they are always current even
    // when no model review has been run yet.
    const heuristics = analyzeDiff(pr.diff, {
      title: pr.title,
      body: pr.body,
      comments: pr.comments.map((c) => ({ author: c.author.login, body: c.body })),
    });

    // A review is keyed to the commit it read. When the author pushes again the
    // old review is still informative, so it is returned separately rather than
    // silently dropped.
    const review = getLatestReview(id, pr.headSha);
    const previous = review ? null : getLatestReview(id);

    return {
      pr,
      heuristics,
      review,
      staleReview: previous && previous.headSha !== pr.headSha ? previous : null,
      history: getReviewHistory(id),
      screenshots: listScreenshots(id, pr.headSha),
      actions: listActions(id),
      approvalConfig: config.approval,
      reviewConfig: config.review,
      screenshotConfigured: Boolean(
        config.screenshots.enabled && config.screenshots.repos[`${target.owner}/${target.repo}`]?.enabled,
      ),
    };
  });
}
