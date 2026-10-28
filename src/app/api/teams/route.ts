import { handle } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { getViewerTeams } from "@/lib/gh";

export const dynamic = "force-dynamic";

/** The viewer's teams, so notification muting can be a checklist not a guess. */
export async function GET() {
  return handle(async () => {
    const config = loadConfig();
    return { teams: await getViewerTeams(config.org), muted: config.notifications.mutedTeams };
  });
}
