import { execFile } from "node:child_process";

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "GhError";
  }
}

export interface GhRunOptions {
  /** Written to the child's stdin. */
  input?: string;
  timeoutMs?: number;
  /** Bytes of stdout to buffer. GraphQL responses for big PRs get large. */
  maxBuffer?: number;
  cwd?: string;
}

/**
 * Runs the GitHub CLI. Arguments are passed as an array and never go through a
 * shell, so repo names / branch names coming from the API can't inject
 * commands.
 */
export function gh(args: string[], opts: GhRunOptions = {}): Promise<string> {
  const { input, timeoutMs = 120_000, maxBuffer = 64 * 1024 * 1024, cwd } = opts;

  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      { timeout: timeoutMs, maxBuffer, cwd, env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" } },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as unknown as { code: number }).code)
            : null;
          reject(
            new GhError(
              `gh ${args.slice(0, 3).join(" ")} failed: ${stderr?.trim() || err.message}`,
              stderr ?? "",
              code,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );

    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export async function ghJson<T>(args: string[], opts: GhRunOptions = {}): Promise<T> {
  const out = await gh(args, opts);
  return JSON.parse(out) as T;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: { message: string; type?: string; path?: (string | number)[] }[];
}

/**
 * POSTs a GraphQL document through `gh api graphql`, reusing the user's
 * existing (SSO-authorised) CLI session.
 */
export async function ghGraphQl<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: GhRunOptions = {},
): Promise<T> {
  const body = JSON.stringify({ query, variables });
  const raw = await gh(["api", "graphql", "--input", "-"], { ...opts, input: body });
  const parsed = JSON.parse(raw) as GraphQlResponse<T>;

  if (parsed.errors?.length) {
    // Partial data with errors is common when a single field is inaccessible
    // (e.g. a check on a fork). Only hard-fail when nothing came back.
    const message = parsed.errors.map((e) => e.message).join("; ");
    if (!parsed.data) throw new GhError(`GraphQL error: ${message}`, message, null);
    console.warn(`[gh] partial GraphQL response: ${message}`);
  }
  if (!parsed.data) throw new GhError("GraphQL returned no data", raw.slice(0, 2000), null);
  return parsed.data;
}

let viewerCache: { login: string; name: string } | null = null;

export async function getViewer(): Promise<{ login: string; name: string }> {
  if (viewerCache) return viewerCache;
  const data = await ghJson<{ login: string; name: string | null }>([
    "api",
    "user",
    "--jq",
    "{login: .login, name: .name}",
  ]);
  viewerCache = { login: data.login, name: data.name ?? data.login };
  return viewerCache;
}

export async function checkGhAuth(): Promise<{ ok: boolean; message: string; login?: string }> {
  try {
    const viewer = await getViewer();
    return { ok: true, message: `Authenticated as ${viewer.login}`, login: viewer.login };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: message.includes("gh: command not found") || message.includes("ENOENT")
        ? "GitHub CLI not found on PATH. Install it from https://cli.github.com/"
        : `GitHub CLI is not authenticated. Run: gh auth login --scopes repo,read:org\n${message}`,
    };
  }
}

/** owner/repo#number <-> parts */
export function prId(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

export function parsePrId(id: string): { owner: string; repo: string; number: number } | null {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** Accepts a full PR URL, `owner/repo#123`, or `owner/repo/pull/123`. */
export function parsePrReference(
  input: string,
  defaultOrg?: string,
): { owner: string; repo: string; number: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(trimmed);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };

  const hash = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(trimmed);
  if (hash) return { owner: hash[1], repo: hash[2], number: Number(hash[3]) };

  const slashed = /^([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/.exec(trimmed);
  if (slashed) return { owner: slashed[1], repo: slashed[2], number: Number(slashed[3]) };

  // "repo#123" or "repo 123" against the configured org.
  if (defaultOrg) {
    const short = /^([^/#\s]+)[#\s]+(\d+)$/.exec(trimmed);
    if (short) return { owner: defaultOrg, repo: short[1], number: Number(short[2]) };
  }
  return null;
}

let teamCache: { teams: string[]; at: number } | null = null;

/**
 * The viewer's team slugs in an org. GitHub expands a team review request to
 * every member, so these are the identities a "review requested" notification
 * can actually arrive through.
 */
export async function getViewerTeams(org: string): Promise<string[]> {
  if (teamCache && Date.now() - teamCache.at < 30 * 60_000) return teamCache.teams;
  try {
    const raw = await gh([
      "api",
      "user/teams",
      "--paginate",
      "--jq",
      // No org configured: every team I'm in, wherever it lives.
      org ? `[.[] | select(.organization.login=="${org}") | .slug]` : "[.[] | .slug]",
    ]);
    // --paginate emits one JSON array per page.
    const teams = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return JSON.parse(line) as string[];
        } catch {
          return [];
        }
      });
    teamCache = { teams: [...new Set(teams)], at: Date.now() };
  } catch (err) {
    console.warn("[gh] could not list teams:", err instanceof Error ? err.message : err);
    teamCache = { teams: [], at: Date.now() };
  }
  return teamCache.teams;
}
