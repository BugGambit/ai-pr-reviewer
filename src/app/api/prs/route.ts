import { loadConfig } from "@/lib/config";
import { listPrs } from "@/lib/github/list";
import { handle } from "@/lib/api";
import type { PrSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

const BUCKET_ORDER = ["ready", "blocked", "done", "snoozed"] as const;

export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const config = loadConfig();
    const filterIds = url.searchParams.getAll("filter");

    const { prs, errors, queriesRun } = await listPrs(config, {
      filterIds: filterIds.length > 0 ? filterIds : undefined,
    });

    // The client renders sections rather than one flat list, so grouping
    // happens here where the ranking already lives.
    const groups: Record<string, PrSummary[]> = Object.fromEntries(
      BUCKET_ORDER.map((bucket) => [bucket, []]),
    );
    for (const pr of prs) {
      const bucket = pr.attention?.bucket ?? "ready";
      (groups[bucket] ?? groups.ready).push(pr);
    }

    return {
      groups,
      counts: Object.fromEntries(BUCKET_ORDER.map((b) => [b, groups[b].length])),
      total: prs.length,
      errors,
      queriesRun,
      filters: config.filters.map((f) => ({ id: f.id, name: f.name, enabled: f.enabled })),
    };
  });
}
