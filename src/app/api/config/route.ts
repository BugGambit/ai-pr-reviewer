import { loadConfig, saveConfig } from "@/lib/config";
import { handle } from "@/lib/api";
import type { AppConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => loadConfig());
}

export async function PUT(request: Request) {
  return handle(async () => {
    const body = (await request.json()) as AppConfig;
    return saveConfig(body);
  });
}
