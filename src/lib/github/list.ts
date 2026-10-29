import { minimatch } from "minimatch";
import { getViewer, ghGraphQl } from "../gh";
import { expireSnoozes, getReviewVerdicts, listPrStates } from "../db";
import { isApprovalStale, isHidden, scoreAttention } from "../attention";
import { buildStacks } from "../stacks";
import type { AppConfig, PrFilter, PrSummary } from "../types";
import { searchPrsQuery } from "./queries";
import { normalizePrSummary, type RawPrNode } from "./normalize";

interface PlannedQuery {
  filterId: string;
  filterName: string;
  q: string;
  /** When set, a PR only counts if one of its changed paths matches. */
  globs?: string[];
}

function quoteIfNeeded(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

/**
 * A filter's `repos` list scopes the search; `authors`, `teams` and `paths` are
 * OR'd criteria within that scope. GitHub search ANDs different qualifiers, so
 * each criterion needs its own query and the results get unioned.
 */
export function planQueries(filter: PrFilter, org: string): PlannedQuery[] {
  const base: string[] = ["is:pr", "is:open", "archived:false"];
  if (!filter.includeDrafts) base.push("-is:draft");
  for (const label of filter.labels) base.push(`label:${quoteIfNeeded(label)}`);
  for (const author of filter.excludeAuthors) base.push(`-author:${author}`);
  if (filter.onlyReviewRequested) base.push("review-requested:@me");

  // Without repos or an org, author/team criteria search all of GitHub.
  const scope =
    filter.repos.length > 0 ? filter.repos.map((r) => `repo:${r}`) : org ? [`org:${org}`] : [];

  const queries: PlannedQuery[] = [];
  const add = (extra: string[], globs?: string[], scopeOverride?: string[]) =>
    queries.push({
      filterId: filter.id,
      filterName: filter.name,
      q: [...base, ...(scopeOverride ?? scope), ...extra].join(" "),
      globs,
    });

  if (filter.authors.length > 0) {
    // Same qualifier repeated is OR'd by GitHub search, so one query covers all.
    add(filter.authors.map((a) => `author:${a}`));
  }
  for (const team of filter.teams) {
    // A bare team slug only means something inside an org.
    const slug = team.includes("/") ? team : org ? `${org}/${team}` : null;
    if (slug) add([`team-review-requested:${slug}`]);
  }
  for (const pathFilter of filter.paths) {
    if (!pathFilter.repo || pathFilter.globs.length === 0) continue;
    add([], pathFilter.globs, [`repo:${pathFilter.repo}`]);
  }

  // With no author/team/path criterion the filter means "everything in scope".
  // That is only safe when something else narrows it — an explicit repo list,
  // required labels, or review-requested — otherwise it would ask for every
  // open PR in the org.
  if (queries.length === 0) {
    const narrowed =
      filter.repos.length > 0 || filter.labels.length > 0 || filter.onlyReviewRequested;
    if (narrowed) add([]);
  }

  return queries;
}

/** Normalises user-entered globs so `apps/web` behaves like `apps/web/**`. */
export function pathMatches(paths: string[], globs: string[]): boolean {
  const expanded = globs.flatMap((g) => {
    const clean = g.replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!clean) return [];
    return clean.includes("*") ? [clean] : [clean, `${clean}/**`];
  });
  return paths.some((p) => expanded.some((g) => minimatch(p, g, { dot: true })));
}

