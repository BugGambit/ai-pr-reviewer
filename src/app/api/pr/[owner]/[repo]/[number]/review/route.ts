import { loadConfig } from "@/lib/config";
import { fetchPrDetail } from "@/lib/github/detail";
import { getLatestReview } from "@/lib/db";
import { runReview } from "@/lib/claude/run";
import { getJob, runJob, setPartial } from "@/lib/jobs";
import { prId } from "@/lib/gh";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

const jobKey = (id: string) => `review:${id}`;

export async function GET(_request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const id = prId(target.owner, target.repo, target.number);
    return { review: getLatestReview(id), job: getJob(jobKey(id)) };
  });
}

/**
 * Starts a review. A review is cached per head SHA, so this is a no-op unless
 * the PR has new commits or `force` is set — that's what keeps token spend to
 * one review per PR.
 */
export async function POST(request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const config = loadConfig();
    const id = prId(target.owner, target.repo, target.number);

    const body = (await request.json().catch(() => ({}))) as {
      force?: boolean;
      mode?: "standard" | "deep";
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
    };

    const running = getJob(jobKey(id));
    if (running?.status === "running") {
      return { started: false, reason: "already-running", job: running };
    }

    const pr = await fetchPrDetail(target.owner, target.repo, target.number, config, { maxAgeMs: 30_000 });
    const existing = getLatestReview(id, pr.headSha);

    if (existing && existing.status === "done" && !body.force) {
      return { started: false, reason: "cached", review: existing };
    }

    const job = runJob(jobKey(id), "review", async (log) => {
      await runReview(pr, config, {
        mode: body.mode,
        model: body.model,
        effort: body.effort,
        onLog: log,
        onPartial: (partial) => setPartial(jobKey(id), partial),
      });
    });

    return { started: true, job };
  });
}
