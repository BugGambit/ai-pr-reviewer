"use client";

import Link from "next/link";
import useSWR from "swr";
import { fetcher, prPath } from "@/lib/client";
import { Spinner, VERDICT_META } from "@/components/ui";
import type { Verdict } from "@/lib/types";

interface StackNode {
  id: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  checkState: string | null;
  reviewDecision: string | null;
  verdict: string | null;
  riskScore: number | null;
  isCurrent: boolean;
}

/**
 * Stacked PRs merge bottom-up, and GitHub shows no link between them at all.
 * Laying the chain out makes it obvious whether the PR you are looking at is
 * actually the next one to review, or three deep behind work that hasn't
 * landed yet.
 */
export function StackView({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const { data, isLoading } = useSWR<{ nodes: StackNode[]; isStack: boolean }>(
    `/api/pr/${owner}/${repo}/${number}/stack`,
    fetcher,
    { revalidateOnFocus: false },
  );

  if (isLoading) {
    return (
      <div style={{ padding: "10px 0" }}>
        <Spinner label="Looking for stacked PRs…" />
      </div>
    );
  }
  if (!data?.isStack) return null;

  const nodes = data.nodes;
  const currentIndex = nodes.findIndex((n) => n.isCurrent);
  const below = currentIndex;

  return (
    <section className="card" style={{ padding: 18, marginBottom: 16 }}>
      <header style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          Part of a stack of {nodes.length}
        </h2>
        <p className="muted" style={{ margin: "3px 0 0", fontSize: 12.5 }}>
          {below === 0
            ? "This is the bottom — reviewing it unblocks everything above."
            : `${below} PR${below === 1 ? "" : "s"} below this one must merge first. Review from the bottom up.`}
        </p>
      </header>

      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {nodes.map((node, index) => {
          const meta = node.verdict ? VERDICT_META[node.verdict as Verdict] : null;
          const isBelowCurrent = currentIndex >= 0 && index < currentIndex;
          const last = index === nodes.length - 1;

          return (
            <li key={node.id} style={{ display: "flex", gap: 12 }}>
              {/* Rail: the chain, bottom of the stack at the top of the list. */}
              <div
                style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "none", width: 18 }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 11,
                    height: 11,
                    borderRadius: "50%",
                    marginTop: 13,
                    background: node.isCurrent ? "var(--series-1)" : meta ? meta.color : "var(--surface-3)",
                    border: node.isCurrent ? "2px solid var(--ink-primary)" : "1px solid var(--border-strong)",
                    flex: "none",
                  }}
                />
                {!last ? (
                  <span aria-hidden style={{ flex: 1, width: 2, background: "var(--border-strong)", minHeight: 22 }} />
                ) : null}
              </div>

              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "9px 12px",
                  marginBottom: 7,
                  borderRadius: 8,
                  border: `1px solid ${node.isCurrent ? "var(--series-1)" : "var(--border)"}`,
                  background: node.isCurrent ? "color-mix(in srgb, var(--series-1) 10%, transparent)" : "var(--surface-2)",
                  opacity: isBelowCurrent || node.isCurrent ? 1 : 0.68,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                  <span className="chip muted" style={{ fontSize: 10.5 }}>
                    {index === 0 ? "merges first" : `#${index + 1}`}
                  </span>
                  {node.isCurrent ? (
                    <span className="chip" style={{ color: "var(--series-1)", borderColor: "var(--series-1)" }}>
                      you are here
                    </span>
                  ) : null}
                  {meta ? (
                    <span className="chip" style={{ color: meta.color, borderColor: meta.color }}>
                      <span aria-hidden>{meta.icon}</span>
                      {node.riskScore ?? ""}
                    </span>
                  ) : null}
                  {node.isDraft ? <span className="chip">draft</span> : null}
                </div>

                <div style={{ marginTop: 4 }}>
                  {node.isCurrent ? (
                    <span style={{ fontSize: 13, fontWeight: 550 }}>{node.title}</span>
                  ) : (
                    <Link
                      href={prPath(owner, repo, node.number)}
                      style={{ fontSize: 13, fontWeight: 500, textDecoration: "underline", textUnderlineOffset: 2 }}
                    >
                      {node.title}
                    </Link>
                  )}
                </div>

                <div className="muted" style={{ fontSize: 11.5, marginTop: 2, display: "flex", gap: 10 }}>
                  <span className="mono">#{node.number}</span>
                  <span>@{node.author}</span>
                  <span className="tabular">
                    <span style={{ color: "var(--status-good)" }}>+{node.additions}</span>{" "}
                    <span style={{ color: "var(--status-critical)" }}>−{node.deletions}</span>
                  </span>
                  {node.reviewDecision === "APPROVED" ? (
                    <span style={{ color: "var(--status-good)" }}>approved</span>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
