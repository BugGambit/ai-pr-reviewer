export interface DiffLine {
  type: "add" | "del" | "ctx";
  content: string;
  /** Line number in the new file, when known. */
  newLine: number | null;
  oldLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Minimal unified-diff parser; good enough for scanning and rendering. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let newLine = 0;
  let oldLine = 0;

  for (const raw of diff.split("\n")) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (gitHeader) {
      current = {
        path: gitHeader[2],
        oldPath: gitHeader[1],
        isNew: false,
        isDeleted: false,
        isRename: gitHeader[1] !== gitHeader[2],
        isBinary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;

    if (raw.startsWith("new file mode")) current.isNew = true;
    else if (raw.startsWith("deleted file mode")) current.isDeleted = true;
    else if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) current.isBinary = true;

    const hunkMatch = HUNK_RE.exec(raw);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      hunk = { header: raw, lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      current.additions++;
      hunk.lines.push({ type: "add", content: raw.slice(1), newLine, oldLine: null });
      newLine++;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      current.deletions++;
      hunk.lines.push({ type: "del", content: raw.slice(1), newLine: null, oldLine });
      oldLine++;
    } else if (raw.startsWith(" ")) {
      hunk.lines.push({ type: "ctx", content: raw.slice(1), newLine, oldLine });
      newLine++;
      oldLine++;
    }
  }

  return files;
}

export type FileKind =
  | "test"
  | "source"
  | "config"
  | "dependency"
  | "lockfile"
  | "generated"
  | "ci"
  | "infra"
  | "docs"
  | "migration"
  | "asset";

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "uv.lock",
]);

const DEPENDENCY_FILES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "build.gradle",
  "pom.xml",
]);

export function classifyFile(path: string): FileKind {
  const name = path.split("/").pop() ?? path;
  const lower = path.toLowerCase();

  if (LOCKFILES.has(name)) return "lockfile";
  if (DEPENDENCY_FILES.has(name)) return "dependency";
  if (lower.startsWith(".github/workflows/") || lower.includes("/.github/workflows/")) return "ci";
  if (/(^|\/)(jenkinsfile|\.circleci|\.gitlab-ci|azure-pipelines|buildkite)/.test(lower)) return "ci";
  if (/\.(tf|tfvars)$/.test(lower) || /(^|\/)(dockerfile|docker-compose)/.test(lower)) return "infra";
  if (/(^|\/)(charts?|k8s|kubernetes|helm|manifests)\//.test(lower)) return "infra";
  if (/(^|\/)(migrations?|alembic)\//.test(lower) || /\.migration\./.test(lower)) return "migration";
  if (/\.(test|spec)\.[jt]sx?$/.test(lower) || /(^|\/)(tests?|__tests__|e2e|cypress)\//.test(lower)) return "test";
  if (/(^|\/)test_[^/]+\.py$/.test(lower) || /_test\.(go|py|rb)$/.test(lower)) return "test";
  if (/\.(md|mdx|rst|txt|adoc)$/.test(lower)) return "docs";
  if (/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|pdf)$/.test(lower)) return "asset";
  if (/\.(snap|generated\.[a-z]+|pb\.go|_pb2\.py)$/.test(lower) || lower.includes("/generated/")) {
    return "generated";
  }
  if (/\.(json|ya?ml|toml|ini|env|conf|cfg|properties)$/.test(lower)) return "config";
  return "source";
}

/** Groups changed paths into top-level areas for the "what changed" overview. */
export function groupByArea(paths: string[]): { area: string; files: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const parts = path.split("/");
    const area = parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0] || "root";
    const list = groups.get(area) ?? [];
    list.push(path);
    groups.set(area, list);
  }
  return [...groups.entries()]
    .map(([area, files]) => ({ area, files }))
    .sort((a, b) => b.files.length - a.files.length);
}

export interface TrimmedDiff {
  diff: string;
  elided: { path: string; lines: number; reason: string }[];
  originalBytes: number;
  trimmedBytes: number;
}

/** Kinds whose contents carry no review signal but plenty of tokens. */
const ELIDE_KINDS = new Set<FileKind>(["lockfile", "generated", "asset"]);

/** A single file this large is almost certainly bulk data, whatever its kind. */
const HUGE_FILE_LINES = 1500;

/**
 * Replaces the body of no-signal files with a one-line note before the diff is
 * sent to the model. A 4,000-line lockfile churn costs real latency and tells a
 * reviewer nothing that "the lockfile changed" doesn't. The file still appears,
 * so the model knows it was touched — and the full diff is untouched for the
 * Files tab.
 */
export function trimDiffForModel(diff: string): TrimmedDiff {
  const originalBytes = Buffer.byteLength(diff, "utf8");
  if (!diff.trim()) {
    return { diff, elided: [], originalBytes, trimmedBytes: originalBytes };
  }

  const elided: TrimmedDiff["elided"] = [];
  const out: string[] = [];

  // Split on file boundaries, keeping each header with its body.
  const sections = diff.split(/\n(?=diff --git )/);

  for (const section of sections) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    if (!header) {
      out.push(section);
      continue;
    }

    const path = header[2];
    const kind = classifyFile(path);
    const lineCount = section.split("\n").length;

    const reason = ELIDE_KINDS.has(kind)
      ? `${kind} file`
      : lineCount > HUGE_FILE_LINES
        ? `${lineCount} lines`
        : null;

    if (!reason) {
      out.push(section);
      continue;
    }

    elided.push({ path, lines: lineCount, reason });

    // Keep the git header lines so the model still sees add/delete/rename.
    const kept = section
      .split("\n")
      .slice(0, 5)
      .filter((line) => !line.startsWith("@@"))
      .join("\n");
    out.push(`${kept}\n[contents omitted by the review tool: ${reason}, ${lineCount} diff lines]`);
  }

  const trimmed = out.join("\n");
  return {
    diff: trimmed,
    elided,
    originalBytes,
    trimmedBytes: Buffer.byteLength(trimmed, "utf8"),
  };
}
