import type { Interdiff, InterdiffFile, InterdiffLine } from "../types";
import { classifyFile, parseDiff, type DiffFile } from "./diff";

/**
 * Compares two versions of a PR's *net* diff (base...head), not its commits.
 * That makes it indifferent to how the author got from one to the other:
 * extra commits, squashes, rebases and force-pushes all reduce to "which
 * change lines does the PR carry now that it didn't before, and vice versa".
 *
 * Only the +/- lines take part. Hunk headers, line numbers and context lines
 * move whenever the base moves, so including them would make every rebase
 * look like a rewrite.
 */

/** Above this many DP cells a file falls back to order-insensitive matching. */
const MAX_LCS_CELLS = 4_000_000;
const MAX_REVERTED_PER_FILE = 200;
const LANDED_DROPPED_RATIO = 0.8;
/** Lines of already-reviewed code kept around each novel line in the model's view. */
const MODEL_CONTEXT = 8;

interface ChangeRef {
  key: string;
  hunk: number;
  line: number;
}

function changeLines(file: DiffFile): ChangeRef[] {
  const out: ChangeRef[] = [];
  file.hunks.forEach((hunk, h) => {
    hunk.lines.forEach((line, l) => {
      if (line.type === "ctx") return;
      out.push({ key: `${line.type === "add" ? "+" : "-"}${line.content.replace(/\r$/, "")}`, hunk: h, line: l });
    });
  });
  return out;
}

/** Marks which entries of `a` and `b` belong to a longest common subsequence. */
function matchSequences(a: string[], b: string[]): { aMatched: boolean[]; bMatched: boolean[] } {
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    aMatched[start] = bMatched[start] = true;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    aMatched[endA] = bMatched[endB] = true;
  }

  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { aMatched, bMatched };

  if (n * m > MAX_LCS_CELLS) {
    // Order-insensitive: each key matches min(count in a, count in b) times.
    const countIn = (xs: string[], from: number, to: number) => {
      const counts = new Map<string, number>();
      for (let i = from; i < to; i++) counts.set(xs[i], (counts.get(xs[i]) ?? 0) + 1);
      return counts;
    };
    const inA = countIn(a, start, endA);
    const inB = countIn(b, start, endB);
    const take = (xs: string[], from: number, to: number, matched: boolean[], other: Map<string, number>) => {
      const budget = new Map(other);
      for (let i = from; i < to; i++) {
        const left = budget.get(xs[i]) ?? 0;
        if (left > 0) {
          matched[i] = true;
          budget.set(xs[i], left - 1);
        }
      }
    };
    take(a, start, endA, aMatched, inB);
    take(b, start, endB, bMatched, inA);
    return { aMatched, bMatched };
  }

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[start + i] === b[start + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      aMatched[start + i] = bMatched[start + j] = true;
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { aMatched, bMatched };
}

function annotateHunks(file: DiffFile, novel: Set<string>): InterdiffFile["hunks"] {
  return file.hunks.flatMap((hunk, h) => {
    const lines: InterdiffLine[] = hunk.lines.map((line, l) => ({
      ...line,
      novel: novel.has(`${h}:${l}`),
    }));
    return lines.some((l) => l.novel) ? [{ header: hunk.header, lines }] : [];
  });
}

export function computeInterdiff(
  fromDiff: string,
  toDiff: string,
  meta: { fromSha: string; toSha: string; partial: boolean },
): Interdiff {
  const fromFiles = parseDiff(fromDiff);
  const toFiles = parseDiff(toDiff);
  const byPath = new Map(fromFiles.map((f) => [f.path, f]));
  const seen = new Set<string>();

  const files: InterdiffFile[] = [];
  let unchangedFiles = 0;

  for (const file of toFiles) {
    const prior = byPath.get(file.path) ?? (file.isRename ? byPath.get(file.oldPath) : undefined);
    const now = changeLines(file);

    if (!prior) {
      files.push({
        path: file.path,
        status: "new",
        novelLines: now.length,
        revertedLines: 0,
        hunks: annotateHunks(file, new Set(now.map((c) => `${c.hunk}:${c.line}`))),
        reverted: [],
        landedLines: 0,
      });
      continue;
    }
    seen.add(prior.path);

    const before = changeLines(prior);
    const { aMatched, bMatched } = matchSequences(
      before.map((c) => c.key),
      now.map((c) => c.key),
    );
    const novel = new Set(now.filter((_, i) => !bMatched[i]).map((c) => `${c.hunk}:${c.line}`));
    const reverted = before.filter((_, i) => !aMatched[i]).map((c) => c.key);

    if (novel.size === 0 && reverted.length === 0 && prior.path === file.path) {
      unchangedFiles++;
      continue;
    }
    files.push({
      path: prior.path === file.path ? file.path : `${prior.path} → ${file.path}`,
      status: "changed",
      novelLines: novel.size,
      revertedLines: reverted.length,
      hunks: annotateHunks(file, novel),
      reverted,
      landedLines: 0,
    });
  }

  for (const file of fromFiles) {
    if (seen.has(file.path)) continue;
    const before = changeLines(file);
    files.push({
      path: file.path,
      status: "dropped",
      novelLines: 0,
      revertedLines: before.length,
      hunks: [],
      reverted: before.map((c) => c.key),
      landedLines: 0,
    });
  }

  return {
    fromSha: meta.fromSha,
    toSha: meta.toSha,
    identical: files.length === 0,
    files,
    unchangedFiles,
    landedFiles: [],
    partial: meta.partial,
  };
}

export type Folded<T> = { line: T } | { folded: number };

