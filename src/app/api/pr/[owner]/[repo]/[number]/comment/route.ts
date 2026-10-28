import { commentOnPr, replyToThread } from "@/lib/github/actions";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const { body, inReplyTo } = (await request.json()) as { body: string; inReplyTo?: number };
    if (!body?.trim()) throw new Error("Comment body is empty");

    return inReplyTo
      ? replyToThread(target, inReplyTo, body)
      : commentOnPr(target, body);
  });
}
