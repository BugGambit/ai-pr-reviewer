import { loadConfig } from "@/lib/config";
import { fetchPrDetail } from "@/lib/github/detail";
import { getLatestReview, listScreenshots } from "@/lib/db";
import { captureScreenshots } from "@/lib/screenshots/capture";
import { getJob, runJob } from "@/lib/jobs";
import { prId } from "@/lib/gh";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 2400;

const jobKey = (id: string) => `shots:${id}`;

export async function GET(_request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const id = prId(target.owner, target.repo, target.number);
    return { screenshots: listScreenshots(id), job: getJob(jobKey(id)) };
  });
}

export async function POST(_request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const config = loadConfig();
    const id = prId(target.owner, target.repo, target.number);

    const existing = getJob(jobKey(id));
    if (existing?.status === "running") return { started: false, reason: "already-running", job: existing };

    const pr = await fetchPrDetail(target.owner, target.repo, target.number, config, {
      maxAgeMs: 60_000,
      skipDiff: true,
    });

    // Routes Claude suggested during review are captured alongside the
    // configured ones.
    const review = getLatestReview(id, pr.headSha);
    const extraRoutes = (review?.result?.screenshotSuggestions ?? []).map((s) => ({
      label: s.label,
      route: s.route,
    }));

    const job = runJob(jobKey(id), "screenshots", async (log) => {
      await captureScreenshots(pr, config, { extraRoutes, log });
    });

    return { started: true, job };
  });
}
