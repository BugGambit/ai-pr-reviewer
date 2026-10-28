import { clearPrState, getPrState, setPrState, type PrStatus } from "@/lib/db";
import { prId } from "@/lib/gh";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";

export const dynamic = "force-dynamic";

const STATUSES = new Set<PrStatus>(["snoozed", "ignored", "muted"]);

export async function GET(_request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const t = await prTarget(params);
    return { state: getPrState(prId(t.owner, t.repo, t.number)) };
  });
}

/**
 * Sets triage state. `durationMs` snoozes for a fixed window; omitting it with
 * `untilNewCommits` snoozes until the author pushes again.
 */
export async function POST(request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const t = await prTarget(params);
    const id = prId(t.owner, t.repo, t.number);
    const body = (await request.json()) as {
      status: PrStatus | "active";
      durationMs?: number;
      headSha?: string;
      note?: string;
    };

    if (body.status === "active") {
      clearPrState(id);
      return { state: null };
    }
    if (!STATUSES.has(body.status)) throw new Error(`Unknown status: ${body.status}`);

    setPrState({
      prId: id,
      status: body.status,
      until: body.durationMs ? Date.now() + body.durationMs : null,
      pinnedSha: body.headSha ?? null,
      note: body.note ?? null,
    });
    return { state: getPrState(id) };
  });
}
