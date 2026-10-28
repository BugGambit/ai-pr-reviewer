import { NextResponse } from "next/server";
import { reapStaleReviews } from "./db";
import { startNotificationPoller } from "./notifications";
import { startPrefetchLoop } from "./prefetch";

let bootstrapped = false;

/** Idempotent server-side startup, triggered by the first API request. */
export function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  try {
    reapStaleReviews();
    startNotificationPoller();
    startPrefetchLoop();
  } catch (err) {
    console.error("[bootstrap] failed:", err);
  }
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, init);
}

export function fail(message: string, status = 500, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/** Wraps a handler so a thrown error becomes a readable JSON response. */
export async function handle<T>(fn: () => Promise<T>): Promise<NextResponse> {
  bootstrap();
  try {
    return ok(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api]", message);
    const notFound = /not found|no access|Could not resolve/i.test(message);
    const auth = /auth|credential|401|403/i.test(message);
    return fail(message, notFound ? 404 : auth ? 401 : 500);
  }
}

export interface PrRouteParams {
  owner: string;
  repo: string;
  number: string;
}

export async function prTarget(
  params: Promise<PrRouteParams>,
): Promise<{ owner: string; repo: string; number: number }> {
  const { owner, repo, number } = await params;
  const parsed = Number(number);
  if (!owner || !repo || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid pull request reference: ${owner}/${repo}#${number}`);
  }
  return { owner, repo, number: parsed };
}
