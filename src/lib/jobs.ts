import type { FollowupResult, JobState, ReviewResult } from "./types";

/**
 * In-process job registry. Reviews and screenshot captures outlive a single
 * HTTP request, so the route starts a job and the client polls it.
 * Deliberately not persisted: a server restart should not resurrect a job
 * whose child process is gone (the DB row is reaped instead).
 */
const jobs = new Map<string, JobState>();
const MAX_JOBS = 200;

export function startJob(id: string, kind: string): JobState {
  const existing = jobs.get(id);
  if (existing && existing.status === "running") return existing;

  const job: JobState = {
    id,
    kind,
    status: "running",
    message: "Starting…",
    logs: [],
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    partial: null,
  };
  jobs.set(id, job);

  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.entries()]
      .filter(([, j]) => j.status !== "running")
      .sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest) jobs.delete(oldest[0]);
  }
  return job;
}

export function appendLog(id: string, line: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.message = line;
  job.logs.push(`${new Date().toISOString().slice(11, 19)}  ${line}`);
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
}

export function setPartial(id: string, partial: Partial<ReviewResult>): void {
  const job = jobs.get(id);
  if (!job) return;
  job.partial = partial;
}

export function setFollowupPartial(id: string, partial: Partial<FollowupResult>): void {
  const job = jobs.get(id);
  if (!job) return;
  job.followupPartial = partial;
}

export function finishJob(id: string, error?: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = error ? "error" : "done";
  job.error = error ?? null;
  job.endedAt = Date.now();
  if (error) job.message = error;
}

export function getJob(id: string): JobState | null {
  return jobs.get(id) ?? null;
}

export function isRunning(id: string): boolean {
  return jobs.get(id)?.status === "running";
}

/** Runs `work` under a job id, guaranteeing the job is closed out. */
export function runJob(
  id: string,
  kind: string,
  work: (log: (line: string) => void) => Promise<void>,
): JobState {
  const existing = jobs.get(id);
  if (existing?.status === "running") return existing;

  const job = startJob(id, kind);
  void work((line) => appendLog(id, line))
    .then(() => finishJob(id))
    .catch((err) => finishJob(id, err instanceof Error ? err.message : String(err)));

  return job;
}
