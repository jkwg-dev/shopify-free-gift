// Lightweight, gated debug logger for live storefront diagnosis. OFF by default so it never spams a
// real shopper's console. Enable at runtime (no redeploy) with either:
//   localStorage.setItem('fge_debug', '1')   // persists across reloads
//   window.FGE_DEBUG = true                    // this tab only
// then reconcile again. Every line is prefixed [FGE] so it is easy to filter in DevTools.
export function fgeDebugEnabled(): boolean {
  try {
    if (typeof window !== 'undefined' && (window as { FGE_DEBUG?: boolean }).FGE_DEBUG === true) {
      return true;
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem('fge_debug') === '1') {
      return true;
    }
  } catch {
    // localStorage can throw (privacy mode) — treat as disabled.
  }
  return false;
}

export function fgeLog(...args: readonly unknown[]): void {
  if (fgeDebugEnabled()) {
    console.log('[FGE]', ...args);
  }
}
