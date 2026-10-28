import fs from "node:fs";
import { CONFIG_PATH, DEFAULT_CHECKOUT_ROOT, ensureDirs } from "./paths";
import type { AppConfig, PrFilter } from "./types";

export const DEFAULT_CONFIG: AppConfig = {
  org: "",
  viewer: "",
  filters: [],
  approval: {
    approve: true,
    approveBody: "",
    assignSelf: false,
    labels: [],
    removeLabels: [],
    comment: "",
    gateCheck: "",
  },
  review: {
    // Benchmarked on a real PR: sonnet/high reproduced every finding opus/high
    // found in roughly a quarter of the time. Dropping effort below "high" is
    // what actually costs quality — medium missed a description/code mismatch
    // and stopped producing diagrams — so the effort stays up.
    model: "sonnet",
    mode: "standard",
    maxDiffBytes: 600_000,
    maxBudgetUsd: 3,
    effort: "high",
    autoReviewOnOpen: true,
  },
  prefetch: {
    enabled: false,
    maxPrs: 5,
    concurrency: 2,
    dailyBudgetUsd: 5,
  },
  notifications: {
    enabled: true,
    intervalSeconds: 180,
    desktop: true,
    newPrs: true,
    mentions: true,
    replies: true,
    reviewRequests: true,
    myPrApproved: true,
    myPrChangesRequested: true,
    myPrCiFailed: true,
    mutedTeams: [],
  },
  list: {
    hideFailingCi: false,
    hideDrafts: true,
    hideApprovedByMe: true,
  },
  screenshots: {
    enabled: false,
    checkoutRoot: DEFAULT_CHECKOUT_ROOT,
    repos: {},
  },
};

/** Deep-merges persisted config over the defaults so new keys appear on upgrade. */
function merge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base)) return (Array.isArray(override) ? override : base) as T;
  if (typeof base !== "object") return (typeof override === typeof base ? override : base) as T;
  if (typeof override !== "object") return base;

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    out[key] = key in out ? merge((base as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

let cache: { config: AppConfig; mtimeMs: number } | null = null;

export function loadConfig(): AppConfig {
  ensureDirs();
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.config;
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const config = merge(DEFAULT_CONFIG, raw);
    cache = { config, mtimeMs: stat.mtimeMs };
    return config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      saveConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    console.error("[config] failed to read config, using defaults:", err);
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: AppConfig): AppConfig {
  ensureDirs();
  const merged = merge(DEFAULT_CONFIG, config);
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  cache = null;
  return merged;
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  return saveConfig(merge(loadConfig(), patch));
}

export function emptyFilter(name = "New filter"): PrFilter {
  return {
    id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    enabled: true,
    repos: [],
    authors: [],
    teams: [],
    paths: [],
    labels: [],
    excludeAuthors: ["dependabot", "dependabot[bot]", "renovate", "renovate[bot]"],
    includeDrafts: false,
    onlyReviewRequested: false,
  };
}
