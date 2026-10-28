import { handle } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { prefetchStatus, runPrefetch } from "@/lib/prefetch";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export async function GET() {
  return handle(async () => {
    const config = loadConfig();
    return { config: config.prefetch, ...prefetchStatus() };
  });
}

/** Kicks a prefetch pass immediately instead of waiting for the loop. */
export async function POST() {
  return handle(async () => {
    const logs: string[] = [];
    const result = await runPrefetch((line) => logs.push(line));
    return { ...result, logs, ...prefetchStatus() };
  });
}
