import { loadConfig } from "@/lib/config";
import { parsePrReference } from "@/lib/gh";
import { handle } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const { input } = (await request.json()) as { input: string };
    const config = loadConfig();
    const parsed = parsePrReference(input ?? "", config.org);
    if (!parsed) {
      throw new Error(
        "Could not resolve that reference. Use a GitHub PR URL, owner/repo#123, or repo#123.",
      );
    }
    return parsed;
  });
}
