"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher, postJson } from "@/lib/client";
import { ErrorBox, Section, Spinner } from "@/components/ui";
import { useNotificationPermission } from "@/components/TopBar";
import type { AppConfig, PrFilter, ScreenshotRepoConfig } from "@/lib/types";

/** Comma/newline separated text <-> string[] for the list inputs. */
function TokenInput({
  label,
  hint,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(values.join(", "));

  useEffect(() => {
    setText(values.join(", "));
    // Only resync when the parent value genuinely differs from what we render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.join("\u0000")]);

  return (
    <label style={{ display: "block", marginBottom: 13 }}>
      <div style={{ fontSize: 12.5, fontWeight: 550, marginBottom: 4 }}>{label}</div>
      {hint ? (
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 5 }}>
          {hint}
        </div>
      ) : null}
      <input
        className="input"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() =>
          onChange(
            text
              .split(/[,\n]/)
              .map((v) => v.trim())
              .filter(Boolean),
          )
        }
      />
    </label>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 13 }}>
      <div style={{ fontSize: 12.5, fontWeight: 550, marginBottom: 4 }}>{label}</div>
      {hint ? (
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 5 }}>
          {hint}
        </div>
      ) : null}
      {children}
    </label>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label style={{ display: "flex", gap: 9, alignItems: "flex-start", marginBottom: 10, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span>
        <span style={{ fontSize: 12.5 }}>{label}</span>
        {hint ? (
          <span className="muted" style={{ fontSize: 11.5, display: "block" }}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/**
 * Browser notifications open the PR when clicked; the macOS fallback can't, so
 * this nudges towards granting permission and says plainly what happens if not.
 */
function BrowserNotificationSetup() {
  const [permission, request] = useNotificationPermission();

  const message =
    permission === "granted"
      ? "Delivered by this browser while a PR Reviewer tab is open. Clicking one opens the PR."
      : permission === "denied"
        ? "This browser blocks notifications for this site. Allow them in the site settings to get clickable notifications."
        : permission === "unsupported"
          ? "This browser can't show notifications."
          : "Allow this browser to notify you, so clicking a notification opens the PR.";

  return (
    <div
      style={{ display: "flex", gap: 10, alignItems: "center", margin: "-4px 0 12px 23px", fontSize: 11.5 }}
      className="muted"
    >
      <span>
        {message} With no tab open, the server falls back to macOS notifications, which can&rsquo;t open
        anything when clicked.
      </span>
      {permission === "default" ? (
        <button type="button" className="btn btn-sm" onClick={() => void request()}>
          Allow notifications
        </button>
      ) : null}
    </div>
  );
}

function FilterEditor({
  filter,
  org,
  onChange,
  onRemove,
}: {
  filter: PrFilter;
  org: string;
  onChange: (next: PrFilter) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof PrFilter>(key: K, value: PrFilter[K]) => onChange({ ...filter, [key]: value });

  return (
    <div
      style={{
        padding: 16,
        border: `1px solid ${filter.enabled ? "var(--border)" : "var(--border)"}`,
        borderRadius: 9,
        background: "var(--surface-2)",
        opacity: filter.enabled ? 1 : 0.6,
        marginBottom: 13,
      }}
    >
      <div style={{ display: "flex", gap: 11, alignItems: "center", marginBottom: 14 }}>
        <input
          className="input"
          style={{ fontWeight: 600, flex: 1 }}
          value={filter.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Filter name"
        />
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={filter.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Enabled
        </label>
        <button type="button" className="btn btn-sm btn-danger" onClick={onRemove}>
          Remove
        </button>
      </div>

      <TokenInput
        label="Repositories (scope)"
        hint={`Restricts this filter to these repos. Leave empty to search the whole ${org} org. Format: ${org}/repo-name`}
        values={filter.repos}
        onChange={(v) => set("repos", v)}
        placeholder={`${org || "acme"}/web-app, ${org || "acme"}/platform`}
      />

      <div
        style={{
          padding: "11px 13px",
          background: "var(--surface-0)",
          borderRadius: 8,
          border: "1px solid var(--border)",
          marginBottom: 13,
        }}
      >
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
          A PR matches this filter if it satisfies <strong>any</strong> of the criteria below, within the scope above.
        </div>

        <TokenInput
          label="Authors"
          hint="GitHub usernames. Any PR opened by one of these."
          values={filter.authors}
          onChange={(v) => set("authors", v)}
          placeholder="alice, bob"
        />

        <TokenInput
          label="Teams requested for review (code owners)"
          hint={`Team slugs. Accepts "my-team" or "${org}/my-team".`}
          values={filter.teams}
          onChange={(v) => set("teams", v)}
          placeholder="frontend-platform, data-eng"
        />

        <Field
          label="Paths"
          hint="One per line: owner/repo = glob1, glob2. A bare folder matches everything under it."
        >
          <textarea
            className="textarea"
            style={{ minHeight: 70, fontFamily: "var(--font-mono)", fontSize: 12 }}
            value={filter.paths.map((p) => `${p.repo} = ${p.globs.join(", ")}`).join("\n")}
            placeholder={`${org || "acme"}/platform = apps/web\n${org || "acme"}/web-app = packages/auth/**, src/billing/**`}
            onChange={(e) => {
              const paths = e.target.value
                .split("\n")
                .map((line) => {
                  const [repo, globs] = line.split("=");
                  if (!repo?.trim() || !globs?.trim()) return null;
                  return {
                    repo: repo.trim(),
                    globs: globs
                      .split(",")
                      .map((g) => g.trim())
                      .filter(Boolean),
                  };
                })
                .filter((p): p is { repo: string; globs: string[] } => p !== null);
              set("paths", paths);
            }}
          />
        </Field>
      </div>

      <TokenInput
        label="Required labels"
        hint="Optional. PR must carry all of these."
        values={filter.labels}
        onChange={(v) => set("labels", v)}
      />
      <TokenInput
        label="Excluded authors"
        hint="Bots and anyone you never want to see."
        values={filter.excludeAuthors}
        onChange={(v) => set("excludeAuthors", v)}
      />

      <Check checked={filter.includeDrafts} onChange={(v) => set("includeDrafts", v)} label="Include draft PRs" />
      <Check
        checked={filter.onlyReviewRequested}
        onChange={(v) => set("onlyReviewRequested", v)}
        label="Only PRs where my review is requested"
        hint="Adds review-requested:@me to every query in this filter."
      />
    </div>
  );
}

const EMPTY_REPO_CONFIG: ScreenshotRepoConfig = {
  enabled: true,
  setup: "pnpm install --frozen-lockfile",
  dev: "pnpm dev",
  cwd: "",
  port: 3000,
  readyPath: "/",
  readyTimeoutSeconds: 240,
  env: {},
  routes: [{ label: "Home", path: "/" }],
  captureBaseline: false,
  viewport: { width: 1440, height: 900 },
};

/**
 * GitHub expands a team review request to every member, so one broad team can
 * flood the bell with PRs you have no intention of reviewing. Muting is a
 * checklist of your actual teams rather than free text.
 */
function MutedTeams({ muted, onChange }: { muted: string[]; onChange: (next: string[]) => void }) {
  const { data } = useSWR<{ teams: string[] }>("/api/teams", fetcher, { revalidateOnFocus: false });
  const teams = data?.teams ?? [];

  if (teams.length === 0) return null;

  return (
    <div style={{ margin: "6px 0 14px" }}>
      <div style={{ fontSize: 12.5, fontWeight: 550, marginBottom: 4 }}>
        Review requests via team
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
        You are in {teams.length} teams in this org. Untick a team to stop its review requests from
        notifying you — they will still appear in the queue.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px" }}>
        {teams.map((team) => {
          const on = !muted.includes(team);
          return (
            <button
              type="button"
              key={team}
              className="chip"
              onClick={() => onChange(on ? [...muted, team] : muted.filter((t) => t !== team))}
              style={{
                cursor: "pointer",
                color: on ? "var(--series-1)" : "var(--ink-muted)",
                borderColor: on ? "var(--series-1)" : "var(--border)",
                textDecoration: on ? "none" : "line-through",
              }}
            >
              <span aria-hidden>{on ? "✓" : "✕"}</span>
              {team}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { data, error, isLoading, mutate } = useSWR<AppConfig>("/api/config", fetcher, {
    revalidateOnFocus: false,
  });
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  if (isLoading || !draft) {
    return (
      <div className="card" style={{ padding: 44, textAlign: "center" }}>
        <Spinner label="Loading settings…" />
      </div>
    );
  }
  if (error) return <ErrorBox>{String((error as Error).message)}</ErrorBox>;

  const update = (patch: Partial<AppConfig>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await postJson<AppConfig>("/api/config", draft, "PUT");
      setDraft(next);
      await mutate(next, false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const repoKeys = Object.keys(draft.screenshots.repos);

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 18,
          position: "sticky",
          top: 58,
          zIndex: 30,
          background: "var(--surface-0)",
          padding: "9px 0",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 650 }}>Settings</h1>
        <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
          {saved ? (
            <span style={{ color: "var(--status-good)", fontSize: 12.5 }}>
              <span aria-hidden>✓</span> Saved
            </span>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <Spinner /> : null}
            Save changes
          </button>
        </div>
      </div>

      {saveError ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorBox>{saveError}</ErrorBox>
        </div>
      ) : null}

      <Section title="Organisation">
        <Field
          label="GitHub organisation"
          hint="Used as the default scope, for team filters, and for short PR references like repo#123. Leave empty to rely on explicit repos and authors."
        >
          <input
            className="input"
            value={draft.org}
            placeholder="acme"
            onChange={(e) => update({ org: e.target.value })}
          />
        </Field>
      </Section>

      <Section
        title="Filters"
        subtitle="Which PRs show up in your review queue."
        action={
          <button
            type="button"
            className="btn"
            onClick={() =>
              update({
                filters: [
                  ...draft.filters,
                  {
                    id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
                    name: `Filter ${draft.filters.length + 1}`,
                    enabled: true,
                    repos: [],
                    authors: [],
                    teams: [],
                    paths: [],
                    labels: [],
                    excludeAuthors: ["dependabot[bot]", "renovate[bot]"],
                    includeDrafts: false,
                    onlyReviewRequested: false,
                  },
                ],
              })
            }
          >
            + Add filter
          </button>
        }
      >
        {draft.filters.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            No filters yet. Add one to start populating your queue.
          </p>
        ) : (
          draft.filters.map((filter, index) => (
            <FilterEditor
              key={filter.id}
              filter={filter}
              org={draft.org}
              onChange={(next) => {
                const filters = [...draft.filters];
                filters[index] = next;
                update({ filters });
              }}
              onRemove={() => update({ filters: draft.filters.filter((f) => f.id !== filter.id) })}
            />
          ))
        )}
      </Section>

      <Section
        title="Approval sequence"
        subtitle="What the Risk-approve button does. Steps run in this order; a failure in one doesn't stop the rest."
      >
        <Check
          checked={draft.approval.approve}
          onChange={(v) => update({ approval: { ...draft.approval, approve: v } })}
          label="Approve the PR on GitHub"
        />
        <Check
          checked={draft.approval.assignSelf}
          onChange={(v) => update({ approval: { ...draft.approval, assignSelf: v } })}
          label="Add myself as assignee"
        />
        <TokenInput
          label="Labels to add"
          values={draft.approval.labels}
          onChange={(v) => update({ approval: { ...draft.approval, labels: v } })}
        />
        <TokenInput
          label="Labels to remove (when present)"
          values={draft.approval.removeLabels}
          onChange={(v) => update({ approval: { ...draft.approval, removeLabels: v } })}
        />
        <Field label="Comment to post" hint="Leave empty to skip the comment step.">
          <input
            className="input"
            value={draft.approval.comment}
            onChange={(e) => update({ approval: { ...draft.approval, comment: e.target.value } })}
          />
        </Field>
        <Field
          label="Merge-gate check"
          hint="Substring of the CI check that re-evaluates after you approve. Watched so you can see it go green."
        >
          <input
            className="input"
            value={draft.approval.gateCheck}
            placeholder="policy-bot"
            onChange={(e) => update({ approval: { ...draft.approval, gateCheck: e.target.value } })}
          />
        </Field>
        <Field label="Approval review body" hint="Optional text attached to the GitHub approval itself.">
          <input
            className="input"
            value={draft.approval.approveBody}
            onChange={(e) => update({ approval: { ...draft.approval, approveBody: e.target.value } })}
          />
        </Field>
      </Section>

      <Section title="AI review" subtitle="Reviews are cached per commit, so each PR costs one review unless you re-run it.">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <Field label="CLI" hint="Auto uses claude when it is on PATH, otherwise Cursor's agent.">
            <select
              className="select"
              value={draft.review.provider}
              onChange={(e) =>
                update({ review: { ...draft.review, provider: e.target.value as AppConfig["review"]["provider"] } })
              }
            >
              <option value="auto">Auto</option>
              <option value="claude">Claude Code (claude)</option>
              <option value="cursor">Cursor CLI (agent)</option>
            </select>
          </Field>
          <Field label="Cursor model" hint="Run `agent models` for ids. Effort is part of the id; spend cap and effort below apply to Claude only.">
            <input
              className="input"
              value={draft.review.cursorModel}
              onChange={(e) => update({ review: { ...draft.review, cursorModel: e.target.value } })}
            />
          </Field>
          <Field label="Claude model" hint="An alias (opus, sonnet, haiku) or a full model id.">
            <input
              className="input"
              value={draft.review.model}
              onChange={(e) => update({ review: { ...draft.review, model: e.target.value } })}
            />
          </Field>
          <Field label="Effort" hint="Higher effort means more thorough reasoning and more tokens.">
            <select
              className="select"
              value={draft.review.effort}
              onChange={(e) =>
                update({ review: { ...draft.review, effort: e.target.value as AppConfig["review"]["effort"] } })
              }
            >
              {["low", "medium", "high", "xhigh", "max"].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Default mode" hint="Deep clones the repo so Claude can read surrounding code. Slower, better.">
            <select
              className="select"
              value={draft.review.mode}
              onChange={(e) =>
                update({ review: { ...draft.review, mode: e.target.value as "standard" | "deep" } })
              }
            >
              <option value="standard">Standard — diff only</option>
              <option value="deep">Deep — clone and explore the repo</option>
            </select>
          </Field>
          <Field label="Spend cap per review (USD)">
            <input
              className="input"
              type="number"
              step="0.5"
              min="0.5"
              value={draft.review.maxBudgetUsd}
              onChange={(e) => update({ review: { ...draft.review, maxBudgetUsd: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Max diff size (bytes)" hint="Larger diffs are truncated on a file boundary.">
            <input
              className="input"
              type="number"
              step="50000"
              value={draft.review.maxDiffBytes}
              onChange={(e) => update({ review: { ...draft.review, maxDiffBytes: Number(e.target.value) } })}
            />
          </Field>
        </div>
        <Check
          checked={draft.review.autoReviewOnOpen}
          onChange={(v) => update({ review: { ...draft.review, autoReviewOnOpen: v } })}
          label="Start the review automatically when I open a PR"
          hint="Skips the button press. Still cached per commit, so revisiting a PR costs nothing."
        />
      </Section>

      <Section
        id="prefetch"
        title="Review ahead of time"
        subtitle="Reviews the top of your queue in the background, so a PR is usually already reviewed when you open it."
      >
        <Check
          checked={draft.prefetch.enabled}
          onChange={(v) => update({ prefetch: { ...draft.prefetch, enabled: v } })}
          label="Prefetch reviews for my queue"
          hint="Runs about a minute after startup, then every ten minutes. Costs tokens even for PRs you never open."
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          <Field label="PRs per run" hint="Taken from the top of your queue.">
            <input
              className="input"
              type="number"
              min="1"
              max="25"
              value={draft.prefetch.maxPrs}
              onChange={(e) => update({ prefetch: { ...draft.prefetch, maxPrs: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Concurrency">
            <input
              className="input"
              type="number"
              min="1"
              max="4"
              value={draft.prefetch.concurrency}
              onChange={(e) => update({ prefetch: { ...draft.prefetch, concurrency: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Daily spend cap (USD)" hint="Hard stop across prefetch runs.">
            <input
              className="input"
              type="number"
              step="1"
              min="1"
              value={draft.prefetch.dailyBudgetUsd}
              onChange={(e) =>
                update({ prefetch: { ...draft.prefetch, dailyBudgetUsd: Number(e.target.value) } })
              }
            />
          </Field>
        </div>
      </Section>

      <Section title="Notifications">
        <Check
          checked={draft.notifications.enabled}
          onChange={(v) => update({ notifications: { ...draft.notifications, enabled: v } })}
          label="Poll GitHub in the background"
        />
        <Check
          checked={draft.notifications.desktop}
          onChange={(v) => update({ notifications: { ...draft.notifications, desktop: v } })}
          label="Show desktop notifications"
        />
        {draft.notifications.desktop ? <BrowserNotificationSetup /> : null}
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", margin: "11px 0" }}>
          <Check
            checked={draft.notifications.newPrs}
            onChange={(v) => update({ notifications: { ...draft.notifications, newPrs: v } })}
            label="New PRs matching my filters"
          />
          <Check
            checked={draft.notifications.mentions}
            onChange={(v) => update({ notifications: { ...draft.notifications, mentions: v } })}
            label="Mentions"
          />
          <Check
            checked={draft.notifications.replies}
            onChange={(v) => update({ notifications: { ...draft.notifications, replies: v } })}
            label="Replies to my comments"
          />
          <Check
            checked={draft.notifications.reviewRequests}
            onChange={(v) => update({ notifications: { ...draft.notifications, reviewRequests: v } })}
            label="Review requests"
          />
        </div>

        <div style={{ fontSize: 12.5, fontWeight: 550, margin: "4px 0 8px" }}>On my own pull requests</div>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          <Check
            checked={draft.notifications.myPrApproved}
            onChange={(v) => update({ notifications: { ...draft.notifications, myPrApproved: v } })}
            label="Someone approved my PR"
          />
          <Check
            checked={draft.notifications.myPrChangesRequested}
            onChange={(v) =>
              update({ notifications: { ...draft.notifications, myPrChangesRequested: v } })
            }
            label="Changes requested on my PR"
          />
          <Check
            checked={draft.notifications.myPrCiFailed}
            onChange={(v) => update({ notifications: { ...draft.notifications, myPrCiFailed: v } })}
            label="CI broke on my PR"
          />
        </div>
        <MutedTeams
          muted={draft.notifications.mutedTeams}
          onChange={(v) => update({ notifications: { ...draft.notifications, mutedTeams: v } })}
        />

        <Field label="Poll interval (seconds)" hint="Minimum 60.">
          <input
            className="input"
            type="number"
            min="60"
            step="30"
            value={draft.notifications.intervalSeconds}
            onChange={(e) =>
              update({ notifications: { ...draft.notifications, intervalSeconds: Number(e.target.value) } })
            }
          />
        </Field>
      </Section>

      <Section
        id="screenshots"
        title="Screenshots"
        subtitle="Per-repo recipes for booting the app on a PR branch and capturing pages."
        action={
          <button
            type="button"
            className="btn"
            onClick={() => {
              const key = prompt(`Repository (e.g. ${draft.org || "acme"}/platform)`);
              if (!key?.includes("/")) return;
              update({
                screenshots: {
                  ...draft.screenshots,
                  repos: { ...draft.screenshots.repos, [key.trim()]: { ...EMPTY_REPO_CONFIG } },
                },
              });
            }}
          >
            + Add repository
          </button>
        }
      >
        <Check
          checked={draft.screenshots.enabled}
          onChange={(v) => update({ screenshots: { ...draft.screenshots, enabled: v } })}
          label="Enable screenshot capture"
          hint="Requires Playwright's browser: run `pnpm setup:screenshots` once."
        />

        {repoKeys.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: "11px 0 0" }}>
            No repositories configured.
          </p>
        ) : (
          repoKeys.map((key) => {
            const repoConfig = draft.screenshots.repos[key];
            const setRepo = (next: ScreenshotRepoConfig) =>
              update({
                screenshots: { ...draft.screenshots, repos: { ...draft.screenshots.repos, [key]: next } },
              });

            return (
              <div
                key={key}
                style={{
                  padding: 16,
                  marginTop: 13,
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 13 }}>
                  <strong className="mono" style={{ fontSize: 13 }}>
                    {key}
                  </strong>
                  <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                      <input
                        type="checkbox"
                        checked={repoConfig.enabled}
                        onChange={(e) => setRepo({ ...repoConfig, enabled: e.target.checked })}
                      />
                      Enabled
                    </label>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        const repos = { ...draft.screenshots.repos };
                        delete repos[key];
                        update({ screenshots: { ...draft.screenshots, repos } });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <Field label="Working directory" hint="Relative to the repo root. Empty = root.">
                    <input
                      className="input"
                      value={repoConfig.cwd}
                      placeholder="apps/web"
                      onChange={(e) => setRepo({ ...repoConfig, cwd: e.target.value })}
                    />
                  </Field>
                  <Field label="Port" hint="Passed to the dev command as $PORT.">
                    <input
                      className="input"
                      type="number"
                      value={repoConfig.port}
                      onChange={(e) => setRepo({ ...repoConfig, port: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Setup command">
                    <input
                      className="input mono"
                      value={repoConfig.setup}
                      onChange={(e) => setRepo({ ...repoConfig, setup: e.target.value })}
                    />
                  </Field>
                  <Field label="Dev server command">
                    <input
                      className="input mono"
                      value={repoConfig.dev}
                      onChange={(e) => setRepo({ ...repoConfig, dev: e.target.value })}
                    />
                  </Field>
                  <Field label="Ready path" hint="Polled until the server answers.">
                    <input
                      className="input"
                      value={repoConfig.readyPath}
                      onChange={(e) => setRepo({ ...repoConfig, readyPath: e.target.value })}
                    />
                  </Field>
                  <Field label="Ready timeout (seconds)">
                    <input
                      className="input"
                      type="number"
                      value={repoConfig.readyTimeoutSeconds}
                      onChange={(e) => setRepo({ ...repoConfig, readyTimeoutSeconds: Number(e.target.value) })}
                    />
                  </Field>
                </div>

                <Field label="Routes" hint="One per line: Label = /path = optional-css-selector-to-wait-for">
                  <textarea
                    className="textarea mono"
                    style={{ fontSize: 12 }}
                    value={repoConfig.routes
                      .map((r) => [r.label, r.path, r.waitFor].filter(Boolean).join(" = "))
                      .join("\n")}
                    placeholder={"Dashboard = /dashboard = [data-testid=dashboard]\nSettings = /settings"}
                    onChange={(e) =>
                      setRepo({
                        ...repoConfig,
                        routes: e.target.value
                          .split("\n")
                          .map((line): ScreenshotRepoConfig["routes"][number] | null => {
                            const [label, path, waitFor] = line.split("=").map((p) => p.trim());
                            if (!label || !path) return null;
                            return waitFor ? { label, path, waitFor } : { label, path };
                          })
                          .filter((r) => r !== null),
                      })
                    }
                  />
                </Field>

                <Field label="Environment variables" hint="One per line: KEY=value">
                  <textarea
                    className="textarea mono"
                    style={{ minHeight: 60, fontSize: 12 }}
                    value={Object.entries(repoConfig.env)
                      .map(([k, v]) => `${k}=${v}`)
                      .join("\n")}
                    onChange={(e) =>
                      setRepo({
                        ...repoConfig,
                        env: Object.fromEntries(
                          e.target.value
                            .split("\n")
                            .map((line) => {
                              const index = line.indexOf("=");
                              if (index <= 0) return null;
                              return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
                            })
                            .filter((p): p is [string, string] => p !== null),
                        ),
                      })
                    }
                  />
                </Field>

                <Check
                  checked={repoConfig.captureBaseline}
                  onChange={(v) => setRepo({ ...repoConfig, captureBaseline: v })}
                  label="Also capture the base branch (before/after comparison)"
                  hint="Doubles the capture time — it installs and boots the app twice."
                />
              </div>
            );
          })
        )}
      </Section>
    </>
  );
}
