<div align="center">

# AI PR Reviewer

### Can I approve this without reading every line?

**A local review cockpit that tells you what a pull request _actually_ does — not what its
description claims — and whether it's safe to approve.**

Powered by your existing `gh` and `claude` CLI sessions. Runs on your machine: no hosted service, no tokens to paste, no telemetry.

[Quick start](#quick-start) · [What you get](#what-you-get) · [How it works](#how-it-works) ·
[Security model](#treating-pr-content-as-hostile) · [Configuration](#configuration)

</div>

---

You're a code owner on a dozen repos. Forty PRs are waiting. Most of them are boring and
deserve a fast "yes". A few deserve real attention, and one of them quietly adds a
`pull_request_target` workflow. Reading every diff top to bottom doesn't scale, and skimming is
how the dangerous one gets through.

**AI PR Reviewer** turns that queue into a triage problem:

<p align="center">
  <img src="docs/screenshots/queue.png" alt="The review queue: PRs ranked by how much they wait on you, each with an AI risk verdict" width="100%">
</p>

Open any PR and within seconds you get a verdict, a risk score from 0 to 100, a plain-language
summary of the change, Mermaid diagrams of the new control flow, and a list of everything that
looked off. When it's fine, one click runs your team's whole approval ritual: approve, assign,
relabel, comment.

<p align="center">
  <img src="docs/screenshots/review.png" alt="A review that catches a PR description claiming 'no behaviour change' while the code throttles every tenant" width="100%">
</p>

<p align="center"><sub>The description says <i>"no behaviour change for existing tenants"</i>. The code says otherwise, and the review says so first.</sub></p>

## Why this exists

PR descriptions are claims written by an interested party. The diff is ground truth. Most review
tools summarise the description back at you. This one reads the code and **tells you when the two
disagree**, which in practice is the single most useful signal for deciding whether a PR needs a
careful read.

It is built for the reviewer who is *not* going to read every line, and wants to know exactly
which PRs they *do* have to read.

## What you get

### A ranked queue, not a chronological one

- **Ranked by how much each PR is waiting on *you***: review explicitly requested, age, time
  since anyone touched it, size, and whether it has already been judged low-risk. The PR that has
  sat untouched for three weeks outranks the one that landed this morning.
- **Sections that match how you think**: *Needs you*, *Blocked* (failing CI or conflicts, the
  author's move), *You approved*, and *Snoozed & ignored*.
- **Stacked PR detection.** GitHub records no relationship between stacked PRs; this tool rebuilds
  the chain from base/head branches. Since stacks merge bottom-up, the bottom PR gets boosted
  ("unblocks 3 stacked PRs") and the ones above it are pushed down.
<p align="center">
  <img src="docs/screenshots/stack.png" alt="A stacked PR, showing which PRs below it must merge first" width="85%">
</p>

- **Snooze, ignore, mute**, all with keyboard shortcuts and undo. A snooze lapses early the moment
  the author pushes, because whatever you were waiting for probably just happened.

```
j / k   move      enter  open      s  snooze a day    e  ignore
u       undo      r      refresh   /  filter
```

### An AI risk review on every PR

| | |
|---|---|
| **Verdict** | `Good to go` · `Needs attention` · `Do not approve`, plus a 0–100 risk score |
| **Summary** | What the change does architecturally, derived from the code |
| **Honesty check** | Does the description match the diff? Called out separately |
| **Diagrams** | 1–3 Mermaid diagrams of new control flow, sequences or schema |
| **Findings** | Security concerns and issues, severity-rated, each one-click attachable as a review comment |
| **Context** | Blast radius, dependency changes, test coverage, and a fixed 10-point risk checklist |

<p align="center">
  <img src="docs/screenshots/findings.png" alt="Security concerns and findings, each with a suggested fix and a one-click review comment" width="85%">
</p>

Reviews **stream**: the verdict lands in about 10 seconds while the diagrams and checklist are
still being written. They're **cached per commit**, so a PR costs one review until the author
pushes again. Optional **prefetch** reviews the top of your queue in the background, so opening a
PR shows the verdict instantly.

### Deterministic checks the model can't talk its way out of

About 25 local rules run before the model ever sees the PR: committed secrets,
`pull_request_target`, `curl | sh`, unpinned actions, disabled TLS verification, unsafe
deserialization, removed auth guards, destructive migrations, and more. Their results are passed
to the model as leads to confirm or dismiss, and shown to you separately either way.

And if a PR tries to talk the AI into approving it, the tool notices, and the verdict is pinned to
*Do not approve* no matter what the model says:

<p align="center">
  <img src="docs/screenshots/blocked.png" alt="A PR blocked for a pull_request_target workflow and a hidden HTML comment instructing AI reviewers to approve" width="85%">
</p>

### One-click approval, your way

Many teams have an approval ritual: approve, assign yourself, swap a label, leave a comment, wait
for the merge gate. Configure it once, and **Risk-approve** runs it:

1. Approve the PR
2. Assign yourself
3. Add and remove labels in **one** GitHub call (e.g. add `reviewed`, remove `needs-review`, only
   if present)
4. Post a comment
5. Watch the merge-gate check (e.g. a policy bot) until it reports, and tell you whether the PR is
   actually mergeable

Each step runs independently and reports its own result, so a missing label never blocks the
approval itself. You can also request changes with inline comments and ` ```suggestion ` blocks,
straight from the diff view: **double-click any line** to comment.

### Notifications that explain themselves

A bell in the header, plus optional desktop notifications that open the PR when clicked, for:

- new PRs matching your filters
- review requests, @-mentions and replies
- **your own PRs**: approved, changes requested, or CI broke

GitHub notifies every member of a team that's requested or @-mentioned. With a handful of teams
that's mostly noise, so **team pings only notify when the PR matches your filters**. Anything
addressed to you personally always gets through. Every review request is annotated *"via team
platform-team"* so you're never left wondering why you got pinged.

<p align="center">
  <img src="docs/screenshots/notifications.png" alt="The notification panel" width="85%">
</p>

### Visual proof

For frontend repos, give the tool a recipe (setup command, dev-server command, port, routes) and it
checks out the PR, boots the app and captures screenshots with Playwright, with optional
before/after pairs against the base branch. Routes the AI flagged as affected are captured too.

## Quick start

**Prerequisites**

- Node.js 22+ and [pnpm](https://pnpm.io)
- [GitHub CLI](https://cli.github.com), authenticated: `gh auth login --scopes repo,read:org`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), logged in (`claude` on your `PATH`),
  **or** the [Cursor CLI](https://cursor.com/cli), logged in (`agent login`). With the default
  *Auto* setting, `claude` is used when present and Cursor's `agent` otherwise; pick a Cursor
  model in **Settings** (`agent models` lists them). The per-review spend cap and prefetch budget
  only apply to Claude, since the Cursor CLI reports no cost.

```bash
git clone https://github.com/BugGambit/ai-pr-reviewer.git
cd ai-pr-reviewer
pnpm install
pnpm dev                     # → http://localhost:4800
```

Then open **Settings**:

1. Set your **GitHub organisation** (optional, but it enables team filters and `repo#123`
   shorthand).
2. Add a **filter**: which repos, authors, teams or paths you review.
3. Optionally configure your **approval sequence** and **notifications**.

That's it. Your queue fills in on the next refresh.

> **Screenshots (optional).** Run `pnpm setup:screenshots` once to install Playwright's Chromium.

### Dev container

With Docker and the VS Code **Dev Containers** extension installed, open this repository
and select **Dev Containers: Reopen in Container**. The container includes Node.js 22,
pnpm, GitHub CLI, and Claude Code, and installs project dependencies automatically.

Inside the container, authenticate with `gh auth login --scopes repo,read:org` and
launch `claude` to log in. Run `pnpm dev` to start the app; port **4800** is forwarded
to your machine. Claude's `.claude` directory and GitHub CLI configuration use named volumes.

## How it works

```mermaid
flowchart LR
    GH["GitHub<br/>via gh CLI"] --> Q["Ranked queue<br/>filters, stacks, attention"]
    Q --> D["PR detail"]
    D --> H["Local pre-scan<br/>~25 risk rules + injection checks"]
    D --> T["Trimmed diff + metadata<br/>fenced as untrusted"]
    H --> C["claude CLI<br/>sandboxed, no tools"]
    T --> C
    C --> R["Streamed review<br/>verdict, diagrams, findings"]
    H --> F["Verdict floor"]
    R --> F
    F --> UI["You"]
    UI -->|"Risk-approve"| GH
```

- **GitHub access** goes through `gh`, so it uses whatever account and permissions you already
  have. Nothing is stored except a local cache.
- **The review** runs through the `claude` CLI with a strict JSON schema. Lockfiles, generated code
  and binaries keep their filenames but lose their contents before reaching the model.
- **Standard mode** sends the diff and PR metadata only (~20–40 s, roughly $0.10–0.25 per review).
  **Deep mode** also shallow-clones the PR so the model can read surrounding code, which is slower
  and pricier but answers questions a diff can't.
- **Everything is local**: a SQLite database and a JSON config under `data/`.

### Choosing a model

The defaults are `sonnet` at `high` effort, chosen by benchmarking the same PR across settings:

| model / effort | wall time | caught description/code mismatch | diagrams | findings |
|---|---|---|---|---|
| opus / high | 157 s | yes | 1 | 4 |
| **sonnet / high** | **40 s** | **yes** | **1** | **6** |
| sonnet / medium | 19 s | no | 0 | 1 |
| sonnet / low | 18 s | no | 0 | 1 |

**Lowering effort is what costs quality**, not using a smaller model: at medium and low effort,
the model stopped noticing when the description didn't match the code, which is the main thing
this tool exists to tell you.

## Treating PR content as hostile

A PR author controls the title, description, comments, commit messages, filenames and diff, and
all of it reaches the model. The tool assumes they may be trying to manipulate it.

- **Fenced input.** Untrusted content is wrapped in delimiters with a per-run random nonce, and
  any attempt to forge them is stripped. The system prompt states that fenced content is data,
  never instruction.
- **Deterministic pre-scan.** Instruction overrides, role reassignment, delimiter spoofing, hidden
  HTML comments, zero-width and bidi Unicode, and exfiltration phrasing are detected locally,
  independent of the model.
- **A verdict floor.** If the scanner found a manipulation attempt, the verdict is forced to
  *Do not approve*, whatever the model concluded. A PR cannot talk its way to "approve".
- **A sandboxed model.** Standard mode runs with no tools at all. Deep mode gets read-only
  `Read`/`Grep`/`Glob` confined to the checkout: no shell, no network, no writes. MCP servers,
  user settings and slash commands are disabled for the run.
- **Sanitised rendering.** PR HTML is re-sanitised, and inline `style` is stripped too, since
  `display:none` is how you'd hide text from a human while leaving it for the model.
- **A careful media proxy.** Images and videos in PR descriptions stream through a local proxy
  that adds GitHub auth only for GitHub's own hosts, serves only media types, re-checks every
  redirect hop, and refuses to resolve private or loopback addresses, so untrusted PR text can't
  turn it into a probe of your network.

## Configuration

Everything lives in **Settings** and is saved to `data/config.json`.

<details>
<summary><b>Filters</b>: which PRs show up in your queue</summary>

Each filter has a **scope** (specific repositories, or your whole organisation) and **criteria**
that are OR'd within it:

| Criterion | Matches |
|---|---|
| **Authors** | PRs opened by any of these users |
| **Teams** | PRs where one of these teams is requested for review (i.e. is a code owner) |
| **Paths** | PRs touching e.g. `apps/web/**` in a given repo (a bare folder implies `/**`) |
| *(none)* | Everything in scope, only allowed when repos, labels or "review requested" narrow it |

Required labels, excluded authors, drafts and "only where my review is requested" are AND'd on
top. To review a PR no filter matches, paste its URL (or `repo#123`) into the header.

</details>

<details>
<summary><b>Approval sequence</b></summary>

| Setting | Example |
|---|---|
| Approve on GitHub | on |
| Assign yourself | on |
| Labels to add | `reviewed` |
| Labels to remove (when present) | `needs-review` |
| Comment to post | `LGTM, low risk` |
| Merge-gate check | `policy-bot` (any substring of a check name) |

Leave any of them empty to skip that step.

</details>

<details>
<summary><b>Claude review</b></summary>

Model, effort, standard or deep mode, max diff size, a per-review spend cap, auto-review on open,
and background prefetch with its own daily budget.

</details>

<details>
<summary><b>Notifications</b></summary>

Poll interval, desktop notifications, and toggles for each kind of event. Your teams are listed so
you can mute the noisy ones. Muted teams still appear in your queue; they just stop pinging.

</details>

<details>
<summary><b>Screenshots</b></summary>

Per repository: working directory, setup command, dev-server command, port, and routes to visit
(optionally with a CSS selector to wait for). Enable *capture baseline* for before/after pairs.

</details>

## Your data

```
data/config.json         your settings
data/pr-reviewer.db      SQLite: cached PRs, reviews, notifications, action log
data/checkouts/          shallow clones for deep review and screenshots
public/screenshots/      captured images
```

All of it is gitignored. Nothing leaves your machine except calls to GitHub (through `gh`) and to
Anthropic (through `claude`). To reset, delete `data/`.

## FAQ

**Does it approve PRs on its own?** No. It never acts without a click from you. The AI produces a
recommendation; you decide.

**Does it need a GitHub token or an Anthropic API key?** No. It shells out to `gh` and `claude`
and inherits their logins. Whatever `claude` is billed against (subscription or API key) is what
reviews cost.

**Does it work outside an organisation?** Yes. Leave the organisation empty and filter by
explicit repositories and authors.

**Can a malicious PR trick it into saying "approve"?** It's designed not to, see the
[security model](#treating-pr-content-as-hostile), and the deterministic checks and verdict floor
don't depend on the model at all. Still, treat the verdict as a strong hint, not a guarantee.

## Tech

Next.js 15 · React 19 · TypeScript · SQLite (`better-sqlite3`) · Mermaid · Playwright · `gh` ·
`claude`

```bash
pnpm dev                  # dev server on :4800
pnpm build                # production build
pnpm typecheck            # tsc --noEmit
pnpm screenshots:readme   # regenerate docs/screenshots (needs pnpm dev running)
```

The README screenshots use entirely fictional data: `scripts/readme-screenshots` answers every
API call in the browser from a fixture file, so no real repository, person or review is shown.

## License

[MIT](LICENSE)
