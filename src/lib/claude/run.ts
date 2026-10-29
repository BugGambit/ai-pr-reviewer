import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig, PrDetail, ReviewResult, StoredReview } from "../types";
import { analyzeDiff } from "../analysis/heuristics";
import { createReview, finishReview, getLatestReview } from "../db";
import { prId } from "../gh";
import { checkoutPr } from "../checkout";
import { REVIEW_SCHEMA } from "./schema";
import { parsePartialJson } from "./partialJson";
import { SYSTEM_PROMPT, buildReviewPrompt } from "./prompt";

interface StreamEvent {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  /** Cursor stamps incremental assistant deltas; the closing full message has none. */
  timestamp_ms?: number;
  event?: {
    type: string;
    delta?: { type?: string; text?: string; partial_json?: string };
  };
  message?: { content?: { type: string; text?: string }[] };
}

type Provider = "claude" | "cursor";

interface StreamState {
  streamed: string;
  finalText: string;
  costUsd: number | null;
  durationMs: number | null;
}

const PROVIDER_LABEL: Record<Provider, string> = { claude: "claude CLI", cursor: "Cursor agent CLI" };

function messageText(event: StreamEvent): string {
  return (event.message?.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text as string)
    .join("");
}

/** Applies one stream-json event to the state. Returns an error message if the CLI reported failure. */
function applyEvent(provider: Provider, event: StreamEvent, state: StreamState): string | null {
  if (provider === "claude" && event.type === "stream_event" && event.event?.type === "content_block_delta") {
    const delta = event.event.delta;
    state.streamed += delta?.text ?? delta?.partial_json ?? "";
    return null;
  }

  if (event.type === "assistant") {
    const text = messageText(event);
    if (!text) return null;
    if (provider === "cursor" && event.timestamp_ms !== undefined) state.streamed += text;
    else state.streamed = text;
    return null;
  }

  if (event.type === "result") {
    if (typeof event.result === "string") state.finalText = event.result;
    state.costUsd = event.total_cost_usd ?? null;
    state.durationMs = event.duration_ms ?? null;
    if (event.is_error) return event.result ?? event.subtype ?? "unknown";
  }
  return null;
}

function extraPathDirs(): string[] {
  return [path.join(os.homedir(), ".local", "bin")];
}

function searchPath(): string {
  return [process.env.PATH ?? "", ...extraPathDirs()].filter(Boolean).join(path.delimiter);
}

function findOnPath(bin: string): string | null {
  for (const dir of searchPath().split(path.delimiter)) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function resolveProvider(config: AppConfig): Provider {
  const configured = config.review.provider ?? "auto";
  if (configured !== "auto") return configured;
  if (findOnPath("claude")) return "claude";
  if (findOnPath(process.env.CURSOR_AGENT_BIN ?? "agent")) return "cursor";
  return "claude";
}

/**
 * Runs the CLI in streaming mode and reports the partially-built review as it
 * arrives. The schema puts the verdict and headline first, so a reader gets
 * something actionable within seconds instead of staring at a spinner until the
 * whole document lands.
 */
function runStreaming(
  provider: Provider,
  args: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
  onPartial: (text: string) => void,
): Promise<{ text: string; costUsd: number | null; durationMs: number | null }> {
  const label = PROVIDER_LABEL[provider];
  const bin = provider === "cursor" ? (process.env.CURSOR_AGENT_BIN ?? "agent") : "claude";

  return new Promise((resolve, reject) => {
    const child = spawn(findOnPath(bin) ?? bin, args, {
      cwd,
      env: {
        ...process.env,
        PATH: searchPath(),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    let buffer = "";
    let stderr = "";
    const state: StreamState = { streamed: "", finalText: "", costUsd: null, durationMs: null };

    const handle = (line: string) => {
      if (!line.trim()) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        return; // non-JSON noise on stdout
      }

      const before = state.streamed;
      const error = applyEvent(provider, event, state);
      if (error) {
        clearTimeout(timer);
        reject(new Error(`${label} returned an error: ${error}`));
        return;
      }
      if (state.streamed !== before) onPartial(state.streamed);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handle(line);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${label} failed to start: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) handle(buffer);

      const text = state.finalText || state.streamed;
      if (!text) {
        reject(new Error(`${label} exited ${code} without output: ${stderr.slice(-600)}`));
        return;
      }
      resolve({ text, costUsd: state.costUsd, durationMs: state.durationMs });
    });

    child.stdin.end(prompt);
  });
}

/** Pulls the JSON object out of the CLI's `result` field, tolerating stray prose. */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new Error(`Model did not return JSON. First 400 chars: ${trimmed.slice(0, 400)}`);
}

/**
 * The Cursor CLI has no tool allowlist, so containment comes from "ask" mode
 * (read-only: no edits, no shell) plus a workspace that is either an empty
 * scratch dir or the PR checkout. MCP servers stay off because they are never
 * approved in headless runs.
 */
