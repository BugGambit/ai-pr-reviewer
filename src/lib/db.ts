import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths";
import type {
  AppNotification,
  FollowupResult,
  HeuristicReport,
  ReviewResult,
  ScreenshotRecord,
  StoredFollowup,
  StoredReview,
} from "./types";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureDirs();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS pr_cache (
      pr_id      TEXT PRIMARY KEY,
      head_sha   TEXT,
      payload    TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id       TEXT NOT NULL,
      head_sha    TEXT NOT NULL,
      mode        TEXT NOT NULL,
      status      TEXT NOT NULL,
      result      TEXT,
      heuristics  TEXT,
      error       TEXT,
      model       TEXT,
      cost_usd    REAL,
      duration_ms INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews (pr_id, head_sha, id DESC);

    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      pr_id      TEXT,
      owner      TEXT,
      repo       TEXT,
      number     INTEGER,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      url        TEXT NOT NULL,
      actor      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_at    INTEGER,
      via        TEXT,
      resolved   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC);

    CREATE TABLE IF NOT EXISTS seen_prs (
      pr_id         TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id      TEXT NOT NULL,
      head_sha   TEXT NOT NULL,
      label      TEXT NOT NULL,
      route      TEXT NOT NULL,
      variant    TEXT NOT NULL,
      path       TEXT,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_screenshots_pr ON screenshots (pr_id, head_sha);

    CREATE TABLE IF NOT EXISTS action_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id      TEXT NOT NULL,
      action     TEXT NOT NULL,
      detail     TEXT,
      ok         INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    -- Per-PR triage state: snoozed until a time or a new commit, ignored
    -- outright, or muted for notifications only.
    CREATE TABLE IF NOT EXISTS pr_state (
      pr_id       TEXT PRIMARY KEY,
      status      TEXT NOT NULL,
      until       INTEGER,
      pinned_sha  TEXT,
      note        TEXT,
      created_at  INTEGER NOT NULL
    );

    -- The PR's net diff (base...head) as seen at each head SHA. Comparing these
    -- instead of commit history keeps "what changed since I looked" working
    -- across rebases, squashes and force-pushes.
    CREATE TABLE IF NOT EXISTS diff_snapshots (
      pr_id      TEXT NOT NULL,
      head_sha   TEXT NOT NULL,
      diff       BLOB NOT NULL,
      truncated  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (pr_id, head_sha)
    );

    CREATE TABLE IF NOT EXISTS followups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id       TEXT NOT NULL,
      from_sha    TEXT NOT NULL,
      to_sha      TEXT NOT NULL,
      status      TEXT NOT NULL,
      result      TEXT,
      error       TEXT,
      model       TEXT,
      cost_usd    REAL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_followups_pr ON followups (pr_id, from_sha, to_sha, id DESC);
  `);

  addColumnIfMissing(d, "notifications", "via", "via TEXT");
  addColumnIfMissing(d, "notifications", "resolved", "resolved INTEGER NOT NULL DEFAULT 0");
}

/** Adds columns to tables created by an older version of this app. */
function addColumnIfMissing(d: Database.Database, table: string, column: string, ddl: string): void {
  const columns = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// ------------------------------- key/value ---------------------------------

export function kvGet(key: string): string | null {
  const row = getDb().prepare("SELECT v FROM kv WHERE k = ?").get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function kvSet(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(key, value);
}

// ------------------------------- PR cache ----------------------------------

export function cachePr(prIdValue: string, headSha: string, payload: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO pr_cache (pr_id, head_sha, payload, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(pr_id) DO UPDATE SET head_sha = excluded.head_sha,
         payload = excluded.payload, fetched_at = excluded.fetched_at`,
    )
    .run(prIdValue, headSha, JSON.stringify(payload), Date.now());
}

