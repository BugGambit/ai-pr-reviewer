"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeGitHubHtml } from "@/lib/githubHtml";
import { Markdown } from "./Markdown";

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.92)",
        zIndex: 200,
        display: "grid",
        placeItems: "center",
        padding: 30,
        cursor: "zoom-out",
        overflow: "auto",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }} />
    </div>
  );
}

/**
 * Renders a PR body, comment or review using GitHub's own HTML when we have it,
 * falling back to client-side markdown. The HTML is sanitised before it is
 * injected, and all media is proxied.
 */
export function GitHubBody({
  html,
  markdown,
  prId,
}: {
  html?: string;
  markdown: string;
  prId?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);

  const safe = useMemo(() => sanitizeGitHubHtml(html ?? "", prId), [html, prId]);

  // Click-to-zoom and broken-asset handling are attached by delegation, since
  // the markup is injected rather than composed from components.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !safe) return;

    const images = [...host.querySelectorAll("img")];
    const cleanups: (() => void)[] = [];

    for (const image of images) {
      const isBadge = image.width > 0 && image.width <= 160;
      if (!isBadge) image.style.cursor = "zoom-in";

      const onError = () => {
        const link = document.createElement("a");
        const original = new URL(image.src, window.location.origin).searchParams.get("url") ?? image.src;
        link.href = original;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        link.textContent = `${image.alt || "Image"} — could not load, open on GitHub ↗`;
        link.className = "gh-media-fallback";
        image.replaceWith(link);
      };
      image.addEventListener("error", onError);
      cleanups.push(() => image.removeEventListener("error", onError));
    }

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName !== "IMG") return;
      const image = target as HTMLImageElement;
      if (image.width > 0 && image.width <= 160) return;
      event.preventDefault();
      setZoomed(image.src);
    };
    host.addEventListener("click", onClick);
    cleanups.push(() => host.removeEventListener("click", onClick));

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [safe]);

  if (!safe) return <Markdown>{markdown}</Markdown>;

  return (
    <>
      <div ref={hostRef} className="md gh-body" dangerouslySetInnerHTML={{ __html: safe }} />
      {zoomed ? <Lightbox src={zoomed} onClose={() => setZoomed(null)} /> : null}
    </>
  );
}
