// Thin WebDriver factory + generic wait/exec helpers. Chrome via Selenium Manager (auto-downloads the
// matching chromedriver). Runs HEADFUL by default (a real fingerprint the live store's bot detection
// doesn't throttle); FGE_HEADLESS=1 for headless. Either way we mask automation signals + persist a
// browser profile so the session looks like a returning shopper. One driver per run; cart reset between
// scenarios.
import path from 'node:path';
import fs from 'node:fs';
import { Builder, WebDriver, logging } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { HEADLESS, NAV_TIMEOUT_MS, PREVIEW_THEME_ID, STORE_ORIGIN, previewUrl } from './config.js';

// A genuine desktop-Chrome UA (no "HeadlessChrome" token) for the headless path.
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// OPTIONAL persistent profile (set FGE_PROFILE_DIR to reuse cookies/session across runs). Off by
// default: Selenium then manages a fresh temp profile per run, which avoids the profile-corruption /
// "Something went wrong when opening your profile" and stale-lock issues that force-kills cause. Bot
// detection is defeated by the headful fingerprint + webdriver mask below, not by persisted cookies.
const PROFILE_DIR = process.env['FGE_PROFILE_DIR'];

// Minimal chromium CDP surface we use (not on the base WebDriver type).
type CdpDriver = WebDriver & {
  sendDevToolsCommand(cmd: string, params: Record<string, unknown>): Promise<void>;
};

// A force-killed Chrome leaves Singleton* lock files in a persistent profile that make the next launch
// fail with "Chrome instance exited". Clear them before launching so opt-in profile runs self-heal.
function clearProfileLocks(dir: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // best-effort
    }
  }
}

export async function buildDriver(): Promise<WebDriver> {
  const options = new chrome.Options();
  if (HEADLESS) {
    options.addArguments('--headless=new');
    options.addArguments(`--user-agent=${REAL_UA}`); // drop the tell-tale HeadlessChrome token
  }
  options.addArguments(
    '--window-size=1280,2200', // tall: the /cart page + chooser fit without scroll for element visibility
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--lang=en-CA',
    '--disable-blink-features=AutomationControlled', // removes the navigator.webdriver automation banner
  );
  if (PROFILE_DIR !== undefined && PROFILE_DIR.length > 0) {
    clearProfileLocks(PROFILE_DIR);
    options.addArguments(`--user-data-dir=${PROFILE_DIR}`);
  }
  // Strip the "Chrome is being controlled by automated test software" switch/extension.
  options.excludeSwitches('enable-automation');
  // Capture browser console (the widget logs [FGE-*] diagnostics) for failure triage.
  const prefs = new logging.Preferences();
  prefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);
  options.setLoggingPrefs(prefs);

  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  // Belt-and-suspenders: mask the remaining automation fingerprints before any page script runs.
  try {
    await (driver as CdpDriver).sendDevToolsCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-CA', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = window.chrome || { runtime: {} };
      `,
    });
  } catch {
    // CDP unavailable on this driver build; the launch flags above already remove the main tells.
  }
  await driver.manage().setTimeouts({ pageLoad: NAV_TIMEOUT_MS, script: NAV_TIMEOUT_MS });
  return driver;
}

// Establish the preview session (sets the preview cookie + sticks the unpublished theme) then land on
// `path`. Safe to call repeatedly; the cookie persists for the browser session.
export async function gotoPreview(driver: WebDriver, path = '/'): Promise<void> {
  await driver.get(previewUrl(path));
  // First navigation may 302 to strip preview_theme_id after setting the cookie; ensure we end up on
  // the intended path in the preview session.
  const url = await driver.getCurrentUrl();
  if (!url.includes(path === '/' ? STORE_ORIGIN : path)) {
    await driver.get(previewUrl(path));
  }
}

export class TimeoutError extends Error {}

// Poll an async predicate until it returns a truthy value or the deadline passes. Returns the value.
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs, intervalMs = 400, label }: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      throw new TimeoutError(`waitFor timed out: ${label} (last=${JSON.stringify(last)})`);
    }
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Run an async function body in the page and get its resolved JSON value back. `body` MUST end by
// resolving; we wrap it in an async IIFE and hand its promise to Selenium's async-script callback.
export async function evalAsync<T>(
  driver: WebDriver,
  body: string,
  ...args: unknown[]
): Promise<T> {
  const script = `
    const __cb = arguments[arguments.length - 1];
    const __args = Array.prototype.slice.call(arguments, 0, arguments.length - 1);
    (async () => { ${body} })().then(
      (v) => __cb({ ok: true, value: v }),
      (e) => __cb({ ok: false, error: String(e && e.stack || e) }),
    );
  `;
  const res = (await driver.executeAsyncScript(script, ...args)) as
    | { ok: true; value: T }
    | { ok: false; error: string };
  if (!res.ok) throw new Error(`page-eval failed: ${res.error}`);
  return res.value;
}

export async function dumpConsole(driver: WebDriver, max = 40): Promise<string[]> {
  try {
    const entries = await driver.manage().logs().get(logging.Type.BROWSER);
    return entries.slice(-max).map((e) => `[${e.level.name}] ${e.message}`);
  } catch {
    return [];
  }
}

export { PREVIEW_THEME_ID };