function cursorArgs(model: string, checkoutPath: string | undefined, scratch: string): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--mode",
    "ask",
    "--trust",
    "--model",
    model,
    "--workspace",
    checkoutPath ?? scratch,
  ];
}

/** Cursor has no --system-prompt or --json-schema, so both travel in the prompt. */
function cursorPrompt(prompt: string): string {
  return [
    SYSTEM_PROMPT,
    "",
    "OUTPUT FORMAT: reply with a single JSON object that conforms to the JSON Schema below. No prose before or after it, no markdown code fences.",
    JSON.stringify(REVIEW_SCHEMA),
    "",
    prompt,
  ].join("\n");
}

const VERDICTS = new Set(["approve", "needs_attention", "block"]);

/** Fills gaps rather than rejecting: a partially-formed review still has value. */
function coerceResult(value: unknown): ReviewResult {
  const v = (value ?? {}) as Record<string, unknown>;
  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  const str = (x: unknown, fallback = ""): string => (typeof x === "string" ? x : fallback);
  const bool = (x: unknown): boolean => x === true;

  const verdict = VERDICTS.has(String(v.verdict)) ? (v.verdict as ReviewResult["verdict"]) : "needs_attention";
  const riskRaw = Number(v.riskScore);
  const riskScore = Number.isFinite(riskRaw) ? Math.max(0, Math.min(100, Math.round(riskRaw))) : 50;

  const injection = (v.promptInjection ?? {}) as Record<string, unknown>;
  const accuracy = (v.descriptionAccuracy ?? {}) as Record<string, unknown>;
  const coverage = (v.testCoverage ?? {}) as Record<string, unknown>;
  const blast = (v.blastRadius ?? {}) as Record<string, unknown>;

  return {
    verdict,
    confidence: ["low", "medium", "high"].includes(String(v.confidence))
      ? (v.confidence as ReviewResult["confidence"])
      : "medium",
    riskScore,
    oneLiner: str(v.oneLiner, "(no summary returned)"),
    summary: str(v.summary),
    whatChanged: arr(v.whatChanged),
    descriptionAccuracy: {
      matchesCode: bool(accuracy.matchesCode),
      notes: str(accuracy.notes),
    },
    diagrams: arr<ReviewResult["diagrams"][number]>(v.diagrams).filter((d) => d && typeof d.mermaid === "string"),
    dependencyChanges: arr(v.dependencyChanges),
    findings: arr(v.findings),
    securityFlags: arr(v.securityFlags),
    promptInjection: {
      detected: bool(injection.detected),
      detail: str(injection.detail),
    },
    testCoverage: {
      assessment: ["good", "partial", "none", "not_applicable"].includes(String(coverage.assessment))
        ? (coverage.assessment as ReviewResult["testCoverage"]["assessment"])
        : "not_applicable",
      notes: str(coverage.notes),
    },
    blastRadius: {
      scope: str(blast.scope),
      userFacing: bool(blast.userFacing),
      dataMigration: bool(blast.dataMigration),
      apiChange: bool(blast.apiChange),
      breakingChange: bool(blast.breakingChange),
      notes: str(blast.notes),
    },
    checklist: arr(v.checklist),
    suggestedComments: arr<ReviewResult["suggestedComments"][number]>(v.suggestedComments).filter(
      (c) => c && typeof c.file === "string" && Number.isFinite(Number(c.line)),
    ),
    screenshotSuggestions: arr(v.screenshotSuggestions),
  };
}

/**
 * The model's verdict is advisory. Deterministic signals that the model may
 * have been manipulated into ignoring are re-applied here, so an injected PR
 * can never come back as a clean "approve".
 */
function enforceFloor(result: ReviewResult, pr: PrDetail, injectionHits: number): ReviewResult {
  const out = { ...result };

  if (injectionHits > 0 || out.promptInjection.detected) {
    out.promptInjection = {
      detected: true,
      detail:
        out.promptInjection.detail ||
        "The static scanner matched reviewer-manipulation patterns in this PR's text.",
    };
    out.verdict = "block";
    out.riskScore = Math.max(out.riskScore, 85);
    if (!out.securityFlags.some((f) => f.category === "prompt-injection")) {
      out.securityFlags = [
        {
          severity: "critical",
          category: "prompt-injection",
          title: "PR content attempts to manipulate an automated reviewer",
          detail:
            "Text in this pull request matches known prompt-injection patterns. Treat the automated summary as unreliable and review this PR manually.",
        },
        ...out.securityFlags,
      ];
    }
  }

  const worstSeverity = [...out.findings, ...out.securityFlags].some((f) => f.severity === "critical")
    ? "critical"
    : null;
  if (worstSeverity === "critical" && out.verdict === "approve") {
    out.verdict = "needs_attention";
  }
  if (out.securityFlags.length > 0 && out.verdict === "approve") {
    out.verdict = "needs_attention";
  }
  if (pr.diffTruncated && out.confidence === "high") {
    out.confidence = "medium";
  }
  return out;
}

