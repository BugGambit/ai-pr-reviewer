"use client";

import Link from "next/link";
import { useState } from "react";
import { Empty, ErrorBox, Spinner } from "@/components/ui";
import type { JobState, ReviewResult, ScreenshotRecord } from "@/lib/types";

export function Screenshots({
  shots,
  job,
  configured,
  suggestions,
  onCapture,
}: {
  shots: ScreenshotRecord[];
  job: JobState | null;
  configured: boolean;
  suggestions: ReviewResult["screenshotSuggestions"];
  onCapture: () => void;
}) {
  const [lightbox, setLightbox] = useState<ScreenshotRecord | null>(null);
  const running = job?.status === "running";

  const byLabel = new Map<string, { base?: ScreenshotRecord; head?: ScreenshotRecord }>();
  for (const shot of shots) {
    const entry = byLabel.get(shot.label) ?? {};
    entry[shot.variant] = shot;
    byLabel.set(shot.label, entry);
  }

  if (!configured) {
    return (
      <div>
        <p className="secondary" style={{ fontSize: 13, margin: "0 0 11px" }}>
          Screenshot capture isn&rsquo;t configured for this repository. Add a setup command, a dev-server command,
          a port and the routes to visit, and this tool will check out the PR branch, boot the app and capture
          those pages for you.
        </p>
        {suggestions.length > 0 ? (
          <div
            style={{
              padding: "11px 13px",
              background: "var(--surface-2)",
              borderRadius: 8,
              border: "1px solid var(--border)",
              marginBottom: 11,
            }}
          >
            <strong style={{ fontSize: 12.5 }}>Claude suggests looking at these routes:</strong>
            <ul className="secondary" style={{ margin: "7px 0 0", paddingLeft: 19, fontSize: 12.5 }}>
              {suggestions.map((s) => (
                <li key={s.route}>
                  <code>{s.route}</code> — {s.why}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Link href="/settings#screenshots" className="btn">
          Configure screenshots
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 14 }}>
        <button type="button" className="btn btn-primary" onClick={onCapture} disabled={running}>
          {running ? <Spinner /> : null}
          {running ? "Capturing…" : shots.length > 0 ? "Re-capture" : "Capture screenshots"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Checks out the branch, installs, boots the dev server and visits each route. Can take several minutes.
        </span>
      </div>

      {running && job?.logs?.length ? (
        <pre
          className="mono"
          style={{
            maxHeight: 200,
            overflowY: "auto",
            padding: 11,
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            color: "var(--ink-secondary)",
            whiteSpace: "pre-wrap",
            marginBottom: 14,
          }}
        >
          {job.logs.slice(-50).join("\n")}
        </pre>
      ) : null}

      {job?.status === "error" ? (
        <div style={{ marginBottom: 14 }}>
          <ErrorBox>{job.error}</ErrorBox>
        </div>
      ) : null}

      {byLabel.size === 0 && !running ? (
        <Empty>No screenshots captured for this commit yet.</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {[...byLabel.entries()].map(([label, pair]) => (
            <div key={label}>
              <div style={{ fontSize: 13, fontWeight: 550, marginBottom: 7 }}>
                {label}
                <span className="mono muted" style={{ marginLeft: 9 }}>
                  {pair.head?.route ?? pair.base?.route}
                </span>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: pair.base ? "1fr 1fr" : "1fr",
                  gap: 11,
                }}
              >
                {(["base", "head"] as const).map((variant) => {
                  const shot = pair[variant];
                  if (!shot) return null;
                  return (
                    <figure key={variant} style={{ margin: 0 }}>
                      <figcaption className="muted" style={{ fontSize: 11.5, marginBottom: 5 }}>
                        {variant === "base" ? "Before (base branch)" : "After (this PR)"}
                      </figcaption>
                      {shot.status === "ok" && shot.path ? (
                        <button
                          type="button"
                          onClick={() => setLightbox(shot)}
                          style={{ padding: 0, border: "none", background: "none", cursor: "zoom-in", width: "100%" }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={shot.path}
                            alt={`${label} — ${variant}`}
                            style={{
                              width: "100%",
                              borderRadius: 8,
                              border: "1px solid var(--border)",
                              display: "block",
                            }}
                          />
                        </button>
                      ) : (
                        <ErrorBox>{shot.error ?? "Capture failed"}</ErrorBox>
                      )}
                    </figure>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {lightbox?.path ? (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.88)",
            zIndex: 100,
            display: "grid",
            placeItems: "center",
            padding: 30,
            cursor: "zoom-out",
            overflow: "auto",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox.path} alt={lightbox.label} style={{ maxWidth: "100%", borderRadius: 8 }} />
        </div>
      ) : null}
    </div>
  );
}
