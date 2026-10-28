import { getJob } from "@/lib/jobs";
import { handle } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    return getJob(decodeURIComponent(id)) ?? { id, status: "unknown", logs: [], message: "" };
  });
}