export interface RunReviewOptions {
  mode?: "standard" | "deep";
  model?: string;
  effort?: AppConfig["review"]["effort"];
  onLog?: (line: string) => void;
  /** Called with the review-so-far while the model is still writing. */
  onPartial?: (partial: Partial<ReviewResult>) => void;
}

export async function runReview(
  pr: PrDetail,
  config: AppConfig,
  opts: RunReviewOptions = {},
): Promise<StoredReview> {
  const id = prId(pr.owner, pr.repo, pr.number);
  const mode = opts.mode ?? config.review.mode;
  const provider = resolveProvider(config);
  const model = opts.model ?? (provider === "cursor" ? config.review.cursorModel : config.review.model);
  const effort = opts.effort ?? config.review.effort;
  const log = opts.onLog ?? (() => {});
  const startedAt = Date.now();

  log("Running static pre-scan…");
  const heuristics = analyzeDiff(pr.diff, {
    title: pr.title,
    body: pr.body,
    comments: pr.comments.map((c) => ({ author: c.author.login, body: c.body })),
  });
  log(
    `Pre-scan: ${heuristics.signals.length} signal(s), ${heuristics.injectionSuspects.length} injection suspect(s)`,
  );

  const reviewId = createReview(id, pr.headSha, mode, model);

  // A scratch cwd keeps the CLI from picking up this project's CLAUDE.md,
  // settings or git state as context for the review.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-"));
  let checkoutPath: string | undefined;

  try {
    if (mode === "deep") {
      log("Checking out PR head for deep review…");
      const checkout = await checkoutPr(pr.owner, pr.repo, pr.number, pr.headSha, {
        root: config.screenshots.checkoutRoot,
        onLog: log,
      });
      checkoutPath = checkout.dir;
      log(`Checked out at ${checkout.sha.slice(0, 8)}`);
    }

    const { prompt } = buildReviewPrompt({ pr, heuristics, deepMode: mode === "deep", checkoutPath });
    log(`Prompt built (${Math.round(prompt.length / 1024)} KB). Invoking ${PROVIDER_LABEL[provider]} (${model})…`);

    const args = provider === "cursor" ? cursorArgs(model, mode === "deep" ? checkoutPath : undefined, scratch) : [
      "-p",
      // Streaming so the UI can show the verdict and headline while the rest of
      // the document is still being written.
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--json-schema",
      JSON.stringify(REVIEW_SCHEMA),
      "--system-prompt",
      SYSTEM_PROMPT,
      "--model",
      model,
      "--effort",
      effort,
      "--max-budget-usd",
      String(config.review.maxBudgetUsd),
      // Isolation: no MCP servers, no user/project settings, no slash commands.
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-prompts",
      "none",
      "--restricted",
    ];

    if (provider === "claude") {
      if (mode === "deep" && checkoutPath) {
        // Read-only inspection of the checkout. No Bash, no network, no writes.
        args.push("--tools", "Read,Grep,Glob", "--add-dir", checkoutPath);
      } else {
        args.push("--tools", "");
      }
    }

    const timeoutMs = mode === "deep" ? 15 * 60_000 : 8 * 60_000;

    // Re-parsing the whole buffer on every token would burn CPU for no benefit;
    // the reader cannot perceive faster than a few updates a second.
    let lastEmit = 0;
    let firstSignalAt: number | null = null;

    const input = provider === "cursor" ? cursorPrompt(prompt) : prompt;
    const { text, costUsd } = await runStreaming(provider, args, input, scratch, timeoutMs, (partialText) => {
      const now = Date.now();
      if (now - lastEmit < 400) return;
      lastEmit = now;

      const partial = parsePartialJson<ReviewResult>(partialText);
      if (!partial) return;

      if (!firstSignalAt && partial.verdict) {
        firstSignalAt = now;
        log(`First verdict available after ${Math.round((now - startedAt) / 1000)}s`);
      }
      opts.onPartial?.(partial);
    });

    const parsed = coerceResult(extractJson(text));
    const result = enforceFloor(parsed, pr, heuristics.injectionSuspects.length);

    finishReview(reviewId, {
      status: "done",
      result,
      heuristics,
      costUsd,
      durationMs: Date.now() - startedAt,
    });
    log(`Review complete: ${result.verdict} (risk ${result.riskScore})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Review failed: ${message}`);
    finishReview(reviewId, {
      status: "error",
      error: message,
      heuristics,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const stored = getLatestReview(id, pr.headSha);
  if (!stored) throw new Error("Review record disappeared");
  return stored;
}
