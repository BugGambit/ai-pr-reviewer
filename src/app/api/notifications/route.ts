import { listNotifications, markNotificationsRead, unreadNotificationCount } from "@/lib/db";
import { pollNotifications, takeBrowserAlerts } from "@/lib/notifications";
import { kvGet } from "@/lib/db";
import { handle } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    if (url.searchParams.get("poll") === "true") {
      await pollNotifications({ sweep: false });
    }
    return {
      notifications: listNotifications(100),
      unread: unreadNotificationCount(),
      lastPoll: Number(kvGet("notifications:lastPoll") ?? 0),
      // Only a tab that has notification permission asks for these.
      alerts: url.searchParams.get("browser") === "1" ? takeBrowserAlerts() : [],
    };
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const { action, ids } = (await request.json()) as { action: string; ids?: string[] };
    if (action === "markRead") {
      const before = unreadNotificationCount();
      markNotificationsRead(ids);
      const after = unreadNotificationCount();
      return { unread: after, marked: Math.max(0, before - after) };
    }
    if (action === "poll") {
      // A button press skips the annotation sweep; the background loop does it.
      const { created } = await pollNotifications({ sweep: false });
      return { created: created.length, unread: unreadNotificationCount() };
    }
    throw new Error(`Unknown action: ${action}`);
  });
}
