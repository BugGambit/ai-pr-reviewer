import { NextResponse } from "next/server";
import { bootstrap, fail } from "@/lib/api";
import { fetchMedia, isAllowedMediaType } from "@/lib/media";
import { loadConfig } from "@/lib/config";
import { fetchPrDetail } from "@/lib/github/detail";
import { parsePrId } from "@/lib/gh";

export const dynamic = "force-dynamic";

const MAX_BYTES = 80 * 1024 * 1024;

/** The stable part of a signed GitHub asset path, e.g. "123456789-abcd…mov". */
function assetKey(raw: string): string | null {
  try {
    const { pathname } = new URL(raw);
    const basename = pathname.split("/").pop();
    return basename || null;
  } catch {
    return null;
  }
}

/**
 * GitHub signs private attachment URLs with a JWT that expires in minutes, so
 * a page left open ends up with dead images. Re-render the PR body to mint a
 * fresh URL for the same asset.
 */
async function refreshAssetUrl(prId: string, staleUrl: string): Promise<string | null> {
  const key = assetKey(staleUrl);
  const target = parsePrId(prId);
  if (!key || !target) return null;

  try {
    const pr = await fetchPrDetail(target.owner, target.repo, target.number, loadConfig(), {
      maxAgeMs: 0,
      skipDiff: true,
    });

    const haystack = [
      pr.bodyHtml,
      ...pr.comments.map((c) => c.bodyHtml),
      ...pr.reviews.map((r) => r.bodyHtml),
      ...pr.reviewThreads.flatMap((t) => t.comments.map((c) => c.bodyHtml)),
    ].join("\n");

    for (const match of haystack.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const candidate = match[1].replace(/&amp;/g, "&");
      if (assetKey(candidate) === key) return candidate;
    }
  } catch (err) {
    console.warn("[media] refresh failed:", err instanceof Error ? err.message : err);
  }
  return null;
}

/**
 * Streams a PR asset through this server. Two reasons it is not a plain
 * <img src>: private attachments need credentials the browser won't send
 * cross-origin, and proxying keeps the reviewer's IP out of whatever host a PR
 * author chose to embed.
 */
export async function GET(request: Request) {
  bootstrap();

  const params = new URL(request.url).searchParams;
  const target = params.get("url");
  const prId = params.get("pr");
  if (!target) return fail("Missing url parameter", 400);

  const range = request.headers.get("range");

  const deliver = async (url: string) => fetchMedia(url, { range });

  try {
    let { response } = await deliver(target);

    // An expired signature shows up as 401/403 (sometimes 404 from storage).
    if ([401, 403, 404].includes(response.status) && prId) {
      void response.body?.cancel();
      const fresh = await refreshAssetUrl(prId, target);
      if (!fresh) return fail(`Asset unavailable (upstream ${response.status})`, 404);
      ({ response } = await deliver(fresh));
    }

    if (!response.ok && response.status !== 206) {
      void response.body?.cancel();
      return fail(`Upstream responded ${response.status}`, response.status === 404 ? 404 : 502);
    }

    const contentType = response.headers.get("content-type");
    if (!isAllowedMediaType(contentType)) {
      void response.body?.cancel();
      return fail(`Blocked content type: ${contentType ?? "unknown"}`, 415);
    }

    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
      void response.body?.cancel();
      return fail("Asset too large to proxy", 413);
    }

    const headers = new Headers({
      "Content-Type": contentType!,
      // Short cache: the upstream signature expires, and a stale 403 would be
      // worse than re-fetching.
      "Cache-Control": "private, max-age=240",
      "Content-Disposition": "inline",
      // Proxied bytes are author-controlled: never let them act as content.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    });

    for (const header of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = response.headers.get(header);
      if (value) headers.set(header, value);
    }

    return new NextResponse(response.body, { status: response.status, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[media] proxy failed:", message);
    return fail(message, /Blocked|valid URL|resolve/.test(message) ? 400 : 502);
  }
}
