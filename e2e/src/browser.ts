// Thin WebDriver factory + generic wait/exec helpers. Chrome via Selenium Manager (auto-downloads the
// matching chromedriver). Headless "new" by default; FGE_HEADLESS=0 for a visible browser while
// debugging. We keep ONE driver for the whole run and reset cart state between scenarios.
import { Builder, WebDriver, logging } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { HEADLESS, NAV_TIMEOUT_MS, PREVIEW_THEME_ID, STORE_ORIGIN, previewUrl } from './config.js';

export async function buildDriver(): Promise<WebDriver> {
  const options = new chrome.Options();
  if (HEADLESS) {
    options.addArguments('--headless=new');
  }
  options.addArguments(
    '--window-size=1280,2200', // tall: the /cart page + chooser fit without scroll for element visibility
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--lang=en-CA',
  );
  // Capture browser console (the widget logs [FGE-*] diagnostics) for failure triage.
  const prefs = new logging.Preferences();
  prefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);
  options.setLoggingPrefs(prefs);

  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
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
