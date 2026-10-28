import { getViewer, ghGraphQl } from "@/lib/gh";
import { loadConfig } from "@/lib/config";
import { handle, prTarget, type PrRouteParams } from "@/lib/api";
import { normalizeChecks, type RawRollup } from "@/lib/github/normalize";

export const dynamic = "force-dynamic";

const QUERY = `
query PrChecksLight($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      mergeable
      reviewDecision
      latestReviews(first: 25) { nodes { state author { login } } }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 60) {
                nodes {
                  __typename
                  ... on CheckRun { name conclusion status detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Cheap, pollable view of just the things that change right after approving:
 * the review decision and the CI contexts. The full detail route refetches the
 * diff, which is far too heavy to poll.
 */
export async function GET(_request: Request, { params }: { params: Promise<PrRouteParams> }) {
  return handle(async () => {
    const target = await prTarget(params);
    const config = loadConfig();
    const viewer = config.viewer || (await getViewer()).login;

    const data = await ghGraphQl<{
      repository: {
        pullRequest: {
          state: string;
          mergeable: string;
          reviewDecision: string | null;
          latestReviews: { nodes: { state: string; author: { login: string } | null }[] };
          commits: { nodes: { commit: { oid: string; statusCheckRollup: RawRollup | null } }[] };
        } | null;
      };
    }>(QUERY, { owner: target.owner, repo: target.repo, number: target.number });

    const pr = data.repository?.pullRequest;
    if (!pr) throw new Error("Pull request not found");

    const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
    const { state, checks, failing } = normalizeChecks(rollup);

    const gate = config.approval.gateCheck.trim().toLowerCase();
    const gateChecks = gate
      ? checks.filter((c) => c.name.toLowerCase().includes(gate))
      : [];

    return {
      state: pr.state,
      mergeable: pr.mergeable,
      reviewDecision: pr.reviewDecision,
      viewerHasApproved: pr.latestReviews.nodes.some(
        (r) => r?.author?.login === viewer && r.state === "APPROVED",
      ),
      checkState: state,
      failingChecks: failing,
      checks,
      gateCheck: gateChecks[0] ?? null,
      gateCheckName: config.approval.gateCheck,
    };
  });
}
