import { loadConfig } from "@/lib/config";
import { fetchPrDetail } from "@/lib/github/detail";
import { computeSince } from "@/lib/since";
import { runFollowup } from "@/lib/claude/followup";
import { getJob, runJob, setFollowupPartial } from "@/lib/jobs";
import { prId } from "@/lib/gh";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const jobKey = (id: string) => `followup:${id}`;

/** What changed in the PR since your approval / last review, compared by net diff. */
export async function GET(_request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const config = loadConfig();
    const id = prId(target.owner, target.repo, target.number);
    const pr = await fetchPrDetail(target.owner, target.repo, target.number, config, { maxAgeMs: 30_000 });
    const since = await computeSince(pr, config);
    return { ...since, headSha: pr.headSha, job: getJob(jobKey(id)) };
  });
}

/** Starts the follow-up review of the delta. Cached per (baseline, head) pair. */
export async function POST(request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const config = loadConfig();
    const id = prId(target.owner, target.repo, target.number);
    const body = (await request.json().catch(() => ({}))) as { force?: boolean };

    const running = getJob(jobKey(id));
    if (running?.status === "running") return { started: false, reason: "already-running", job: running };

    const pr = await fetchPrDetail(target.owner, target.repo, target.number, config, { maxAgeMs: 30_000 });
    const since = await computeSince(pr, config);
    if (!since.baseline || !since.interdiff) {
      return { started: false, reason: since.unavailable ?? "no-baseline" };
    }
    if (since.followup?.status === "done" && !body.force) {
      return { started: false, reason: "cached", followup: since.followup };
    }

    const job = runJob(jobKey(id), "followup", async (log) => {
      await runFollowup(pr, config, since, {
        onLog: log,
        onPartial: (partial) => setFollowupPartial(jobKey(id), partial),
      });
    });
    return { started: true, job };
  });
}
