import "server-only";
import { existsSync } from "node:fs";
import type { Browser } from "puppeteer-core";

// Flags @sparticuz/chromium ships with that we must not use while opening
// arbitrary customer websites (they turn off the same-origin policy).
const UNSAFE_ARGS = new Set(["--disable-web-security", "--allow-running-insecure-content"]);
// Extra flags for debugging a deployment, e.g. CRAWL_CHROME_ARGS="--single-process --no-zygote".
const extraArgs = () => (process.env.CRAWL_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean);

// Headless Chromium for the website crawler.
//  - CHROME_PATH set           → that browser (any machine)
//  - Linux / Vercel / Lambda   → @sparticuz/chromium (bundled, serverless-ready)
//  - Windows / macOS (dev)     → the locally installed Chrome or Edge

const LOCAL: Record<string, string[]> = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

export class NoBrowserError extends Error {}

export async function launchBrowser(): Promise<Browser> {
  const puppeteer = (await import("puppeteer-core")).default;
  const common = ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--mute-audio", ...extraArgs()];

  const explicit = process.env.CHROME_PATH;
  if (explicit) return puppeteer.launch({ executablePath: explicit, headless: true, args: common });

  if (process.platform === "linux" && (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || !LOCAL.linux.some(existsSync))) {
    const chromium = (await import("@sparticuz/chromium")).default;
    // As the package documents: its build is chrome-headless-shell, so "shell" mode
    // (true = the "new" headless mode it doesn't support).
    const args = (await puppeteer.defaultArgs({ args: [...chromium.args, ...common], headless: "shell" })).filter((a) => !UNSAFE_ARGS.has(a));
    return puppeteer.launch({
      executablePath: await chromium.executablePath(),
      headless: "shell",
      args,
      defaultViewport: { width: 1366, height: 900 },
    });
  }

  const path = (LOCAL[process.platform] ?? []).find((p) => p && existsSync(p));
  if (!path) throw new NoBrowserError("No Chrome / Edge found for the website check. Install Chrome or set CHROME_PATH.");
  return puppeteer.launch({ executablePath: path, headless: true, args: common, defaultViewport: { width: 1366, height: 900 } });
}
