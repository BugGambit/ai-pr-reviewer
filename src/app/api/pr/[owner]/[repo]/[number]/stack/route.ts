import { ghGraphQl, prId } from "@/lib/gh";
import { getReviewVerdicts } from "@/lib/db";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";

export const dynamic = "force-dynamic";

export interface StackNode {
  id: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  checkState: string | null;
  reviewDecision: string | null;
  verdict: string | null;
  riskScore: number | null;
  isCurrent: boolean;
}

const LOOKUP = `
query StackLookup($q: String!) {
  search(query: $q, type: ISSUE, first: 10) {
    nodes {
      __typename
      ... on PullRequest {
        number title url state isDraft additions deletions changedFiles
        headRefName baseRefName reviewDecision
        author { login }
        repository { name owner { login } defaultBranchRef { name } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

interface RawNode {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  author: { login: string } | null;
  repository: { name: string; owner: { login: string }; defaultBranchRef?: { name: string } | null };
  commits: { nodes: { commit: { statusCheckRollup: { state: string | null } | null } }[] };
}

const DEFAULTS = new Set(["main", "master", "develop", "trunk"]);

async function search(q: string): Promise<RawNode[]> {
  const data = await ghGraphQl<{ search: { nodes: (RawNode | null)[] } }>(LOOKUP, { q });
  return (data.search.nodes ?? []).filter((n): n is RawNode => Boolean(n?.number));
}

function toNode(raw: RawNode, currentId: string): StackNode {
  const owner = raw.repository.owner.login;
  const repo = raw.repository.name;
  const id = prId(owner, repo, raw.number);
  return {
    id,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? "ghost",
    state: raw.state,
    isDraft: raw.isDraft,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    checkState: raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    reviewDecision: raw.reviewDecision,
    verdict: null,
    riskScore: null,
    isCurrent: id === currentId,
  };
}

/**
 * Reconstructs the stack this PR sits in by following base/head branch links
 * outward. GitHub records no relationship between stacked PRs, so each step is
 * a search: "which PR has this branch as its head" (down) and "which PRs target
 * this branch" (up).
 */
export async function GET(_request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const nwo = `${target.owner}/${target.repo}`;
    const currentId = prId(target.owner, target.repo, target.number);

    const self = (await search(`repo:${nwo} is:pr ${target.number} in:number`)).find(
      (n) => n.number === target.number,
    );
    if (!self) return { nodes: [], isStack: false };

    const defaultBranch = self.repository.defaultBranchRef?.name ?? null;
    const isDefault = (branch: string) =>
      defaultBranch ? branch === defaultBranch : DEFAULTS.has(branch);

    const found = new Map<string, RawNode>([[currentId, self]]);
    const MAX_DEPTH = 8;

    // Walk down toward the base of the stack.
    let cursor = self;
    for (let depth = 0; depth < MAX_DEPTH && !isDefault(cursor.baseRefName); depth++) {
      const [parent] = await search(`repo:${nwo} is:pr is:open head:${cursor.baseRefName}`);
      if (!parent) break;
      const id = prId(target.owner, target.repo, parent.number);
      if (found.has(id)) break;
      found.set(id, parent);
      cursor = parent;
    }

    // Walk up through everything stacked on top.
    const queue = [self];
    for (let depth = 0; depth < MAX_DEPTH && queue.length > 0; depth++) {
      const level = queue.splice(0, queue.length);
      for (const node of level) {
        const children = await search(`repo:${nwo} is:pr is:open base:${node.headRefName}`);
        for (const child of children) {
          const id = prId(target.owner, target.repo, child.number);
          if (found.has(id)) continue;
          found.set(id, child);
          queue.push(child);
        }
      }
    }

    const nodes = [...found.values()].map((raw) => toNode(raw, currentId));

    // Order them bottom-first by following the branch chain.
    const byHead = new Map(nodes.map((n) => [n.headRefName, n]));
    const ordered: StackNode[] = [];
    const seen = new Set<string>();

    let bottom = nodes.find((n) => isDefault(n.baseRefName)) ?? nodes[0];
    while (bottom && !seen.has(bottom.id)) {
      ordered.push(bottom);
      seen.add(bottom.id);
      bottom = nodes.find((n) => n.baseRefName === bottom!.headRefName && !seen.has(n.id))!;
    }
    for (const node of nodes) if (!seen.has(node.id)) ordered.push(node);
    void byHead;

    // Attach any cached review verdicts so the chain shows risk at a glance.
    const verdicts = getReviewVerdicts(ordered.map((n) => n.id));
    for (const node of ordered) {
      const review = verdicts.get(node.id);
      if (review?.result) {
        node.verdict = review.result.verdict;
        node.riskScore = review.result.riskScore;
      }
    }

    return { nodes: ordered, isStack: ordered.length > 1 };
  });
}
