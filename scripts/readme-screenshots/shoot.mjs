// Captures the README screenshots from a running dev server while answering
// every /api request inside the browser with fictional data (fixtures.mjs), so
// no real GitHub data, reviews or local state can appear in them.
//
//   pnpm dev                                   # in another terminal
//   node scripts/readme-screenshots/shoot.mjs  # [only=queue|review|...]
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { respond } from "./fixtures.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:4800";
const OUT = fileURLToPath(new URL("../../docs/screenshots", import.meta.url));
const only = process.argv[2];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1360, height: 860 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

// Same-origin only: page assets pass through, every API call is answered here,
// and anything else (third-party hosts, media) is blocked outright.
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== BASE) return route.abort();
  if (!url.pathname.startsWith("/api/")) return route.continue();
  const body = respond(route.request().method(), url.pathname);
  if (body === null) return route.fulfill({ status: 404, json: { error: "not found" } });
  return route.fulfill({ status: 200, json: body });
});

// Hide the Next.js dev-mode badge.
await context.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal { display: none !important; }";
    document.head.appendChild(style);
  });
});

const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

async function settle() {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(1200);
}

const shots = {
  async queue() {
    await page.goto(`${BASE}/`);
    await settle();
    await page.screenshot({ path: `${OUT}/queue.png` });
  },
  async review() {
    await page.goto(`${BASE}/pr/acme/api/1290`);
    await settle();
    await page.waitForTimeout(1500); // mermaid
    await page.screenshot({ path: `${OUT}/review.png`, fullPage: true, clip: { x: 0, y: 0, width: 1360, height: 1490 } });
    await page.screenshot({ path: `${OUT}/findings.png`, fullPage: true, clip: { x: 0, y: 1535, width: 1360, height: 780 } });
  },
  async blocked() {
    await page.goto(`${BASE}/pr/acme/platform/4417`);
    await settle();
    await page.screenshot({ path: `${OUT}/blocked.png`, fullPage: true, clip: { x: 0, y: 0, width: 1360, height: 935 } });
  },
  async stack() {
    await page.goto(`${BASE}/pr/acme/api/1287`);
    await settle();
    await page.screenshot({ path: `${OUT}/stack.png`, fullPage: true, clip: { x: 0, y: 0, width: 1360, height: 740 } });
  },
  async bell() {
    await page.goto(`${BASE}/`);
    await settle();
    await page.getByRole("button", { name: "Notifications" }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/notifications.png` });
  },
};

for (const [name, fn] of Object.entries(shots)) {
  if (only && only !== name) continue;
  try {
    await fn();
    console.log("ok", name);
  } catch (err) {
    console.log("FAIL", name, err.message.split("\n")[0]);
  }
}
await browser.close();
