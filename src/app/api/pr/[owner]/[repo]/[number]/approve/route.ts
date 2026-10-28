import { loadConfig } from "@/lib/config";
import { approvePr, listRepoLabels } from "@/lib/github/actions";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Reports which configured approval labels actually exist on the repo. */
export async function GET(_request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const config = loadConfig();
    const labels = await listRepoLabels(target.owner, target.repo);
    return {
      approval: config.approval,
      repoLabels: labels,
      missingLabels: config.approval.labels.filter((l) => labels.length > 0 && !labels.includes(l)),
    };
  });
}

export async function POST(request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const config = loadConfig();
    const overrides = (await request.json().catch(() => ({}))) as Partial<typeof config.approval>;
    return approvePr(target, config, overrides);
  });
}
