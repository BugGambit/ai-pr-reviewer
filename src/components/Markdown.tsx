"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { defaultSchema } from "hast-util-sanitize";

/* ---------------------------------------------------------------------------
   PR bodies and comments are attacker-controlled. Raw HTML is parsed so that
   GitHub's <img>/<video> markup renders, but everything passes through a
   sanitiser first: no scripts, no iframes, no event handlers, no inline
   styles (which would let an author hide text from a human reviewer while
   leaving it in the DOM).
--------------------------------------------------------------------------- */

const schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "video",
    "audio",
    "source",
    "picture",
    "details",
    "summary",
    "kbd",
    "mark",
    "ins",
    "figure",
    "figcaption",
  ],
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "loading"],
    video: ["src", "poster", "width", "height", "controls", "loop", "muted", "playsInline"],
    audio: ["src", "controls", "loop", "muted"],
    source: ["src", "type", "srcSet", "media"],
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
    details: ["open"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https"],
    href: ["http", "https", "mailto"],
  },
};

export interface RepoContext {
  owner: string;
  repo: string;
  sha: string;
}

/** Resolves repo-relative asset paths the way GitHub does. */
function absolutize(src: string, context?: RepoContext): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (!context || src.startsWith("data:") || src.startsWith("#")) return src;
  const clean = src.replace(/^\.?\//, "");
  return `https://github.com/${context.owner}/${context.repo}/raw/${context.sha}/${clean}`;
}

function proxied(src: string): string {
  if (!/^https?:\/\//i.test(src)) return src;
  return `/api/media?url=${encodeURIComponent(src)}`;
}

function MediaFallback({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 12px",
        border: "1px dashed var(--border-strong)",
        borderRadius: 8,
        fontSize: 12.5,
        color: "var(--ink-muted)",
        textDecoration: "none",
      }}
    >
      <span aria-hidden>🖼</span>
      {label} — open on GitHub ↗
    </a>
  );
}

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
        background: "rgba(0,0,0,0.9)",
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

function MarkdownImage({
  src,
  alt,
  width,
  height,
  context,
}: {
  src?: string;
  alt?: string;
  width?: string | number;
  height?: string | number;
  context?: RepoContext;
}) {
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  if (!src) return null;

  const absolute = absolutize(src, context);
  const url = proxied(absolute);

  if (failed) return <MediaFallback href={absolute} label={alt || "Image"} />;

  // Badges and other tiny inline images shouldn't become click-to-zoom blocks.
  const numericWidth = Number(width);
  const isInlineBadge = Number.isFinite(numericWidth) && numericWidth > 0 && numericWidth <= 160;

  if (isInlineBadge) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={url}
        alt={alt ?? ""}
        width={width}
        height={height}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ verticalAlign: "middle", maxWidth: "100%" }}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        style={{ display: "block", padding: 0, border: "none", background: "none", cursor: "zoom-in", maxWidth: "100%" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt ?? ""}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{
            maxWidth: "100%",
            height: "auto",
            borderRadius: 8,
            border: "1px solid var(--border)",
            display: "block",
          }}
        />
      </button>
      {zoom ? <Lightbox src={url} onClose={() => setZoom(false)} /> : null}
    </>
  );
}

function MarkdownVideo({
  src,
  poster,
  context,
}: {
  src?: string;
  poster?: string;
  context?: RepoContext;
}) {
  const [failed, setFailed] = useState(false);
  if (!src) return null;

  const absolute = absolutize(src, context);
  if (failed) return <MediaFallback href={absolute} label="Video" />;

  return (
    <video
      controls
      preload="metadata"
      poster={poster ? proxied(absolutize(poster, context)) : undefined}
      onError={() => setFailed(true)}
      style={{
        maxWidth: "100%",
        borderRadius: 8,
        border: "1px solid var(--border)",
        display: "block",
        background: "#000",
      }}
    >
      <source src={proxied(absolute)} />
    </video>
  );
}

/**
 * GitHub turns a bare attachment link into a player or a picture depending on
 * what was uploaded, and the URL carries no extension. Ask the server what the
 * asset actually is, then render accordingly.
 */
function AttachmentLink({ href }: { href: string }) {
  const [kind, setKind] = useState<"loading" | "image" | "video" | "audio" | "other">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/media/probe?url=${encodeURIComponent(href)}`)
      .then((r) => r.json())
      .then((d: { kind?: string }) => {
        if (!cancelled) setKind((d.kind as "image" | "video" | "audio" | "other") ?? "other");
      })
      .catch(() => {
        if (!cancelled) setKind("other");
      });
    return () => {
      cancelled = true;
    };
  }, [href]);

  if (kind === "loading") {
    return (
      <span className="muted" style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 7 }}>
        <span className="spinner" /> loading attachment…
      </span>
    );
  }
  if (kind === "video") return <MarkdownVideo src={href} />;
  if (kind === "image") return <MarkdownImage src={href} alt="attachment" />;
  if (kind === "audio") {
    return <audio controls src={proxied(href)} style={{ width: "100%" }} />;
  }

  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {href}
    </a>
  );
}

function nodeText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === "string") {
    return children[0];
  }
  return "";
}

export function Markdown({ children, context }: { children: string; context?: RepoContext }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
        components={{
          img: (props) => (
            <MarkdownImage
              src={props.src as string | undefined}
              alt={props.alt}
              width={props.width}
              height={props.height}
              context={context}
            />
          ),
          video: (props) => (
            <MarkdownVideo
              src={
                (props as { src?: string }).src ??
                // GitHub often nests the real URL in a <source> child.
                (Array.isArray(props.children)
                  ? (props.children.find(
                      (c): c is React.ReactElement<{ src?: string }> =>
                        Boolean(c) && typeof c === "object" && "props" in (c as object),
                    )?.props?.src ?? undefined)
                  : undefined)
              }
              poster={(props as { poster?: string }).poster}
              context={context}
            />
          ),
          a: ({ href, children: inner, ...rest }) => {
            const text = nodeText(inner);
            // An autolinked bare URL renders as media; a real link stays a link.
            if (href && text === href && /^https?:\/\//i.test(href)) {
              return <AttachmentLink href={href} />;
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
                {inner}
              </a>
            );
          },
          details: (props) => (
            <details
              {...props}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 12px",
                margin: "0 0 0.75em",
                background: "var(--surface-2)",
              }}
            />
          ),
          summary: (props) => <summary {...props} style={{ cursor: "pointer", fontWeight: 550 }} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
