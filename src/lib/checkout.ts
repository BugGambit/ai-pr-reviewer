import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CHECKOUT_ROOT } from "./paths";

export interface CheckoutResult {
  dir: string;
  sha: string;
}

function git(args: string[], cwd?: string, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        // Delegate auth to the GitHub CLI so no token ever passes through this
        // process or lands in a remote URL.
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "-c",
        "advice.detachedHead=false",
        ...args,
      ],
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${stderr?.trim() || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

/**
 * Materialises a shallow, detached checkout of a PR's head commit. Reuses one
 * directory per repo so repeated reviews only fetch the new ref.
 */
export async function checkoutPr(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  opts: { root?: string; onLog?: (line: string) => void } = {},
): Promise<CheckoutResult> {
  const root = opts.root || DEFAULT_CHECKOUT_ROOT;
  const dir = path.join(root, owner, repo);
  const log = opts.onLog ?? (() => {});

  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(path.join(dir, ".git"))) {
    log(`Initialising checkout at ${dir}`);
    await git(["init", "--quiet", dir]);
    await git(["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`], dir);
  }

  log(`Fetching refs/pull/${number}/head`);
  await git(["fetch", "--depth", "1", "--force", "origin", `refs/pull/${number}/head`], dir);

  log("Checking out PR head");
  await git(["checkout", "--force", "--detach", "FETCH_HEAD"], dir);
  await git(["clean", "-fdx", "-e", "node_modules"], dir).catch(() => "");

  const sha = (await git(["rev-parse", "HEAD"], dir)).trim();
  if (headSha && sha !== headSha) {
    log(`Note: checked out ${sha.slice(0, 8)}, expected ${headSha.slice(0, 8)} (PR may have been updated)`);
  }
  return { dir, sha };
}

/** Checks out the PR's merge base, for before/after screenshot pairs. */
export async function checkoutBase(
  owner: string,
  repo: string,
  baseRef: string,
  opts: { root?: string; onLog?: (line: string) => void } = {},
): Promise<CheckoutResult> {
  const root = opts.root || DEFAULT_CHECKOUT_ROOT;
  const dir = path.join(root, owner, `${repo}__base`);
  const log = opts.onLog ?? (() => {});

  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await git(["init", "--quiet", dir]);
    await git(["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`], dir);
  }

  log(`Fetching base branch ${baseRef}`);
  await git(["fetch", "--depth", "1", "--force", "origin", baseRef], dir);
  await git(["checkout", "--force", "--detach", "FETCH_HEAD"], dir);

  const sha = (await git(["rev-parse", "HEAD"], dir)).trim();
  return { dir, sha };
}
