import { checkGhAuth } from "@/lib/gh";
import { loadConfig, saveConfig } from "@/lib/config";
import { handle } from "@/lib/api";
import { kvGet, unreadNotificationCount } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const auth = await checkGhAuth();
    const config = loadConfig();

    // Remember who we are so filters like `viewerHasApproved` work offline.
    if (auth.ok && auth.login && config.viewer !== auth.login) {
      saveConfig({ ...config, viewer: auth.login });
    }

    return {
      auth,
      viewer: auth.login ?? config.viewer,
      org: config.org,
      filterCount: config.filters.filter((f) => f.enabled).length,
      unread: unreadNotificationCount(),
      lastPoll: Number(kvGet("notifications:lastPoll") ?? 0),
    };
  });
}
