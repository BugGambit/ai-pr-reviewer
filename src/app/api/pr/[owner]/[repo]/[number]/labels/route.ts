import { setLabels } from "@/lib/github/actions";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const { add, remove } = (await request.json()) as { add?: string[]; remove?: string[] };
    return setLabels(target, add ?? [], remove ?? []);
  });
}
