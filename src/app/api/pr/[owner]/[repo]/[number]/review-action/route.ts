import { submitReview } from "@/lib/github/actions";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";
import type { SuggestedReviewComment } from "@/lib/types";

export const dynamic = "force-dynamic";

const EVENTS = new Set(["REQUEST_CHANGES", "COMMENT", "APPROVE"]);

export async function POST(request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const { event, body, comments } = (await request.json()) as {
      event: string;
      body: string;
      comments?: SuggestedReviewComment[];
    };

    if (!EVENTS.has(event)) throw new Error(`Unsupported review event: ${event}`);
    if (event !== "APPROVE" && !body?.trim() && (comments ?? []).length === 0) {
      throw new Error("Provide a review body or at least one inline comment");
    }

    return submitReview(
      target,
      event as "REQUEST_CHANGES" | "COMMENT" | "APPROVE",
      body ?? "",
      comments ?? [],
    );
  });
}
