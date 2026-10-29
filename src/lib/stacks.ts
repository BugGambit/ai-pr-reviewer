import type { PrSummary, StackInfo } from "./types";

const COMMON_DEFAULTS = new Set(["main", "master", "develop", "trunk"]);

function isDefaultBranch(pr: PrSummary, branch: string): boolean {
  if (pr.defaultBranch) return branch === pr.defaultBranch;
  // Falling back to convention is better than calling every feature branch a
  // stack when the API didn't report a default.
  return COMMON_DEFAULTS.has(branch);
}

const branchKey = (pr: PrSummary, branch: string) => `${pr.owner}/${pr.repo}:${branch}`;

/**
 * Detects stacked pull requests — a PR whose base is another PR's head rather
 * than the repo's default branch. GitHub shows no relationship between them, so
 * it is easy to review the top of a stack without realising three other PRs
 * must land first.
 *
 * Works off `baseRefName`/`headRefName`, which the list query already fetches,
 * so this costs no extra API calls.
 */
export function buildStacks(prs: PrSummary[]): void {
  const byHead = new Map<string, PrSummary>();
  for (const pr of prs) byHead.set(branchKey(pr, pr.headRefName), pr);

  const parentOf = new Map<string, PrSummary | null>();
  const unknownBase = new Map<string, string | null>();

  for (const pr of prs) {
    if (isDefaultBranch(pr, pr.baseRefName)) {
      parentOf.set(pr.id, null);
      unknownBase.set(pr.id, null);
      continue;
    }
    const parent = byHead.get(branchKey(pr, pr.baseRefName)) ?? null;
    parentOf.set(pr.id, parent);
    // Targets a feature branch we can't see a PR for — still stacked, just
    // on something outside the current view.
    unknownBase.set(pr.id, parent ? null : pr.baseRefName);
  }

  const childrenOf = new Map<string, string[]>();
  for (const pr of prs) {
    const parent = parentOf.get(pr.id);
    if (!parent) continue;
    childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), pr.id]);
  }

  const byId = new Map(prs.map((pr) => [pr.id, pr]));

  /** Walks up to the bottom, guarding against a cycle in malformed data. */
  const ancestors = (pr: PrSummary): PrSummary[] => {
    const chain: PrSummary[] = [];
    const seen = new Set<string>([pr.id]);
    let cursor = parentOf.get(pr.id) ?? null;
    while (cursor && !seen.has(cursor.id)) {
      chain.push(cursor);
      seen.add(cursor.id);
      cursor = parentOf.get(cursor.id) ?? null;
    }
    return chain;
  };

  const descendantCount = (id: string): number => {
    let total = 0;
    const queue = [...(childrenOf.get(id) ?? [])];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      total++;
      queue.push(...(childrenOf.get(next) ?? []));
    }
    return total;
  };

  // The bottom PR (or the branch it targets, when that PR isn't in view) names
  // the stack, so every PR above it lands in the same group.
  const groupOf = new Map<string, string>();
  for (const pr of prs) {
    const chain = ancestors(pr);
    const bottom = chain[chain.length - 1] ?? pr;
    const unknown = unknownBase.get(bottom.id);
    groupOf.set(pr.id, unknown ? branchKey(bottom, unknown) : bottom.id);
  }
  const groupSizes = new Map<string, number>();
  for (const id of groupOf.values()) groupSizes.set(id, (groupSizes.get(id) ?? 0) + 1);

  for (const pr of prs) {
    const chain = ancestors(pr);
    const parent = parentOf.get(pr.id) ?? null;
    const children = childrenOf.get(pr.id) ?? [];
    const unknown = unknownBase.get(pr.id) ?? null;

    const isStacked = chain.length > 0 || children.length > 0 || Boolean(unknown);
    if (!isStacked) {
      pr.stack = null;
      continue;
    }

    const info: StackInfo = {
      size: chain.length + 1 + descendantCount(pr.id),
      groupId: groupOf.get(pr.id)!,
      groupSize: groupSizes.get(groupOf.get(pr.id)!) ?? 1,
      position: chain.length + 1,
      parentId: parent?.id ?? null,
      childIds: children,
      isBottom: chain.length === 0 && !unknown,
      unknownParentBranch: unknown,
      // Only open ancestors actually block; a merged one is already out of the way.
      blockedBy: chain.filter((a) => byId.has(a.id)).map((a) => a.id),
    };
    pr.stack = info;
  }
}

/** One-line description for a row, e.g. "stack 2/4 — #123 first". */
export function describeStack(pr: PrSummary, byId: Map<string, PrSummary>): string | null {
  const stack = pr.stack;
  if (!stack) return null;

  if (stack.unknownParentBranch) {
    return `stacked on ${stack.unknownParentBranch}`;
  }
  if (stack.isBottom) {
    const below = stack.size - 1;
    return below > 0 ? `bottom of stack — ${below} PR${below === 1 ? "" : "s"} wait on it` : null;
  }
  const first = stack.blockedBy[stack.blockedBy.length - 1];
  const parent = first ? byId.get(first) : undefined;
  return `stack ${stack.position}/${stack.size}${parent ? ` — #${parent.number} first` : ""}`;
}
