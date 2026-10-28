import path from "node:path";
import fs from "node:fs";

export const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const DB_PATH = path.join(DATA_DIR, "pr-reviewer.db");
export const SCREENSHOT_DIR = path.join(PROJECT_ROOT, "public", "screenshots");
export const DEFAULT_CHECKOUT_ROOT = path.join(DATA_DIR, "checkouts");

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, SCREENSHOT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
