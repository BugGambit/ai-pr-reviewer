import dns from "node:dns/promises";
import net from "node:net";
import { gh } from "./gh";

/** Hosts whose assets live behind GitHub auth and need our token attached. */
const GITHUB_ASSET_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "media.githubusercontent.com",
  "avatars.githubusercontent.com",
]);

export function isGitHubAssetHost(hostname: string): boolean {
  return GITHUB_ASSET_HOSTS.has(hostname.toLowerCase());
}

/** A bare link to one of these is GitHub's own uploaded-attachment form. */
export function isGitHubAttachmentUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!isGitHubAssetHost(url.hostname)) return false;
    return (
      /^\/user-attachments\/assets\//.test(url.pathname) ||
      url.hostname.endsWith("githubusercontent.com")
    );
  } catch {
    return false;
  }
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (/^f[cd]/.test(lower)) return true; // unique local
    if (lower.startsWith("fe80")) return true; // link-local
    // IPv4-mapped (::ffff:10.0.0.1)
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

/**
 * The URLs we fetch come out of PR descriptions, which are attacker-controlled,
 * so the proxy must not become a probe into the machine's own network. The
 * hostname is resolved and every resulting address checked before the request
 * goes out — a name that resolves to a private address is rejected.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked protocol: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Blocked host");
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Blocked address");
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new Error(`Could not resolve ${host}`);
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new Error("Blocked address");
  }
  return url;
}

let tokenCache: { token: string | null; at: number } | null = null;

/** Reads the CLI's token, cached, so each asset doesn't spawn a subprocess. */
export async function getGitHubToken(): Promise<string | null> {
  if (tokenCache && Date.now() - tokenCache.at < 10 * 60_000) return tokenCache.token;
  try {
    const token = (await gh(["auth", "token"], { timeoutMs: 10_000 })).trim();
    tokenCache = { token: token || null, at: Date.now() };
  } catch {
    tokenCache = { token: null, at: Date.now() };
  }
  return tokenCache.token;
}

export const ALLOWED_MEDIA_PREFIXES = ["image/", "video/", "audio/"];

export function isAllowedMediaType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_MEDIA_PREFIXES.some((prefix) => type.startsWith(prefix));
}

export interface FetchedMedia {
  response: Response;
  finalUrl: string;
}

/**
 * Follows redirects by hand so every hop is re-validated — GitHub attachment
 * URLs bounce to signed storage, and an open redirect on any hop would
 * otherwise sidestep the SSRF check.
 */
export async function fetchMedia(
  rawUrl: string,
  init: { range?: string | null; method?: "GET" | "HEAD" } = {},
): Promise<FetchedMedia> {
  const maxHops = 5;
  let current = rawUrl;

  for (let hop = 0; hop < maxHops; hop++) {
    const url = await assertSafeUrl(current);

    const headers: Record<string, string> = {
      // GitHub serves attachments differently without a browser-ish UA.
      "User-Agent": "pr-reviewer/1.0",
      Accept: "image/*,video/*,audio/*;q=0.9,*/*;q=0.5",
    };
    if (init.range) headers.Range = init.range;

    // Only our own token's host gets the token — never a redirect target that
    // happens to be third-party storage with its own signature.
    if (isGitHubAssetHost(url.hostname)) {
      const token = await getGitHubToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url.toString(), {
      method: init.method ?? "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect without location from ${url.hostname}`);
      void response.body?.cancel();
      current = new URL(location, url).toString();
      continue;
    }

    return { response, finalUrl: url.toString() };
  }

  throw new Error("Too many redirects");
}
