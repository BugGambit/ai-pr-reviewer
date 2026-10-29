"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { apiPrPath, fetcher, postJson, prPath } from "@/lib/client";
import { Empty, ErrorBox, Spinner } from "@/components/ui";
import { PrRow, type TriageAction } from "@/components/PrRow";
import type { PrSummary } from "@/lib/types";

interface ListResponse {
  groups: Record<string, PrSummary[]>;
  counts: Record<string, number>;
  total: number;
  errors: { filter: string; query: string; message: string }[];
  queriesRun: number;
  filters: { id: string; name: string; enabled: boolean }[];
}

const SECTIONS: { key: string; title: string; hint: string; defaultOpen: boolean }[] = [
  { key: "ready", title: "Needs you", hint: "oldest and most blocked-on first", defaultOpen: true },
  { key: "blocked", title: "Blocked", hint: "failing checks or conflicts — the author's move", defaultOpen: false },
  { key: "done", title: "You approved", hint: "already signed off", defaultOpen: false },
  { key: "snoozed", title: "Snoozed & ignored", hint: "hidden until you bring them back", defaultOpen: false },
];

function Section({
  title,
  hint,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 18 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 9,
          width: "100%",
          padding: "6px 2px",
          border: "none",
          background: "none",
          color: "inherit",
          fontFamily: "inherit",
          cursor: "pointer",
          textAlign: "left",
          borderBottom: "1px solid var(--border)",
          marginBottom: 7,
        }}
      >
        <span className="muted" aria-hidden style={{ fontSize: 10 }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ fontSize: 13, fontWeight: 650 }}>{title}</span>
        <span className="tabular muted" style={{ fontSize: 12 }}>
          {count}
        </span>
        <span className="muted" style={{ fontSize: 11.5, marginLeft: "auto" }}>
          {hint}
        </span>
      </button>
      {open ? children : null}
    </section>
  );
}