export function readCachedPr<T>(prIdValue: string, maxAgeMs: number): T | null {
  const row = getDb()
    .prepare("SELECT payload, fetched_at FROM pr_cache WHERE pr_id = ?")
    .get(prIdValue) as { payload: string; fetched_at: number } | undefined;
  if (!row) return null;
  if (Date.now() - row.fetched_at > maxAgeMs) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

// -------------------------------- reviews ----------------------------------

interface ReviewRow {
  id: number;
  pr_id: string;
  head_sha: string;
  mode: string;
  status: string;
  result: string | null;
  heuristics: string | null;
  error: string | null;
  model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toStoredReview(row: ReviewRow): StoredReview {
  return {
    id: row.id,
    prId: row.pr_id,
    headSha: row.head_sha,
    mode: row.mode as StoredReview["mode"],
    status: row.status as StoredReview["status"],
    result: parseJson<ReviewResult>(row.result),
    heuristics: parseJson<HeuristicReport>(row.heuristics),
    error: row.error,
    model: row.model,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Latest review for this PR at this exact head SHA (the cache key). */
export function getLatestReview(prIdValue: string, headSha?: string): StoredReview | null {
  const sql = headSha
    ? "SELECT * FROM reviews WHERE pr_id = ? AND head_sha = ? ORDER BY id DESC LIMIT 1"
    : "SELECT * FROM reviews WHERE pr_id = ? ORDER BY id DESC LIMIT 1";
  const args = headSha ? [prIdValue, headSha] : [prIdValue];
  const row = getDb().prepare(sql).get(...args) as ReviewRow | undefined;
  return row ? toStoredReview(row) : null;
}

export function getReviewHistory(prIdValue: string): StoredReview[] {
  const rows = getDb()
    .prepare("SELECT * FROM reviews WHERE pr_id = ? ORDER BY id DESC LIMIT 20")
    .all(prIdValue) as ReviewRow[];
  return rows.map(toStoredReview);
}

export function getReviewVerdicts(prIds: string[]): Map<string, StoredReview> {
  if (prIds.length === 0) return new Map();
  const placeholders = prIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT * FROM reviews WHERE id IN (
         SELECT MAX(id) FROM reviews WHERE pr_id IN (${placeholders}) AND status = 'done' GROUP BY pr_id
       )`,
    )
    .all(...prIds) as ReviewRow[];
  return new Map(rows.map((r) => [r.pr_id, toStoredReview(r)]));
}

export function createReview(prIdValue: string, headSha: string, mode: string, model: string): number {
  const now = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO reviews (pr_id, head_sha, mode, status, model, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    )
    .run(prIdValue, headSha, mode, model, now, now);
  return Number(info.lastInsertRowid);
}

export function finishReview(
  id: number,
  patch: {
    status: "done" | "error";
    result?: ReviewResult | null;
    heuristics?: HeuristicReport | null;
    error?: string | null;
    costUsd?: number | null;
    durationMs?: number | null;
  },
): void {
  getDb()
    .prepare(
      `UPDATE reviews SET status = ?, result = ?, heuristics = ?, error = ?,
         cost_usd = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      patch.status,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.heuristics ? JSON.stringify(patch.heuristics) : null,
      patch.error ?? null,
      patch.costUsd ?? null,
      patch.durationMs ?? null,
      Date.now(),
      id,
    );
}

/** Marks reviews left "running" by a crashed/restarted server as errored. */
export function reapStaleReviews(maxAgeMs = 30 * 60_000): void {
  getDb()
    .prepare(
      `UPDATE reviews SET status = 'error', error = 'Review did not finish (server restarted or timed out)',
       updated_at = ? WHERE status = 'running' AND created_at < ?`,
    )
    .run(Date.now(), Date.now() - maxAgeMs);
  getDb()
    .prepare(
      `UPDATE followups SET status = 'error', error = 'Follow-up did not finish (server restarted or timed out)',
       updated_at = ? WHERE status = 'running' AND created_at < ?`,
    )
    .run(Date.now(), Date.now() - maxAgeMs);
}

// ----------------------------- notifications -------------------------------

interface NotificationRow {
  id: string;
  kind: string;
  pr_id: string | null;
  owner: string | null;
  repo: string | null;
  number: number | null;
  title: string;
  body: string;
  url: string;
  actor: string;
  created_at: number;
  read_at: number | null;
  via: string | null;
  resolved: number | null;
}

function toNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    kind: row.kind as AppNotification["kind"],
    prId: row.pr_id,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    title: row.title,
    body: row.body,
    url: row.url,
    actor: row.actor,
    createdAt: row.created_at,
    readAt: row.read_at,
    via: row.via,
    resolved: row.resolved === 1,
  };
}

/** Returns true when the row was newly inserted (used to drive desktop alerts). */
export function addNotification(n: Omit<AppNotification, "readAt">): boolean {
  const info = getDb()
    .prepare(
      `INSERT INTO notifications (id, kind, pr_id, owner, repo, number, title, body, url, actor, created_at, via, resolved)
       VALUES (@id, @kind, @prId, @owner, @repo, @number, @title, @body, @url, @actor, @createdAt, @via, @resolved)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run({ ...n, via: n.via ?? null, resolved: n.resolved ? 1 : 0 });
  return info.changes > 0;
}

/** Back-fills the explanation and resolution of an existing notification. */
export function updateNotificationContext(
  id: string,
  patch: { via?: string | null; resolved?: boolean; body?: string },
): void {
  getDb()
    .prepare(
      `UPDATE notifications
         SET via = COALESCE(@via, via),
             body = COALESCE(@body, body),
             resolved = COALESCE(@resolved, resolved)
       WHERE id = @id`,
    )
    .run({
      id,
      via: patch.via ?? null,
      body: patch.body ?? null,
      resolved: patch.resolved === undefined ? null : patch.resolved ? 1 : 0,
    });
}

/** Review requests we haven't yet confirmed as handled, newest first. */
export function pendingNotifications(
  kind: string,
  limit = 40,
): { id: string; prId: string | null; body: string; via: string | null }[] {
  return getDb()
    .prepare(
      `SELECT id, pr_id AS prId, body, via FROM notifications
       WHERE kind = ? AND pr_id IS NOT NULL AND (resolved = 0 OR via IS NULL)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(kind, limit) as { id: string; prId: string | null; body: string; via: string | null }[];
}

export function listNotifications(limit = 100): AppNotification[] {
  const rows = getDb()
    .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
    .all(limit) as NotificationRow[];
  return rows.map(toNotification);
}

export function unreadNotificationCount(): number {
  // A request that has since been handled shouldn't keep demanding attention.
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL AND resolved = 0")
    .get() as { c: number };
  return row.c;
}

export function markNotificationsRead(ids?: string[]): void {
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    getDb()
      .prepare(`UPDATE notifications SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`)
      .run(Date.now(), ...ids);
    return;
  }
  getDb().prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(Date.now());
}

/**
 * Collapses review-request rows left over from when they were keyed per thread
 * update: one standing ask should be one row, not one per PR event.
 */
export function dedupeReviewRequests(): number {
  const rows = getDb()
    .prepare("SELECT id, created_at FROM notifications WHERE kind = 'review_request' ORDER BY created_at DESC")
    .all() as { id: string; created_at: number }[];

  const newestPerThread = new Set<string>();
  const stale: string[] = [];

  for (const row of rows) {
    const thread = row.id.split(":")[1];
    if (!thread) continue;
    if (newestPerThread.has(thread)) stale.push(row.id);
    else newestPerThread.add(thread);
  }

  if (stale.length === 0) return 0;
  const placeholders = stale.map(() => "?").join(",");
  return getDb()
    .prepare(`DELETE FROM notifications WHERE id IN (${placeholders})`)
    .run(...stale).changes;
}

export function pruneNotifications(keep = 500): void {
  getDb()
    .prepare(
      `DELETE FROM notifications WHERE id NOT IN (
         SELECT id FROM notifications ORDER BY created_at DESC LIMIT ?
       )`,
    )
    .run(keep);
}

// ------------------------------- seen PRs ----------------------------------

/** Records PR ids, returning the subset that had never been seen before. */
export function markPrsSeen(prIds: string[]): string[] {
  if (prIds.length === 0) return [];
  const d = getDb();
  const insert = d.prepare(
    "INSERT INTO seen_prs (pr_id, first_seen_at) VALUES (?, ?) ON CONFLICT(pr_id) DO NOTHING",
  );
  const fresh: string[] = [];
  d.transaction(() => {
    for (const id of prIds) {
      if (insert.run(id, Date.now()).changes > 0) fresh.push(id);
    }
  })();
  return fresh;
}

export function hasSeenAnyPrs(): boolean {
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM seen_prs").get() as { c: number };
  return row.c > 0;
}

// ------------------------------ screenshots --------------------------------

interface ScreenshotRow {
  id: number;
  pr_id: string;
  head_sha: string;
  label: string;
  route: string;
  variant: string;
  path: string | null;
  status: string;
  error: string | null;
  created_at: number;
}

export function addScreenshot(s: Omit<ScreenshotRecord, "id" | "createdAt">): void {
  getDb()
    .prepare(
      `INSERT INTO screenshots (pr_id, head_sha, label, route, variant, path, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(s.prId, s.headSha, s.label, s.route, s.variant, s.path, s.status, s.error, Date.now());
}

export function listScreenshots(prIdValue: string, headSha?: string): ScreenshotRecord[] {
  const sql = headSha
    ? "SELECT * FROM screenshots WHERE pr_id = ? AND head_sha = ? ORDER BY id ASC"
    : "SELECT * FROM screenshots WHERE pr_id = ? ORDER BY id ASC";
  const rows = getDb()
    .prepare(sql)
    .all(...(headSha ? [prIdValue, headSha] : [prIdValue])) as ScreenshotRow[];
  return rows.map((r) => ({
    id: r.id,
    prId: r.pr_id,
    headSha: r.head_sha,
    label: r.label,
    route: r.route,
    variant: r.variant as ScreenshotRecord["variant"],
    path: r.path,
    status: r.status as ScreenshotRecord["status"],
    error: r.error,
    createdAt: r.created_at,
  }));
}

export function clearScreenshots(prIdValue: string, headSha: string): void {
  getDb().prepare("DELETE FROM screenshots WHERE pr_id = ? AND head_sha = ?").run(prIdValue, headSha);
}

// ------------------------------- PR state ----------------------------------

export type PrStatus = "snoozed" | "ignored" | "muted";

export interface PrState {
  prId: string;
  status: PrStatus;
  /** Snooze expiry. Null means "until something else changes". */
  until: number | null;
  /** Head SHA when the state was set; a new commit revives a snooze. */
  pinnedSha: string | null;
  note: string | null;
  createdAt: number;
}

interface PrStateRow {
  pr_id: string;
  status: string;
  until: number | null;
  pinned_sha: string | null;
  note: string | null;
  created_at: number;
}

const toPrState = (r: PrStateRow): PrState => ({
  prId: r.pr_id,
  status: r.status as PrStatus,
  until: r.until,
  pinnedSha: r.pinned_sha,
  note: r.note,
  createdAt: r.created_at,
});

export function setPrState(state: Omit<PrState, "createdAt">): void {
  getDb()
    .prepare(
      `INSERT INTO pr_state (pr_id, status, until, pinned_sha, note, created_at)
       VALUES (@prId, @status, @until, @pinnedSha, @note, @createdAt)
       ON CONFLICT(pr_id) DO UPDATE SET status = excluded.status, until = excluded.until,
         pinned_sha = excluded.pinned_sha, note = excluded.note, created_at = excluded.created_at`,
    )
    .run({ ...state, createdAt: Date.now() });
}

export function clearPrState(prIdValue: string): void {
  getDb().prepare("DELETE FROM pr_state WHERE pr_id = ?").run(prIdValue);
}

export function getPrState(prIdValue: string): PrState | null {
  const row = getDb().prepare("SELECT * FROM pr_state WHERE pr_id = ?").get(prIdValue) as
    | PrStateRow
    | undefined;
  return row ? toPrState(row) : null;
}

export function listPrStates(): Map<string, PrState> {
  const rows = getDb().prepare("SELECT * FROM pr_state").all() as PrStateRow[];
  return new Map(rows.map((r) => [r.pr_id, toPrState(r)]));
}

/** Drops snoozes whose deadline has passed, so they return to the queue. */
export function expireSnoozes(): number {
  const info = getDb()
    .prepare("DELETE FROM pr_state WHERE status = 'snoozed' AND until IS NOT NULL AND until < ?")
    .run(Date.now());
  return info.changes;
}

// ----------------------------- diff snapshots ------------------------------

const SNAPSHOTS_PER_PR = 10;

export function saveDiffSnapshot(prIdValue: string, headSha: string, diff: string, truncated: boolean): void {
  if (!headSha || !diff) return;
  const d = getDb();
  d.prepare(
    `INSERT INTO diff_snapshots (pr_id, head_sha, diff, truncated, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pr_id, head_sha) DO NOTHING`,
  ).run(prIdValue, headSha, gzipSync(diff), truncated ? 1 : 0, Date.now());
  d.prepare(
    `DELETE FROM diff_snapshots WHERE pr_id = ? AND head_sha NOT IN (
       SELECT head_sha FROM diff_snapshots WHERE pr_id = ? ORDER BY created_at DESC LIMIT ?
     )`,
  ).run(prIdValue, prIdValue, SNAPSHOTS_PER_PR);
}

export function getDiffSnapshot(
  prIdValue: string,
  headSha: string,
): { diff: string; truncated: boolean; createdAt: number } | null {
  const row = getDb()
    .prepare("SELECT diff, truncated, created_at FROM diff_snapshots WHERE pr_id = ? AND head_sha = ?")
    .get(prIdValue, headSha) as { diff: Buffer; truncated: number; created_at: number } | undefined;
  if (!row) return null;
  return { diff: gunzipSync(row.diff).toString("utf8"), truncated: row.truncated === 1, createdAt: row.created_at };
}

/** Most recent finished review at a head SHA other than the current one. */
export function getPreviousReview(prIdValue: string, currentHeadSha: string): StoredReview | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM reviews WHERE pr_id = ? AND head_sha != ? AND status = 'done' ORDER BY id DESC LIMIT 1",
    )
    .get(prIdValue, currentHeadSha) as ReviewRow | undefined;
  return row ? toStoredReview(row) : null;
}
// ------------------------------- follow-ups --------------------------------

interface FollowupRow {
  id: number;
  pr_id: string;
  from_sha: string;
  to_sha: string;
  status: string;
  result: string | null;
  error: string | null;
  model: string | null;
  cost_usd: number | null;
  created_at: number;
  updated_at: number;
}

function toFollowup(row: FollowupRow): StoredFollowup {
  return {
    id: row.id,
    prId: row.pr_id,
    fromSha: row.from_sha,
    toSha: row.to_sha,
    status: row.status as StoredFollowup["status"],
    result: parseJson<FollowupResult>(row.result),
    error: row.error,
    model: row.model,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getFollowup(prIdValue: string, fromSha: string, toSha: string): StoredFollowup | null {
  const row = getDb()
    .prepare("SELECT * FROM followups WHERE pr_id = ? AND from_sha = ? AND to_sha = ? ORDER BY id DESC LIMIT 1")
    .get(prIdValue, fromSha, toSha) as FollowupRow | undefined;
  return row ? toFollowup(row) : null;
}

export function createFollowup(prIdValue: string, fromSha: string, toSha: string, model: string): number {
  const now = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO followups (pr_id, from_sha, to_sha, status, model, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    )
    .run(prIdValue, fromSha, toSha, model, now, now);
  return Number(info.lastInsertRowid);
}

export function finishFollowup(
  id: number,
  patch: { status: "done" | "error"; result?: FollowupResult | null; error?: string | null; costUsd?: number | null },
): void {
  getDb()
    .prepare("UPDATE followups SET status = ?, result = ?, error = ?, cost_usd = ?, updated_at = ? WHERE id = ?")
    .run(
      patch.status,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.error ?? null,
      patch.costUsd ?? null,
      Date.now(),
      id,
    );
}

// ------------------------------- action log --------------------------------

export function logAction(prIdValue: string, action: string, detail: string, ok: boolean): void {
  getDb()
    .prepare("INSERT INTO action_log (pr_id, action, detail, ok, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(prIdValue, action, detail, ok ? 1 : 0, Date.now());
}

export function listActions(prIdValue: string): {
  action: string;
  detail: string | null;
  ok: boolean;
  createdAt: number;
}[] {
  const rows = getDb()
    .prepare("SELECT action, detail, ok, created_at FROM action_log WHERE pr_id = ? ORDER BY id DESC LIMIT 50")
    .all(prIdValue) as { action: string; detail: string | null; ok: number; created_at: number }[];
  return rows.map((r) => ({ action: r.action, detail: r.detail, ok: r.ok === 1, createdAt: r.created_at }));
}
