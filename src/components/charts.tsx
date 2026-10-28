"use client";

import { useState } from "react";
import type { PrFile } from "@/lib/types";
import { classifyFile, type FileKind } from "@/lib/analysis/diff";

/* Categorical slots in fixed order — a kind keeps its colour regardless of
   which other kinds are present, so filtering never repaints the survivors. */
const KIND_ORDER: FileKind[] = [
  "source",
  "test",
  "config",
  "dependency",
  "ci",
  "infra",
  "migration",
  "docs",
];
const KIND_SLOT: Record<FileKind, string> = {
  source: "var(--series-1)",
  test: "var(--series-3)",
  config: "var(--series-4)",
  dependency: "var(--series-2)",
  ci: "var(--series-5)",
  infra: "var(--series-7)",
  migration: "var(--series-8)",
  docs: "var(--series-6)",
  lockfile: "var(--ink-muted)",
  generated: "var(--ink-muted)",
  asset: "var(--ink-muted)",
};
const KIND_LABEL: Record<string, string> = {
  source: "Source",
  test: "Tests",
  config: "Config",
  dependency: "Dependencies",
  ci: "CI",
  infra: "Infra",
  migration: "Migrations",
  docs: "Docs",
  other: "Other",
};

interface Segment {
  key: string;
  label: string;
  color: string;
  count: number;
  files: string[];
}

function buildSegments(files: PrFile[]): Segment[] {
  const byKind = new Map<string, string[]>();
  for (const file of files) {
    const kind = classifyFile(file.path);
    // Lockfiles, generated output and assets are noise in this breakdown;
    // they fold into one "Other" slot rather than taking a categorical hue.
    const key = KIND_ORDER.includes(kind) ? kind : "other";
    const list = byKind.get(key) ?? [];
    list.push(file.path);
    byKind.set(key, list);
  }

  const ordered = [...KIND_ORDER, "other"].filter((k) => byKind.has(k));
  return ordered.map((key) => ({
    key,
    label: KIND_LABEL[key] ?? key,
    color: key === "other" ? "var(--ink-muted)" : KIND_SLOT[key as FileKind],
    count: byKind.get(key)!.length,
    files: byKind.get(key)!,
  }));
}

/** Composition of the change by file kind: a single stacked bar + legend. */
export function FileKindBar({ files }: { files: PrFile[] }) {
  const [hover, setHover] = useState<Segment | null>(null);
  const segments = buildSegments(files);
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return null;

  return (
    <div>
      <div
        style={{ display: "flex", gap: 2, height: 22, marginBottom: 11 }}
        role="img"
        aria-label={`File composition: ${segments.map((s) => `${s.count} ${s.label}`).join(", ")}`}
      >
        {segments.map((segment, index) => (
          <div
            key={segment.key}
            onMouseEnter={() => setHover(segment)}
            onMouseLeave={() => setHover(null)}
            title={`${segment.label}: ${segment.count} file${segment.count === 1 ? "" : "s"}`}
            style={{
              flex: segment.count,
              background: segment.color,
              borderRadius:
                segments.length === 1
                  ? 4
                  : index === 0
                    ? "4px 0 0 4px"
                    : index === segments.length - 1
                      ? "0 4px 4px 0"
                      : 0,
              cursor: "default",
              outline: hover?.key === segment.key ? "2px solid var(--ink-primary)" : "none",
              outlineOffset: 1,
              transition: "outline-color 100ms ease",
            }}
          />
        ))}
      </div>

      {/* Legend doubles as the direct-label relief for low-contrast slots. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "7px 16px" }}>
        {segments.map((segment) => (
          <span
            key={segment.key}
            onMouseEnter={() => setHover(segment)}
            onMouseLeave={() => setHover(null)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}
          >
            <span
              style={{ width: 9, height: 9, borderRadius: 2, background: segment.color, flex: "none" }}
              aria-hidden
            />
            <span className="secondary">{segment.label}</span>
            <span className="tabular muted">{segment.count}</span>
          </span>
        ))}
      </div>

      {hover ? (
        <div
          className="mono"
          style={{
            marginTop: 10,
            padding: "8px 11px",
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            maxHeight: 130,
            overflowY: "auto",
            color: "var(--ink-secondary)",
          }}
        >
          {hover.files.slice(0, 40).map((path) => (
            <div key={path}>{path}</div>
          ))}
          {hover.files.length > 40 ? <div className="muted">…and {hover.files.length - 40} more</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Top files by churn — magnitude, so a plain bar chart on one sequential hue. */
export function ChurnBars({ files, limit = 10 }: { files: PrFile[]; limit?: number }) {
  const [hover, setHover] = useState<string | null>(null);

  const ranked = [...files]
    .map((f) => ({ ...f, churn: f.additions + f.deletions }))
    .filter((f) => f.churn > 0)
    .sort((a, b) => b.churn - a.churn)
    .slice(0, limit);

  if (ranked.length === 0) return null;
  const max = ranked[0].churn;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {ranked.map((file) => {
        const name = file.path.split("/").pop() ?? file.path;
        const dir = file.path.slice(0, file.path.length - name.length);
        const isHover = hover === file.path;
        return (
          <div
            key={file.path}
            onMouseEnter={() => setHover(file.path)}
            onMouseLeave={() => setHover(null)}
            style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 92px", gap: 12, alignItems: "center" }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                className="mono"
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  direction: "rtl",
                  textAlign: "left",
                  color: isHover ? "var(--ink-primary)" : "var(--ink-secondary)",
                }}
                title={file.path}
              >
                {dir}
                <span style={{ color: "var(--ink-primary)" }}>{name}</span>
              </div>
              <div
                style={{
                  marginTop: 3,
                  height: 6,
                  background: "var(--surface-3)",
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${(file.churn / max) * 100}%`,
                    height: "100%",
                    background: isHover ? "var(--seq-250)" : "var(--seq-400)",
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>
            <div className="tabular" style={{ fontSize: 12, textAlign: "right", whiteSpace: "nowrap" }}>
              <span style={{ color: "var(--status-good)" }}>+{file.additions}</span>{" "}
              <span style={{ color: "var(--status-critical)" }}>−{file.deletions}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Compact +/− summary used in list rows and headers. */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tabular" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
      <span style={{ color: "var(--status-good)" }}>+{additions.toLocaleString()}</span>{" "}
      <span style={{ color: "var(--status-critical)" }}>−{deletions.toLocaleString()}</span>
    </span>
  );
}
