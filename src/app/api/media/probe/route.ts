import { bootstrap, fail, ok } from "@/lib/api";
import { fetchMedia, isAllowedMediaType } from "@/lib/media";

export const dynamic = "force-dynamic";

const cache = new Map<string, { kind: string; contentType: string | null; at: number }>();
const TTL = 30 * 60_000;

/**
 * GitHub attachment URLs carry no file extension, so a bare link could be a
 * screenshot or a screen recording. This reports which, so the renderer can
 * pick <img> or <video> instead of guessing.
 */
export async function GET(request: Request) {
  bootstrap();

  const target = new URL(request.url).searchParams.get("url");
  if (!target) return fail("Missing url parameter", 400);

  const cached = cache.get(target);
  if (cached && Date.now() - cached.at < TTL) {
    return ok({ kind: cached.kind, contentType: cached.contentType, cached: true });
  }

  try {
    // Some CDNs reject HEAD; fall back to a GET whose body is dropped at once.
    let result = await fetchMedia(target, { method: "HEAD" });
    if (!result.response.ok && result.response.status !== 206) {
      void result.response.body?.cancel();
      result = await fetchMedia(target, { method: "GET" });
    }

    const contentType = result.response.headers.get("content-type");
    void result.response.body?.cancel();

    const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
    const kind = !isAllowedMediaType(contentType)
      ? "other"
      : type.startsWith("video/")
        ? "video"
        : type.startsWith("audio/")
          ? "audio"
          : "image";

    if (cache.size > 500) cache.clear();
    cache.set(target, { kind, contentType, at: Date.now() });

    return ok({ kind, contentType, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return ok({ kind: "other", contentType: null, error: message });
  }
}