export default function InboxPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SECTIONS.map((s) => [s.key, s.defaultOpen])),
  );
  const searchRef = useRef<HTMLInputElement>(null);

  const query = new URLSearchParams();
  for (const id of activeFilters) query.append("filter", id);

  const { data, error, isLoading, mutate, isValidating } = useSWR<ListResponse>(
    `/api/prs?${query.toString()}`,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 300_000 },
  );

  const matches = useCallback(
    (pr: PrSummary) => {
      const needle = search.trim().toLowerCase();
      if (!needle) return true;
      return (
        pr.title.toLowerCase().includes(needle) ||
        pr.author.login.toLowerCase().includes(needle) ||
        `${pr.owner}/${pr.repo}`.toLowerCase().includes(needle)
      );
    },
    [search],
  );

  const sections = useMemo(
    () =>
      SECTIONS.map((section) => ({
        ...section,
        prs: (data?.groups?.[section.key] ?? []).filter(matches),
      })),
    [data?.groups, matches],
  );

  /** Flat list of rows currently on screen, for keyboard navigation. */
  const visible = useMemo(
    () => sections.filter((s) => openSections[s.key]).flatMap((s) => s.prs),
    [sections, openSections],
  );

  useEffect(() => {
    if (cursor >= visible.length) setCursor(Math.max(0, visible.length - 1));
  }, [visible.length, cursor]);

  /**
   * Moves a PR between sections locally before the request goes out.
   * Revalidating means re-querying GitHub, which takes seconds — far too slow
   * to be the thing that makes a keypress feel like it registered.
   */
  const applyLocally = useCallback(
    (prId: string, to: "snoozed" | null, current?: ListResponse) => {
      if (!current) return current;
      const groups: Record<string, PrSummary[]> = {};
      let moved: PrSummary | undefined;

      for (const [key, list] of Object.entries(current.groups)) {
        groups[key] = list.filter((p) => {
          if (p.id !== prId) return true;
          moved = p;
          return false;
        });
      }
      if (!moved) return current;

      const destination = to ?? (moved.attention?.bucket === "snoozed" ? "ready" : moved.attention?.bucket) ?? "ready";
      groups[destination] = [...(groups[destination] ?? []), moved];

      return {
        ...current,
        groups,
        counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
      };
    },
    [],
  );

  const triage = useCallback(
    async (pr: PrSummary, action: TriageAction) => {
      const verb =
        action.kind === "snooze" ? "snoozed" : action.kind === "ignore" ? "ignored" : "muted";

      const body =
        action.kind === "activate"
          ? { status: "active" }
          : action.kind === "snooze"
            ? {
                status: "snoozed",
                durationMs: action.durationMs,
                headSha: action.untilNewCommits ? pr.headSha : undefined,
              }
            : { status: action.kind === "ignore" ? "ignored" : "muted" };

      // Mute keeps the PR in place; the others take it out of the way.
      const hides = action.kind === "snooze" || action.kind === "ignore";

      if (action.kind !== "activate") {
        setToast({
          text: `${pr.repo}#${pr.number} ${verb}`,
          undo: () => void triageRef.current?.(pr, { kind: "activate" }),
        });
      }
      if (hides) {
        void mutate((current) => applyLocally(pr.id, "snoozed", current), { revalidate: false });
      } else if (action.kind === "activate") {
        void mutate((current) => applyLocally(pr.id, null, current), { revalidate: false });
        setToast(null);
      }

      setBusyId(pr.id);
      try {
        await postJson(`${apiPrPath(pr.owner, pr.repo, pr.number)}/state`, body);
        // Reconcile with the server, but without blocking the interaction.
        void mutate();
      } catch (err) {
        setToast({ text: err instanceof Error ? err.message : String(err) });
        void mutate();
      } finally {
        setBusyId(null);
      }
    },
    [mutate, applyLocally],
  );

  // Lets the toast's undo call back into triage without a circular dependency.
  const triageRef = useRef<typeof triage | null>(null);
  triageRef.current = triage;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Keyboard triage: the whole point is clearing a queue without reaching for
  // the mouse. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        if (event.key === "Escape") target.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const current = visible[cursor];

      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          setCursor((c) => Math.min(c + 1, visible.length - 1));
          break;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case "Enter":
        case "o":
          if (current) {
            event.preventDefault();
            router.push(prPath(current.owner, current.repo, current.number));
          }
          break;
        case "s":
          if (current) {
            event.preventDefault();
            void triage(current, { kind: "snooze", durationMs: 86_400_000 });
          }
          break;
        case "e":
          if (current) {
            event.preventDefault();
            void triage(current, { kind: "ignore" });
          }
          break;
        case "u":
          if (toast?.undo) {
            event.preventDefault();
            void toast.undo();
          }
          break;
        case "r":
          event.preventDefault();
          void mutate();
          break;
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          break;
        default:
          break;
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, cursor, router, triage, mutate, toast]);

  const readyCount = data?.counts?.ready ?? 0;
  const noFilters = (data?.filters.length ?? 0) === 0;

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 18,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650 }}>Review queue</h1>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 12.5 }}>
            {isLoading
              ? "Loading…"
              : readyCount > 0
                ? `${readyCount} waiting on you · ${data?.total ?? 0} total`
                : `Nothing waiting on you · ${data?.total ?? 0} total`}
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            ref={searchRef}
            className="input"
            style={{ width: 200 }}
            placeholder="Filter…  (/)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="button" className="btn" onClick={() => void mutate()} disabled={isValidating}>
            {isValidating ? <Spinner /> : "↻"}
          </button>
        </div>
      </div>

      {(data?.filters.length ?? 0) > 1 ? (
        <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
          {data?.filters.map((filter) => {
            const on = activeFilters.length === 0 || activeFilters.includes(filter.id);
            return (
              <button
                type="button"
                key={filter.id}
                className="chip"
                onClick={() =>
                  setActiveFilters((current) =>
                    current.includes(filter.id)
                      ? current.filter((id) => id !== filter.id)
                      : [...current, filter.id],
                  )
                }
                style={{
                  cursor: "pointer",
                  color: on ? "var(--series-1)" : "var(--ink-muted)",
                  borderColor: on ? "var(--series-1)" : "var(--border)",
                }}
              >
                {filter.name}
              </button>
            );
          })}
          {activeFilters.length > 0 ? (
            <button type="button" className="btn btn-sm" onClick={() => setActiveFilters([])}>
              All
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <ErrorBox>{String((error as Error).message ?? error)}</ErrorBox> : null}
      {data?.errors.map((err) => (
        <div key={err.query} style={{ marginBottom: 11 }}>
          <ErrorBox>
            Filter “{err.filter}” failed: {err.message}
          </ErrorBox>
        </div>
      ))}

      {noFilters && !isLoading ? (
        <div className="card" style={{ padding: 36, textAlign: "center" }}>
          <h2 style={{ margin: "0 0 7px", fontSize: 16 }}>No filters configured yet</h2>
          <p className="muted" style={{ margin: "0 0 16px", fontSize: 13.5 }}>
            Define which PRs you care about — by author, by code-owning team, or by the folders they touch.
          </p>
          <Link href="/settings" className="btn btn-primary">
            Set up filters
          </Link>
        </div>
      ) : isLoading ? (
        <div className="card" style={{ padding: 36, textAlign: "center" }}>
          <Spinner label="Querying GitHub…" />
        </div>
      ) : (
        sections.map((section) =>
          section.prs.length === 0 && !openSections[section.key] ? null : (
            <Section
              key={section.key}
              title={section.title}
              hint={section.hint}
              count={section.prs.length}
              open={openSections[section.key]}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, [section.key]: !current[section.key] }))
              }
            >
              {section.prs.length === 0 ? (
                <Empty>Nothing here.</Empty>
              ) : (
                section.prs.map((pr, i) => {
                  const group = pr.stack?.groupId;
                  const members = group ? section.prs.filter((p) => p.stack?.groupId === group).length : 0;
                  const startsGroup = members > 1 && section.prs[i - 1]?.stack?.groupId !== group;
                  return (
                    <Fragment key={pr.id}>
                      {startsGroup && pr.stack ? (
                        <div className="muted" style={{ fontSize: 11.5, padding: "6px 2px 3px" }}>
                          ⛓ Stack · {members} of {pr.stack.groupSize} here, bottom first
                        </div>
                      ) : null}
                      <div style={members > 1 ? { borderLeft: "2px solid var(--border)", paddingLeft: 8 } : undefined}>
                        <PrRow
                          pr={pr}
                          selected={visible[cursor]?.id === pr.id}
                          onSelect={() => setCursor(visible.findIndex((p) => p.id === pr.id))}
                          onTriage={triage}
                          busy={busyId === pr.id}
                        />
                      </div>
                    </Fragment>
                  );
                })
              )}
            </Section>
          ),
        )
      )}

      <p className="muted" style={{ fontSize: 11.5, marginTop: 24, textAlign: "center" }}>
        <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>enter</kbd> open · <kbd>s</kbd> snooze a day ·{" "}
        <kbd>e</kbd> ignore · <kbd>u</kbd> undo · <kbd>r</kbd> refresh · <kbd>/</kbd> filter
      </p>

      {toast ? (
        <div
          className="card"
          style={{
            position: "fixed",
            bottom: 22,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            zIndex: 60,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
          }}
        >
          <span style={{ fontSize: 12.5 }}>{toast.text}</span>
          {toast.undo ? (
            <button type="button" className="btn btn-sm" onClick={() => void toast.undo?.()}>
              Undo (u)
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
