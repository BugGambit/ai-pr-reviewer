import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import rehypeSanitize from "rehype-sanitize";
import { defaultSchema } from "hast-util-sanitize";
import { visit } from "unist-util-visit";
import type { Root, Element } from "hast";

/**
 * GitHub's own `bodyHTML` is the most faithful rendering of a PR body: it
 * already resolves attachments to signed URLs that work without a browser
 * session, turns bare video links into players, and camo-proxies third-party
 * images. We re-sanitise it anyway — it reaches us as author-controlled
 * markup, and defence in depth is cheap.
 */
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
    "svg",
    "path",
  ],
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "loading", "dataCanonicalSrc"],
    video: ["src", "poster", "width", "height", "controls", "loop", "muted", "playsInline", "dataCanonicalSrc"],
    audio: ["src", "controls", "loop", "muted"],
    source: ["src", "type", "srcSet", "media"],
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
    details: ["open"],
    // GitHub inlines small icons; keep them geometric only.
    svg: ["viewBox", "width", "height", "ariaHidden", "className"],
    path: ["d", "fillRule", "clipRule"],
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https"],
    href: ["http", "https", "mailto"],
  },
};

const MEDIA_TAGS = new Set(["img", "video", "audio", "source"]);

/**
 * Routes every asset through our own proxy. Signed GitHub URLs expire in about
 * five minutes, so the proxy is also given the PR id and can mint a fresh one
 * rather than leaving a broken image behind.
 */
function rewriteMedia(prId?: string) {
  return () => (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (!MEDIA_TAGS.has(node.tagName)) return;

      for (const attribute of ["src", "poster"]) {
        const value = node.properties?.[attribute];
        if (typeof value !== "string" || !/^https?:\/\//i.test(value)) continue;

        const params = new URLSearchParams({ url: value });
        if (prId) params.set("pr", prId);
        node.properties![attribute] = `/api/media?${params.toString()}`;
      }

      // srcSet would bypass the proxy; GitHub doesn't rely on it here.
      if (node.properties?.srcSet) delete node.properties.srcSet;

      if (node.tagName === "img") {
        node.properties!.loading = "lazy";

        // Shields/badges and emoji must stay in the line of text; screenshots
        // must not. Decide here, where the width attribute is still visible,
        // rather than with a CSS selector that can't tell them apart.
        const declared = Number(node.properties.width);
        const isSmall = Number.isFinite(declared) && declared > 0 && declared <= 160;
        const isEmoji = String(node.properties.className ?? "").includes("emoji");
        if (isSmall || isEmoji) {
          node.properties.className = [
            ...(Array.isArray(node.properties.className) ? node.properties.className : []),
            "gh-inline",
          ];
        }
      }
      if (node.tagName === "video") {
        node.properties!.controls = true;
        node.properties!.preload = "metadata";
      }
    });
  };
}

/** Opens every link in a new tab, since this is not GitHub. */
function externalLinks() {
  return () => (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a") return;
      node.properties = { ...node.properties, target: "_blank", rel: ["noreferrer", "noopener"] };
    });
  };
}

export function sanitizeGitHubHtml(html: string, prId?: string): string {
  if (!html?.trim()) return "";
  try {
    return String(
      unified()
        .use(rehypeParse, { fragment: true })
        .use(rehypeSanitize, schema)
        .use(rewriteMedia(prId))
        .use(externalLinks())
        .use(rehypeStringify)
        .processSync(html),
    );
  } catch (err) {
    console.warn("[html] sanitise failed:", err instanceof Error ? err.message : err);
    return "";
  }
}
