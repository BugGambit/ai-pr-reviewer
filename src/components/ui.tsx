"use client";

import type { CheckState, Severity, Verdict } from "@/lib/types";

// Markdown lives in its own module because it carries the sanitiser and the
// media renderers; re-exported here so existing imports keep working.
export { Markdown, type RepoContext } from "./Markdown";

/* --------------------------------------------------------------------------
   Status colours are fixed and always ship with an icon + label, so meaning
   never rests on hue alone.
-------------------------------------------------------------------------- */

export const SEVERITY_META: Record<Severity, { color: string; icon: string; label: string }> = {
  critical: { color: "var(--status-critical)", icon: "⛔", label: "Critical" },
  high: { color: "var(--status-serious)", icon: "▲", label: "High" },
  medium: { color: "var(--status-warning)", icon: "●", label: "Medium" },
  low: { color: "var(--series-1)", icon: "·", label: "Low" },
  info: { color: "var(--ink-muted)", icon: "ℹ", label: "Info" },
};

export const VERDICT_META: Record<Verdict, { color: string; icon: string; label: string; blurb: string }> = {
  approve: {
    color: "var(--status-good)",
    icon: "✓",
    label: "Good to go",
    blurb: "Safe to approve without reading every line.",
  },
  needs_attention: {
    color: "var(--status-warning)",
    icon: "!",
    label: "Needs attention",
    blurb: "Something here deserves a human look before approving.",
  },
  block: {
    color: "var(--status-critical)",
    icon: "⛔",
    label: "Do not approve",
    blurb: "A serious problem was found. Do not risk-approve this PR.",
  },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const meta = SEVERITY_META[severity];
  return (
    <span
      className="chip"
      style={{ color: meta.color, borderColor: meta.color, background: `color-mix(in srgb, ${meta.color} 12%, transparent)` }}
    >
      <span aria-hidden>{meta.icon}</span>
      {meta.label}
    </span>
  );
}

export function VerdictBadge({ verdict, size = "md" }: { verdict: Verdict; size?: "sm" | "md" }) {
  const meta = VERDICT_META[verdict];
  const pad = size === "sm" ? "2px 8px" : "5px 12px";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: pad,
        borderRadius: 999,
        background: `color-mix(in srgb, ${meta.color} 16%, transparent)`,
        border: `1px solid ${meta.color}`,
        color: meta.color,
        fontWeight: 600,
        fontSize: size === "sm" ? 11.5 : 13,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>{meta.icon}</span>
      {meta.label}
    </span>
  );
}

const CHECK_META: Record<CheckState, { color: string; icon: string; label: string }> = {
  SUCCESS: { color: "var(--status-good)", icon: "✓", label: "CI passing" },
  FAILURE: { color: "var(--status-critical)", icon: "✕", label: "CI failing" },
  ERROR: { color: "var(--status-critical)", icon: "✕", label: "CI error" },
  PENDING: { color: "var(--status-warning)", icon: "◷", label: "CI running" },
  EXPECTED: { color: "var(--ink-muted)", icon: "◌", label: "CI expected" },
  NONE: { color: "var(--ink-muted)", icon: "–", label: "No CI" },
};

export function CheckBadge({ state, detail }: { state: CheckState; detail?: string }) {
  const meta = CHECK_META[state] ?? CHECK_META.NONE;
  return (
    <span className="chip" style={{ color: meta.color, borderColor: `color-mix(in srgb, ${meta.color} 45%, transparent)` }}>
      <span aria-hidden>{meta.icon}</span>
      {detail ?? meta.label}
    </span>
  );
}

