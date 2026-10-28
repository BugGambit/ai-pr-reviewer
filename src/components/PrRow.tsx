"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { prPath, relativeTime } from "@/lib/client";
import { DiffStat } from "@/components/charts";
import { LabelChip, VERDICT_META } from "@/components/ui";
import type { PrSummary } from "@/lib/types";

export type TriageAction =
  | { kind: "snooze"; durationMs?: number; untilNewCommits?: boolean }
  | { kind: "ignore" }
  | { kind: "mute" }
  | { kind: "activate" };

const SNOOZE_OPTIONS: { label: string; action: TriageAction }[] = [
  { label: "1 day", action: { kind: "snooze", durationMs: 86_400_000 } },
  { label: "3 days", action: { kind: "snooze", durationMs: 3 * 86_400_000 } },
  { label: "1 week", action: { kind: "snooze", durationMs: 7 * 86_400_000 } },
  { label: "Until new commits", action: { kind: "snooze", untilNewCommits: true } },
];

function CiDot({ pr }: { pr: PrSummary }) {
  const failing = pr.checkState === "FAILURE" || pr.checkState === "ERROR";
  const pending = pr.checkState === "PENDING" || pr.checkState === "EXPECTED";
  const color = failing ? "var(--status-critical)" : pending ? "var(--status-warning)" : "var(--status-good)";
  const label = failing
    ? `${pr.failingChecks.length || 1} check${pr.failingChecks.length === 1 ? "" : "s"} failing`
    : pending
      ? "CI running"
      : pr.checkState === "NONE"
        ? "No CI"
        : "CI passing";

  return (
    <span
      className="chip"
      title={label}
      style={{ color, borderColor: `color-mix(in srgb, ${color} 42%, transparent)`, gap: 5 }}
    >
      <span aria-hidden>{failing ? "✕" : pending ? "◷" : pr.checkState === "NONE" ? "–" : "✓"}</span>
      {failing ? String(pr.failingChecks.length || 1) : pending ? "CI" : ""}
    </span>
  );
}

export function PrRow({
  pr,
  selected,
  onSelect,
  onTriage,
  busy,
}: {
  pr: PrSummary;
  selected: boolean;
  onSelect: () => void;
  onTriage: (pr: PrSummary, action: TriageAction) => void;
  busy: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const verdict = pr.reviewVerdict ? VERDICT_META[pr.reviewVerdict] : null;
  const isTriaged = Boolean(pr.triage);

  return (
    <div
      ref={rowRef}
      onMouseEnter={onSelect}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "9px 12px",
        borderRadius: 8,
        border: `1px solid ${selected ? "var(--border-strong)" : "transparent"}`,
        background: selected ? "var(--surface-2)" : "transparent",
        opacity: busy ? 0.5 : isTriaged ? 0.72 : 1,
        transition: "background 100ms ease, border-color 100ms ease",
      }}
    >
      {/* Rank marker: colour carries the verdict, the chip on the right carries the word. */}
      <span
        aria-hidden
        style={{
          width: 3,
          alignSelf: "stretch",
          borderRadius: 2,
          background: verdict ? verdict.color : "var(--surface-3)",
          flex: "none",
        }}
      />

      <Link href={prPath(pr.owner, pr.repo, pr.number)} style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 540,
            lineHeight: 1.4,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {pr.isDraft ? <span className="muted">[draft] </span> : null}
          {pr.title}
        </div>
        <div
          className="muted"
          style={{
            fontSize: 11.5,
            display: "flex",
            gap: 9,
            alignItems: "center",
            flexWrap: "nowrap",
            overflow: "hidden",
          }}
        >
          <span className="mono" style={{ flex: "none" }}>
            {pr.repo}#{pr.number}
          </span>
          <span style={{ flex: "none" }}>@{pr.author.login}</span>
          <span style={{ flex: "none" }}>{relativeTime(pr.createdAt)}</span>
          <DiffStat additions={pr.additions} deletions={pr.deletions} />
          {pr.attention?.reasons.length ? (
            <span style={{ color: "var(--ink-muted)", whiteSpace: "nowrap", overflow: "hidden" }}>
              · {pr.attention.reasons.join(" · ")}
            </span>
          ) : null}
        </div>
      </Link>

      <div style={{ display: "flex", alignItems: "center", gap: 7, flex: "none" }}>
        {pr.labels.slice(0, 1).map((l) => (
          <LabelChip key={l.name} name={l.name} color={l.color} />
        ))}
        {pr.triage ? (
          <span className="chip" style={{ color: "var(--series-7)", borderColor: "var(--series-7)" }}>
            {pr.triage.status}
          </span>
        ) : null}
        {verdict ? (
          <span
            className="chip"
            title={verdict.blurb}
            style={{ color: verdict.color, borderColor: verdict.color }}
          >
            <span aria-hidden>{verdict.icon}</span>
            {pr.reviewRiskScore ?? ""}
          </span>
        ) : (
          <span className="chip muted" title="No review yet">
            –
          </span>
        )}
        <CiDot pr={pr} />

        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Triage actions"
            onClick={() => setMenuOpen((v) => !v)}
            style={{ padding: "3px 7px" }}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div
              className="card"
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 5px)",
                width: 210,
                zIndex: 30,
                padding: 5,
                boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
              }}
            >
              {isTriaged ? (
                <MenuItem
                  label="Bring back to queue"
                  onClick={() => {
                    setMenuOpen(false);
                    onTriage(pr, { kind: "activate" });
                  }}
                />
              ) : (
                <>
                  <div className="muted" style={{ fontSize: 10.5, padding: "5px 9px", letterSpacing: 0.4 }}>
                    SNOOZE
                  </div>
                  {SNOOZE_OPTIONS.map((option) => (
                    <MenuItem
                      key={option.label}
                      label={option.label}
                      onClick={() => {
                        setMenuOpen(false);
                        onTriage(pr, option.action);
                      }}
                    />
                  ))}
                  <div style={{ height: 1, background: "var(--border)", margin: "5px 0" }} />
                  <MenuItem
                    label="Ignore"
                    hint="Hide until I bring it back"
                    onClick={() => {
                      setMenuOpen(false);
                      onTriage(pr, { kind: "ignore" });
                    }}
                  />
                  <MenuItem
                    label="Mute notifications"
                    hint="Stays listed, stops alerting"
                    onClick={() => {
                      setMenuOpen(false);
                      onTriage(pr, { kind: "mute" });
                    }}
                  />
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MenuItem({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 9px",
        borderRadius: 6,
        border: "none",
        background: "none",
        color: "inherit",
        fontFamily: "inherit",
        fontSize: 12.5,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-3)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
    >
      {label}
      {hint ? (
        <span className="muted" style={{ display: "block", fontSize: 11 }}>
          {hint}
        </span>
      ) : null}
    </button>
  );
}
