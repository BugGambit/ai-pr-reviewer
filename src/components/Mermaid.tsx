"use client";

import { useEffect, useId, useRef, useState } from "react";

let initialized = false;

async function getMermaid() {
  const mermaid = (await import("mermaid")).default;
  if (!initialized) {
    initialized = true;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "system-ui, -apple-system, sans-serif",
      themeVariables: {
        background: "transparent",
        primaryColor: "#222221",
        primaryTextColor: "#ffffff",
        primaryBorderColor: "#3987e5",
        secondaryColor: "#2c2c2a",
        tertiaryColor: "#1a1a19",
        lineColor: "#898781",
        textColor: "#c3c2b7",
        mainBkg: "#222221",
        nodeBorder: "#3987e5",
        clusterBkg: "#1a1a19",
        clusterBorder: "#383835",
        edgeLabelBackground: "#1a1a19",
      },
      flowchart: { curve: "basis", padding: 14, useMaxWidth: true },
      sequence: { useMaxWidth: true, actorMargin: 42 },
    });
  }
  return mermaid;
}

/**
 * Models routinely colour nodes with `style N fill:#cfe8ff`, which are pastels
 * chosen for a light canvas. On the dark theme the inherited light label text
 * then sits on a light fill and vanishes. Re-derive each label's colour from
 * the fill actually rendered.
 */
function fixLabelContrast(root: HTMLElement): void {
  const luminance = (color: string): number | null => {
    const match = /rgba?\(([^)]+)\)/.exec(color);
    if (!match) return null;
    const [r, g, b, a] = match[1].split(",").map((v) => Number.parseFloat(v));
    if (a !== undefined && a < 0.5) return null;
    const channel = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  for (const node of root.querySelectorAll<SVGGElement>("g.node, g.cluster")) {
    const shape = node.querySelector<SVGGraphicsElement>("rect, polygon, circle, ellipse, path");
    if (!shape) continue;

    const lum = luminance(getComputedStyle(shape).fill);
    if (lum === null) continue;

    const ink = lum > 0.45 ? "#0b0b0b" : "#ffffff";
    for (const label of node.querySelectorAll<HTMLElement>("text, tspan, .nodeLabel, .label, foreignObject div, foreignObject span, foreignObject p")) {
      label.style.setProperty("color", ink, "important");
      label.style.setProperty("fill", ink, "important");
    }
  }
}

/**
 * Renders model-authored Mermaid. The source is frequently almost-valid, so a
 * parse failure falls back to showing the source rather than an empty box.
 */
export function Mermaid({ chart, title }: { chart: string; title?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const rawId = useId();
  const id = `m${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const source = chart
        .replace(/^```(?:mermaid)?\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
      if (!source) {
        setError("Empty diagram");
        return;
      }

      try {
        const mermaid = await getMermaid();
        const { svg } = await mermaid.render(id, source);
        if (cancelled) return;
        if (hostRef.current) {
          hostRef.current.innerHTML = svg;
          fixLabelContrast(hostRef.current);
        }
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        // Mermaid leaves its failed render container behind on error.
        document.getElementById(`d${id}`)?.remove();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  return (
    <figure style={{ margin: 0 }}>
      {title ? (
        <figcaption style={{ fontSize: 13, fontWeight: 600, marginBottom: 9 }}>{title}</figcaption>
      ) : null}

      {error ? (
        <div
          style={{
            padding: "11px 14px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--surface-0)",
          }}
        >
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
            Diagram could not be rendered ({error.split("\n")[0].slice(0, 120)}). Showing source:
          </div>
          <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--ink-secondary)" }}>
            {chart}
          </pre>
        </div>
      ) : (
        <>
          <div
            ref={hostRef}
            className="mermaid-host"
            style={{
              padding: 14,
              background: "var(--surface-0)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              overflowX: "auto",
            }}
          />
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: 7, border: "none", background: "none", padding: 0 }}
            onClick={() => setShowSource((v) => !v)}
          >
            <span className="muted">{showSource ? "Hide" : "Show"} diagram source</span>
          </button>
          {showSource ? (
            <pre
              className="mono"
              style={{
                margin: "7px 0 0",
                padding: 11,
                background: "var(--surface-0)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                whiteSpace: "pre-wrap",
                color: "var(--ink-secondary)",
              }}
            >
              {chart}
            </pre>
          ) : null}
        </>
      )}
    </figure>
  );
}
