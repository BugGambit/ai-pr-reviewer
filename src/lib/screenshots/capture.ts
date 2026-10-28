import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SCREENSHOT_DIR } from "../paths";
import { addScreenshot, clearScreenshots } from "../db";
import { checkoutBase, checkoutPr } from "../checkout";
import type { AppConfig, PrDetail, ScreenshotRepoConfig } from "../types";

type Log = (line: string) => void;

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "route";
}

function runCommand(command: string, cwd: string, env: Record<string, string>, log: Log, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    log(`$ ${command}`);
    // The command comes from the user's own repo config, never from PR content.
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`));
    }, timeoutMs);

    let tail = "";
    const collect = (chunk: Buffer) => {
      tail = `${tail}${chunk.toString()}`.slice(-4000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Command exited with ${code}: ${command}\n${tail.slice(-1200)}`));
    });
  });
}

async function waitForServer(url: string, timeoutMs: number, log: Log): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      // Any HTTP answer means the server is listening; 404 on the ready path is
      // still a live server.
      if (res.status > 0) {
        log(`Dev server responded ${res.status} at ${url}`);
        return;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Dev server never became ready at ${url} (${lastError})`);
}

function startDevServer(
  repoConfig: ScreenshotRepoConfig,
  cwd: string,
  port: number,
  log: Log,
): ChildProcess {
  log(`Starting dev server on port ${port}`);
  const child = spawn(repoConfig.dev, {
    cwd,
    shell: true,
    detached: true,
    env: { ...process.env, ...repoConfig.env, PORT: String(port), BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c: Buffer) => {
    const line = c.toString().trim().split("\n").pop();
    if (line) log(`[dev] ${line.slice(0, 180)}`);
  });
  child.stderr?.on("data", (c: Buffer) => {
    const line = c.toString().trim().split("\n").pop();
    if (line) log(`[dev:err] ${line.slice(0, 180)}`);
  });
  return child;
}

function stopDevServer(child: ChildProcess | null, log: Log): void {
  if (!child?.pid) return;
  log("Stopping dev server");
  try {
    // Negative pid kills the whole process group the detached spawn created,
    // so package-manager wrappers don't leave the real server orphaned.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

interface CaptureTarget {
  label: string;
  routePath: string;
  waitFor?: string;
}

async function captureVariant(
  pr: PrDetail,
  repoConfig: ScreenshotRepoConfig,
  checkoutDir: string,
  variant: "base" | "head",
  targets: CaptureTarget[],
  outDir: string,
  log: Log,
): Promise<void> {
  const workDir = repoConfig.cwd ? path.join(checkoutDir, repoConfig.cwd) : checkoutDir;
  if (!fs.existsSync(workDir)) {
    throw new Error(`Configured working directory does not exist in the checkout: ${repoConfig.cwd}`);
  }

  if (repoConfig.setup.trim()) {
    log(`Installing dependencies (${variant})… this can take a while`);
    await runCommand(repoConfig.setup, workDir, repoConfig.env, log, 20 * 60_000);
  }

  const port = variant === "head" ? repoConfig.port : repoConfig.port + 1;
  const server = startDevServer(repoConfig, workDir, port, log);

  try {
    await waitForServer(
      `http://localhost:${port}${repoConfig.readyPath || "/"}`,
      (repoConfig.readyTimeoutSeconds || 180) * 1000,
      log,
    );

    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: repoConfig.viewport ?? { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });

    try {
      for (const target of targets) {
        const page = await context.newPage();
        const url = `http://localhost:${port}${target.routePath}`;
        const file = path.join(outDir, `${variant}-${slug(target.label)}.png`);
        try {
          log(`Capturing ${variant}: ${url}`);
          await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
          if (target.waitFor) {
            await page.waitForSelector(target.waitFor, { timeout: 30_000 }).catch(() => {
              log(`  selector "${target.waitFor}" not found, capturing anyway`);
            });
          }
          await page.waitForTimeout(1200);
          await page.screenshot({ path: file, fullPage: true });
          addScreenshot({
            prId: pr.id,
            headSha: pr.headSha,
            label: target.label,
            route: target.routePath,
            variant,
            path: `/screenshots/${pr.owner}-${pr.repo}-${pr.number}-${pr.headSha.slice(0, 8)}/${path.basename(file)}`,
            status: "ok",
            error: null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`  failed: ${message}`);
          addScreenshot({
            prId: pr.id,
            headSha: pr.headSha,
            label: target.label,
            route: target.routePath,
            variant,
            path: null,
            status: "error",
            error: message.slice(0, 500),
          });
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  } finally {
    stopDevServer(server, log);
  }
}

export async function captureScreenshots(
  pr: PrDetail,
  config: AppConfig,
  opts: { extraRoutes?: { label: string; route: string }[]; log?: Log } = {},
): Promise<{ captured: number; message: string }> {
  const log = opts.log ?? (() => {});
  const key = `${pr.owner}/${pr.repo}`;
  const repoConfig = config.screenshots.repos[key];

  if (!config.screenshots.enabled) {
    throw new Error("Screenshots are disabled. Enable them in Settings.");
  }
  if (!repoConfig?.enabled) {
    throw new Error(
      `No screenshot configuration for ${key}. Add one in Settings → Screenshots (setup command, dev command, port and routes).`,
    );
  }

  const configured: CaptureTarget[] = repoConfig.routes.map((r) => ({
    label: r.label,
    routePath: r.path,
    waitFor: r.waitFor,
  }));

  // Routes Claude suggested are additive and de-duplicated against the
  // configured ones.
  const seen = new Set(configured.map((t) => t.routePath));
  for (const extra of opts.extraRoutes ?? []) {
    if (!extra.route.startsWith("/") || seen.has(extra.route)) continue;
    seen.add(extra.route);
    configured.push({ label: extra.label, routePath: extra.route });
  }

  if (configured.length === 0) {
    throw new Error(`No routes configured for ${key}.`);
  }

  const outDirName = `${pr.owner}-${pr.repo}-${pr.number}-${pr.headSha.slice(0, 8)}`;
  const outDir = path.join(SCREENSHOT_DIR, outDirName);
  fs.mkdirSync(outDir, { recursive: true });
  clearScreenshots(pr.id, pr.headSha);

  log(`Capturing ${configured.length} route(s) for ${key}`);

  log("Checking out PR head…");
  const head = await checkoutPr(pr.owner, pr.repo, pr.number, pr.headSha, {
    root: config.screenshots.checkoutRoot,
    onLog: log,
  });
  await captureVariant(pr, repoConfig, head.dir, "head", configured, outDir, log);

  if (repoConfig.captureBaseline) {
    try {
      log("Checking out base branch for before/after comparison…");
      const base = await checkoutBase(pr.owner, pr.repo, pr.baseRefName, {
        root: config.screenshots.checkoutRoot,
        onLog: log,
      });
      await captureVariant(pr, repoConfig, base.dir, "base", configured, outDir, log);
    } catch (err) {
      log(`Baseline capture failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".png"));
  return { captured: files.length, message: `Captured ${files.length} screenshot(s)` };
}