/** Keeps novel lines and `context` lines around them; collapses each other run into a count. */
export function foldContext<T extends { novel: boolean }>(lines: T[], context: number): Folded<T>[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (!line.novel) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const out: Folded<T>[] = [];
  lines.forEach((line, i) => {
    const last = out[out.length - 1];
    if (keep[i]) out.push({ line });
    else if (last && "folded" in last) last.folded++;
    else out.push({ folded: 1 });
  });
  return out;
}

/** Paths whose baseline change lines left the PR, i.e. what `creditUpstream` needs base contents for. */
export function pathsNeedingBase(interdiff: Interdiff): string[] {
  return interdiff.files.filter((f) => f.reverted.length > 0).map((f) => f.path.split(" → ").pop() ?? f.path);
}

/**
 * A change line can leave a PR's net diff without the author touching it:
 * once a stacked PR underneath is squash-merged and this one is rebased, the
 * base branch carries those lines itself. Given the base branch's current
 * file contents (null = file absent), this credits such lines to upstream so
 * only genuine author changes remain.
 */
export function creditUpstream(interdiff: Interdiff, baseContents: Map<string, string | null>): Interdiff {
  const files: InterdiffFile[] = [];
  const landedFiles = [...interdiff.landedFiles];

  for (const file of interdiff.files) {
    const path = file.path.split(" → ").pop() ?? file.path;
    if (file.reverted.length === 0 || !baseContents.has(path)) {
      files.push({ ...file, reverted: file.reverted.slice(0, MAX_REVERTED_PER_FILE) });
      continue;
    }

    const content = baseContents.get(path);
    const baseLines = new Set((content ?? "").split("\n").map((l) => l.replace(/\r$/, "")));
    // "+x" gone from the PR is explained if the base now has x; "-x" gone is
    // explained if the base no longer has x.
    const remaining = file.reverted.filter((key) =>
      key.startsWith("+") ? !baseLines.has(key.slice(1)) : baseLines.has(key.slice(1)),
    );
    const landed = file.reverted.length - remaining.length;
    // A file the PR no longer touches, whose changes are mostly on the base
    // now, landed upstream and was edited again there afterwards.
    const mostlyLanded = file.status === "dropped" && landed / file.reverted.length >= LANDED_DROPPED_RATIO;

    if (file.novelLines === 0 && (remaining.length === 0 || mostlyLanded)) {
      landedFiles.push(file.path);
      continue;
    }
    files.push({
      ...file,
      status: file.status === "dropped" && remaining.length === 0 ? "changed" : file.status,
      revertedLines: remaining.length,
      reverted: remaining.slice(0, MAX_REVERTED_PER_FILE),
      landedLines: file.landedLines + landed,
    });
  }

  return { ...interdiff, files, landedFiles, identical: files.length === 0 };
}

/**
 * A unified diff containing only the novel change lines (everything else is
 * demoted to context), so the deterministic pre-scan judges just the delta.
 */
export function interdiffAsPatch(interdiff: Interdiff): string {
  const out: string[] = [];
  for (const file of interdiff.files) {
    if (file.hunks.length === 0) continue;
    const path = file.path.split(" → ").pop() ?? file.path;
    out.push(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`);
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) {
        if (line.novel && line.type === "add") out.push(`+${line.content}`);
        else if (line.novel && line.type === "del") out.push(`-${line.content}`);
        else if (line.type !== "del") out.push(` ${line.content}`);
      }
    }
  }
  return out.join("\n");
}

/** Kinds whose churn is noise to a reader and a model alike. */
const QUIET_KINDS = new Set(["lockfile", "generated", "asset"]);

/**
 * Renders the interdiff as text for the model, two marker columns per line:
 * "+ " / "- " for change lines new since the baseline, "=+" / "=-" for change
 * lines the PR already carried, and "  " for unchanged context.
 */
export function interdiffForModel(interdiff: Interdiff, maxBytes = 200_000): string {
  const out: string[] = [];
  let bytes = 0;
  if (interdiff.landedFiles.length > 0) {
    out.push(
      `Files that left the PR because the base branch now contains their changes (not author edits): ${interdiff.landedFiles.join(", ")}`,
    );
  }

  for (const file of interdiff.files) {
    const quiet = QUIET_KINDS.has(classifyFile(file.path.split(" → ").pop() ?? file.path));
    const landed = file.landedLines > 0 ? `, ${file.landedLines} now on the base branch` : "";
    const header = `### ${file.path} (${file.status}; ${file.novelLines} new change lines, ${file.revertedLines} no longer in the PR${landed})`;
    const section: string[] = [header];

    if (quiet) {
      section.push("(contents elided: lockfile, generated or binary asset)");
    } else {
      for (const hunk of file.hunks) {
        section.push(hunk.header);
        for (const row of foldContext(hunk.lines, MODEL_CONTEXT)) {
          if ("folded" in row) {
            section.push(`  … ${row.folded} line(s) unchanged since the baseline …`);
            continue;
          }
          const { line } = row;
          const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
          const marker = line.type === "ctx" ? "  " : line.novel ? `${sign} ` : `=${sign}`;
          section.push(`${marker}${line.content}`);
        }
      }
      if (file.reverted.length > 0) {
        section.push("No longer in the PR (was part of it at the baseline):");
        for (const key of file.reverted) section.push(`x${key}`);
      }
    }

    const text = section.join("\n");
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      out.push(`[interdiff truncated; ${interdiff.files.length - out.length} more file(s) not shown]`);
      break;
    }
    out.push(text);
  }
  return out.join("\n\n");
}
