import { loadConfig } from "./config";
import { getLatestReview, kvGet, kvSet } from "./db";
import { fetchPrDetail } from "./github/detail";
import { applyListPreferences, listPrs } from "./github/list";
import { getJob, runJob, setPartial } from "./jobs";
import { runReview } from "./claude/run";
import { parsePrId } from "./gh";

const jobKey = (id: string) => `review:${id}`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function spentToday(): number {
  const raw = kvGet("prefetch:spend");
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { date: string; usd: number };
    return parsed.date === today() ? parsed.usd : 0;
  } catch {
    return 0;
  }
}

function recordSpend(usd: number): void {
  kvSet("prefetch:spend", JSON.stringify({ date: today(), usd: spentToday() + usd }));
}

export function prefetchStatus(): { spentToday: number; date: string } {
  return { spentToday: spentToday(), date: today() };
}

let running = false;

/**
 * Reviews the next few PRs in the queue before they are opened, so the common
 * case is "open the PR, the review is already there". Reviews are cached per
 * commit, so this never duplicates work the user triggers by hand.
 */
export async function runPrefetch(log: (line: string) => void = () => {}): Promise<{
  started: string[];
  skipped: string;
}> {
  const config = loadConfig();
  if (!config.prefetch.enabled) return { started: [], skipped: "prefetch disabled" };
  if (running) return { started: [], skipped: "already running" };

  const spent = spentToday();
  if (spent >= config.prefetch.dailyBudgetUsd) {
    return { started: [], skipped: `daily budget reached ($${spent.toFixed(2)})` };
  }

  running = true;
  const started: string[] = [];

  try {
    const { prs } = await listPrs(config, { limitPerQuery: 30 });
    const visible = applyListPreferences(prs, config);

    // Only PRs with no review for their current head commit are worth doing.
    const candidates = visible
      .filter((pr) => {
        if (!pr.headSha) return false;
        if (getJob(jobKey(pr.id))?.status === "running") return false;
        const existing = getLatestReview(pr.id, pr.headSha);
        return !existing || existing.status === "error";
      })
      .slice(0, config.prefetch.maxPrs);

    if (candidates.length === 0) {
      log("Prefetch: nothing new to review");
      return { started: [], skipped: "queue already reviewed" };
    }

    log(`Prefetch: reviewing ${candidates.length} PR(s) ahead of time`);

    const queue = [...candidates];
    const workers = Array.from({ length: Math.max(1, config.prefetch.concurrency) }, async () => {
      for (;;) {
        if (spentToday() >= config.prefetch.dailyBudgetUsd) {
          log("Prefetch: daily budget reached, stopping");
          return;
        }
        const next = queue.shift();
        if (!next) return;

        const target = parsePrId(next.id);
        if (!target) continue;

        started.push(next.id);
        try {
          const pr = await fetchPrDetail(target.owner, target.repo, target.number, config, {
            maxAgeMs: 120_000,
          });

          // Go through the same job the UI watches, so opening the PR mid-flight
          // shows the stream rather than starting a second review.
          await new Promise<void>((resolve) => {
            runJob(jobKey(next.id), "review", async (jobLog) => {
              const stored = await runReview(pr, config, {
                onLog: jobLog,
                onPartial: (partial) => setPartial(jobKey(next.id), partial),
              });
              if (stored.costUsd) recordSpend(stored.costUsd);
            });
            // runJob is fire-and-forget; poll briefly so concurrency is real.
            const wait = setInterval(() => {
              if (getJob(jobKey(next.id))?.status !== "running") {
                clearInterval(wait);
                resolve();
              }
            }, 1000);
          });
          log(`Prefetch: finished ${next.id}`);
        } catch (err) {
          log(`Prefetch: ${next.id} failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    await Promise.all(workers);
    return { started, skipped: "" };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Starts the prefetch loop. Safe to call repeatedly. */
export function startPrefetchLoop(): void {
  if (timer) return;
  const schedule = (delayMs: number) => {
    timer = setTimeout(async () => {
      try {
        if (loadConfig().prefetch.enabled) await runPrefetch((line) => console.log(`[prefetch] ${line}`));
      } catch (err) {
        console.warn("[prefetch] error:", err instanceof Error ? err.message : err);
      }
      timer = null;
      schedule(10 * 60_000);
    }, delayMs);
    timer.unref?.();
  };
  // First pass shortly after boot, then every ten minutes.
  schedule(45_000);
}