/** Risk is a single headline value, so it gets a hero number, not a chart. */
export function RiskHero({ score, verdict }: { score: number; verdict: Verdict }) {
  const band =
    score <= 20
      ? { color: "var(--status-good)", label: "Low risk" }
      : score <= 45
        ? { color: "var(--status-warning)", label: "Moderate risk" }
        : score <= 70
          ? { color: "var(--status-serious)", label: "Elevated risk" }
          : { color: "var(--status-critical)", label: "High risk" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 190 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
        <span style={{ fontSize: 46, fontWeight: 650, lineHeight: 1, color: band.color }}>{score}</span>
        <span className="muted" style={{ fontSize: 13 }}>/ 100</span>
      </div>
      <div style={{ fontSize: 12.5, color: band.color, fontWeight: 600 }}>{band.label}</div>

      {/* Thin ordinal track with a 2px surface gap around the marker. */}
      <div
        style={{ position: "relative", height: 8, background: "var(--surface-3)", borderRadius: 4 }}
        role="img"
        aria-label={`Risk score ${score} out of 100: ${band.label}`}
      >
        <div
          style={{
            width: `${Math.max(2, score)}%`,
            height: "100%",
            background: band.color,
            borderRadius: 4,
          }}
        />
      </div>
      <VerdictBadge verdict={verdict} size="sm" />
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  color?: string;
}) {
  return (
    <div
      style={{
        padding: "11px 14px",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 9,
        minWidth: 108,
      }}
    >
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 21, fontWeight: 600, color: color ?? "var(--ink-primary)", lineHeight: 1.35 }}>
        {value}
      </div>
      {hint ? (
        <div className="muted" style={{ fontSize: 11.5 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="spinner" />
      {label ? <span className="muted" style={{ fontSize: 12.5 }}>{label}</span> : null}
    </span>
  );
}

export function Section({
  title,
  subtitle,
  action,
  children,
  id,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="card" style={{ padding: 18, marginBottom: 16 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2>
          {subtitle ? (
            <p className="muted" style={{ margin: "3px 0 0", fontSize: 12.5 }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="muted" style={{ fontSize: 13, padding: "14px 0", textAlign: "center" }}>
      {children}
    </div>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "11px 14px",
        borderRadius: 8,
        border: "1px solid var(--status-critical)",
        background: "color-mix(in srgb, var(--status-critical) 10%, transparent)",
        color: "var(--status-critical)",
        fontSize: 13,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </div>
  );
}

/* --------------------------------------------------------------------------
   GitHub label colours are chosen for a light background, so a dark label is
   unreadable here. Lighten anything below the contrast floor instead of
   dropping the author's colour entirely.
-------------------------------------------------------------------------- */

function parseHex(hex: string): [number, number, number] | null {
  const clean = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

/** Relative luminance per WCAG. */
export function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function readableOnDark(hex: string, fallback = "var(--ink-secondary)"): string {
  const rgb = parseHex(hex);
  if (!rgb) return fallback;

  let [r, g, b] = rgb;
  // Lift toward white until the colour clears roughly 4:1 on the dark surface.
  for (let i = 0; i < 12 && luminance([r, g, b]) < 0.18; i++) {
    r = Math.round(r + (255 - r) * 0.22);
    g = Math.round(g + (255 - g) * 0.22);
    b = Math.round(b + (255 - b) * 0.22);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  const readable = readableOnDark(color);
  return (
    <span
      className="chip"
      style={{
        color: readable,
        borderColor: `color-mix(in srgb, ${readable} 50%, transparent)`,
        background: `color-mix(in srgb, ${readable} 10%, transparent)`,
      }}
    >
      {name}
    </span>
  );
}

/**
 * Secondary detail that shouldn't compete with the verdict for attention.
 * Collapsed by default; the summary line carries enough to decide whether to
 * open it.
 */
export function Collapsible({
  title,
  badge,
  tone,
  defaultOpen = false,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  tone?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="collapsible">
      <summary>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: tone }}>{title}</span>
        {badge !== undefined ? (
          <span className="muted" style={{ fontSize: 11.5 }}>
            {badge}
          </span>
        ) : null}
      </summary>
      <div style={{ paddingTop: 12 }}>{children}</div>
    </details>
  );
}