interface SearchPage {
  search: { nodes: (RawPrNode | null)[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

/**
 * GitHub answers 502 when a search page is too expensive to resolve. Rather
 * than fail the whole filter, back the page size off and try again.
 */
async function runSearch(
  q: string,
  viewer: string,
  limit: number,
  includeFiles: boolean,
): Promise<PrSummary[]> {
  const query = searchPrsQuery(includeFiles);
  const pageSizes = [Math.min(limit, 40), 15, 5];

  let lastError: unknown;
  for (const first of pageSizes) {
    try {
      const data = await ghGraphQl<SearchPage>(query, { q, first });
      return (data.search.nodes ?? [])
        .filter((n): n is RawPrNode => Boolean(n && n.number))
        .map((n) => normalizePrSummary(n, viewer));
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = /50[0234]|timeout|timed out|rate limit/i.test(message);
      if (!retryable) throw err;
      console.warn(`[list] search page of ${first} failed (${message.slice(0, 80)}), retrying smaller`);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  throw lastError;
}

export interface ListResult {
  prs: PrSummary[];
  errors: { filter: string; query: string; message: string }[];
  queriesRun: number;
}

export async function listPrs(
  config: AppConfig,
  opts: { filterIds?: string[]; limitPerQuery?: number } = {},
): Promise<ListResult> {
  const viewer = config.viewer || (await getViewer()).login;
  const limit = opts.limitPerQuery ?? 50;

  const active = config.filters.filter(
    (f) => f.enabled && (!opts.filterIds || opts.filterIds.includes(f.id)),
  );

  const planned = active.flatMap((f) => planQueries(f, config.org));
  const errors: ListResult["errors"] = [];

  // Dedupe identical query strings across filters, remembering every filter
  // that asked for them so `matchedFilters` stays accurate.
  const byQuery = new Map<string, { plan: PlannedQuery; owners: PlannedQuery[] }>();
  for (const plan of planned) {
    const key = `${plan.q}::${(plan.globs ?? []).join(",")}`;
    const existing = byQuery.get(key);
    if (existing) existing.owners.push(plan);
    else byQuery.set(key, { plan, owners: [plan] });
  }

  const results = await Promise.all(
    [...byQuery.values()].map(async ({ plan, owners }) => {
      try {
        const prs = await runSearch(plan.q, viewer, limit, Boolean(plan.globs));
        return { owners, plan, prs };
      } catch (err) {
        errors.push({
          filter: plan.filterName,
          query: plan.q,
          message: err instanceof Error ? err.message : String(err),
        });
        return { owners, plan, prs: [] as PrSummary[] };
      }
    }),
  );

  const merged = new Map<string, PrSummary>();
  for (const { owners, plan, prs } of results) {
    for (const pr of prs) {
      if (plan.globs && !pathMatches(pr.filePaths, plan.globs)) {
        // The search only returns the first 100 files; a wide PR could match on
        // a file we never saw, so keep it but mark it for the UI.
        if (!pr.filesTruncated) continue;
      }
      const existing = merged.get(pr.id) ?? pr;
      const names = new Set(existing.matchedFilters);
      for (const owner of owners) names.add(owner.filterName);
      existing.matchedFilters = [...names];
      merged.set(pr.id, existing);
    }
  }

  const prs = [...merged.values()];

  // Attach any cached Claude verdict so the list can show risk at a glance.
  const verdicts = getReviewVerdicts(prs.map((p) => p.id));
  for (const pr of prs) {
    const review = verdicts.get(pr.id);
    if (review?.headSha === pr.headSha && review.result) {
      pr.reviewVerdict = review.result.verdict;
      pr.reviewRiskScore = review.result.riskScore;
    } else {
      pr.reviewVerdict = null;
      pr.reviewRiskScore = null;
    }
  }

  // Snoozes that have lapsed come back before anything is ranked.
  expireSnoozes();
  const states = listPrStates();

  // Stack position feeds the score, so it has to be known first.
  buildStacks(prs);

  for (const pr of prs) {
    const state = states.get(pr.id) ?? null;
    pr.triage = state
      ? { status: state.status, until: state.until, note: state.note }
      : null;
    pr.attention = scoreAttention(pr, state);
    // A snooze that has lapsed — by time or by a new commit — must fall back to
    // its natural bucket rather than staying hidden.
    if (isHidden(pr, state)) pr.attention.bucket = "snoozed";
  }

  prs.sort((a, b) => (b.attention?.score ?? 0) - (a.attention?.score ?? 0));
  return { prs, errors, queriesRun: byQuery.size };
}

export function applyListPreferences(prs: PrSummary[], config: AppConfig): PrSummary[] {
  return prs.filter((pr) => {
    if (config.list.hideFailingCi && (pr.checkState === "FAILURE" || pr.checkState === "ERROR")) {
      return false;
    }
    if (config.list.hideDrafts && pr.isDraft) return false;
    if (config.list.hideApprovedByMe && pr.viewerHasApproved && !isApprovalStale(pr)) return false;
    return true;
  });
}
