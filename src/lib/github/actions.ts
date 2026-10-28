import { gh, ghJson, prId } from "../gh";
import { logAction } from "../db";
import type { AppConfig, SuggestedReviewComment } from "../types";

export interface ActionStep {
  step: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface ActionOutcome {
  ok: boolean;
  steps: ActionStep[];
}

interface Target {
  owner: string;
  repo: string;
  number: number;
}

const nwo = (t: Target) => `${t.owner}/${t.repo}`;

async function step(
  target: Target,
  name: string,
  run: () => Promise<string>,
): Promise<ActionStep> {
  try {
    const detail = (await run()).trim();
    logAction(prId(target.owner, target.repo, target.number), name, detail.slice(0, 500), true);
    return { step: name, ok: true, detail: detail.slice(0, 400) || "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logAction(prId(target.owner, target.repo, target.number), name, message.slice(0, 500), false);
    return { step: name, ok: false, detail: message.slice(0, 600) };
  }
}

/** Labels currently on the PR, so we only remove ones that are actually there. */
async function currentLabels(target: Target): Promise<string[]> {
  try {
    const data = await ghJson<{ labels: { name: string }[] }>([
      "pr",
      "view",
      String(target.number),
      "--repo",
      nwo(target),
      "--json",
      "labels",
    ]);
    return data.labels.map((l) => l.name);
  } catch {
    return [];
  }
}

function describeLabelEdit(add: string[], remove: string[]): string {
  const parts: string[] = [];
  if (add.length > 0) parts.push(`add ${add.map((l) => `"${l}"`).join(" + ")}`);
  if (remove.length > 0) parts.push(`remove ${remove.map((l) => `"${l}"`).join(" + ")}`);
  return `Labels: ${parts.join(", ")}`;
}

/**
 * Applies every label change in a single `gh pr edit`, so GitHub records one
 * timeline event rather than one per label. That call is all-or-nothing — it
 * fails if any name is missing from the repo — so a failure retries the labels
 * individually to apply the valid ones and name the offender.
 */
async function editLabels(target: Target, add: string[], remove: string[]): Promise<ActionStep[]> {
  if (add.length === 0 && remove.length === 0) return [];

  const base = ["pr", "edit", String(target.number), "--repo", nwo(target)];
  const args = [...base];
  for (const label of add) args.push("--add-label", label);
  for (const label of remove) args.push("--remove-label", label);

  const combined = await step(target, describeLabelEdit(add, remove), () => gh(args));
  if (combined.ok || add.length + remove.length === 1) return [combined];

  const individual: ActionStep[] = [
    { ...combined, detail: `${combined.detail}\n(retrying one label at a time)` },
  ];
  for (const label of add) {
    individual.push(
      await step(target, `Add label "${label}"`, () => gh([...base, "--add-label", label])),
    );
  }
  for (const label of remove) {
    individual.push(
      await step(target, `Remove label "${label}"`, () => gh([...base, "--remove-label", label])),
    );
  }
  return individual;
}

/**
 * Runs the configured risk-review approval sequence: approve, self-assign,
 * label, and post the configured comment. Every step runs even if an earlier one fails,
 * so a missing label never blocks the approval itself.
 */
export async function approvePr(
  target: Target,
  config: AppConfig,
  overrides: Partial<AppConfig["approval"]> = {},
): Promise<ActionOutcome> {
  const settings = { ...config.approval, ...overrides };
  const steps: ActionStep[] = [];
  const repoFlag = ["--repo", nwo(target)];
  const num = String(target.number);

  if (settings.approve) {
    steps.push(
      await step(target, "Approve review", () => {
        const args = ["pr", "review", num, ...repoFlag, "--approve"];
        if (settings.approveBody.trim()) args.push("--body", settings.approveBody);
        return gh(args);
      }),
    );
  } else {
    steps.push({ step: "Approve review", ok: true, detail: "disabled in settings", skipped: true });
  }

  if (settings.assignSelf) {
    steps.push(
      await step(target, "Assign myself", () =>
        gh(["pr", "edit", num, ...repoFlag, "--add-assignee", "@me"]),
      ),
    );
  }

  // Only strip labels the PR actually carries — asking GitHub to remove an
  // absent label is an error, and "if present" is the whole point.
  const present = settings.removeLabels.length > 0 ? await currentLabels(target) : [];
  const toRemove = settings.removeLabels.filter((label) => present.includes(label));
  const toAdd = settings.labels.filter((label) => !present.includes(label));

  if (toAdd.length > 0 || toRemove.length > 0) {
    steps.push(...(await editLabels(target, toAdd, toRemove)));
  } else if (settings.labels.length > 0) {
    steps.push({
      step: "Labels",
      ok: true,
      detail: "already set",
      skipped: true,
    });
  }

  if (settings.comment.trim()) {
    steps.push(
      await step(target, `Comment "${settings.comment}"`, () =>
        gh(["pr", "comment", num, ...repoFlag, "--body", settings.comment]),
      ),
    );
  }

  return { ok: steps.every((s) => s.ok), steps };
}

export async function commentOnPr(target: Target, body: string): Promise<ActionOutcome> {
  const result = await step(target, "Post comment", () =>
    gh(["pr", "comment", String(target.number), "--repo", nwo(target), "--body", body]),
  );
  return { ok: result.ok, steps: [result] };
}

/**
 * Submits a review with optional inline comments. `suggestedCode` is rendered
 * as a GitHub ```suggestion block so it can be committed from the PR page.
 */
export async function submitReview(
  target: Target,
  event: "REQUEST_CHANGES" | "COMMENT" | "APPROVE",
  body: string,
  comments: SuggestedReviewComment[] = [],
): Promise<ActionOutcome> {
  const payload = {
    event,
    body: body || (event === "REQUEST_CHANGES" ? "Changes requested." : ""),
    comments: comments
      .filter((c) => c.file && Number.isFinite(c.line) && c.line > 0)
      .map((c) => ({
        path: c.file,
        line: Math.max(1, Math.floor(c.line)),
        side: "RIGHT" as const,
        body: c.suggestedCode
          ? `${c.body}\n\n\`\`\`suggestion\n${c.suggestedCode.replace(/\n$/, "")}\n\`\`\``
          : c.body,
      })),
  };

  const result = await step(target, `Submit ${event.toLowerCase().replace("_", " ")}`, () =>
    gh(
      [
        "api",
        "--method",
        "POST",
        `repos/${nwo(target)}/pulls/${target.number}/reviews`,
        "--input",
        "-",
      ],
      { input: JSON.stringify(payload) },
    ),
  );

  // Inline comments are rejected when a line isn't part of the diff. Retry
  // without them so the review body still lands rather than failing outright.
  if (!result.ok && payload.comments.length > 0) {
    const retry = await step(target, `Submit ${event.toLowerCase()} (without inline comments)`, () =>
      gh(
        ["api", "--method", "POST", `repos/${nwo(target)}/pulls/${target.number}/reviews`, "--input", "-"],
        { input: JSON.stringify({ event: payload.event, body: payload.body }) },
      ),
    );
    return {
      ok: retry.ok,
      steps: [
        { ...result, detail: `${result.detail}\n(retrying without inline comments)` },
        retry,
      ],
    };
  }

  return { ok: result.ok, steps: [result] };
}

export async function replyToThread(
  target: Target,
  inReplyToCommentId: number,
  body: string,
): Promise<ActionOutcome> {
  const result = await step(target, "Reply to thread", () =>
    gh(
      [
        "api",
        "--method",
        "POST",
        `repos/${nwo(target)}/pulls/${target.number}/comments`,
        "--input",
        "-",
      ],
      { input: JSON.stringify({ body, in_reply_to: inReplyToCommentId }) },
    ),
  );
  return { ok: result.ok, steps: [result] };
}

export async function setLabels(
  target: Target,
  add: string[],
  remove: string[],
): Promise<ActionOutcome> {
  const steps = await editLabels(target, add, remove);
  return { ok: steps.every((s) => s.ok), steps };
}

/** Repo labels, used to warn when a configured approval label doesn't exist. */
export async function listRepoLabels(owner: string, repo: string): Promise<string[]> {
  try {
    const labels = await ghJson<{ name: string }[]>([
      "api",
      `repos/${owner}/${repo}/labels?per_page=100`,
      "--paginate",
    ]);
    return labels.map((l) => l.name);
  } catch {
    return [];
  }
}
