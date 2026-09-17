/**
 * Visual style bootstrap and the A/B assignment behind it.
 *
 * The style has to be on <html> before first paint, so it cannot come from a
 * PostHog feature flag: posthog-js resolves flags after load, which would
 * re-skin the page in front of the visitor. The coin flip therefore happens
 * here, in the inline script, and PostHog only analyses the result (see
 * components/providers/posthog-provider.tsx, which reports the variant as
 * $feature/UI_STYLE_FLAG_KEY plus a $feature_flag_called exposure).
 *
 * Only a browser with no trace of an earlier visit joins the split. Anyone who
 * has been here before keeps the classic style and stays out of the experiment.
 */

export type UiStyle = "classic" | "clean";

/** "assigned" means the split chose it, "chosen" means the visitor did. */
export type UiStyleSource = "assigned" | "chosen";

export const UI_STYLE_STORAGE_KEY = "ui-style";
export const UI_STYLE_SOURCE_STORAGE_KEY = "ui-style-source";
/** The variant the split handed out, kept even after the visitor switches away. */
export const UI_STYLE_ASSIGNED_STORAGE_KEY = "ui-style-assigned";
/** PostHog experiment key; its results read $feature/<key> off events. */
export const UI_STYLE_FLAG_KEY = "ui-style";

export interface UiStyleState {
  style: UiStyle;
  source: UiStyleSource | null;
  assigned: UiStyle | null;
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function asStyle(value: string | null): UiStyle | null {
  return value === "classic" || value === "clean" ? value : null;
}

/** Reads what the inline script (and any later switch) left behind. Client only. */
export function readUiStyleState(): UiStyleState {
  const source = readKey(UI_STYLE_SOURCE_STORAGE_KEY);
  return {
    style: asStyle(readKey(UI_STYLE_STORAGE_KEY)) ?? "classic",
    source: source === "assigned" || source === "chosen" ? source : null,
    assigned: asStyle(readKey(UI_STYLE_ASSIGNED_STORAGE_KEY)),
  };
}

/** Records a visitor's own pick, which also takes them out of future splits. */
export function storeChosenUiStyle(style: UiStyle): void {
  try {
    localStorage.setItem(UI_STYLE_STORAGE_KEY, style);
    localStorage.setItem(UI_STYLE_SOURCE_STORAGE_KEY, "chosen");
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

/**
 * Percentage of brand-new visitors the split sends to the clean style.
 * Server-only and read at request time, so changing UI_STYLE_SPLIT on the host
 * takes effect on restart: a NEXT_PUBLIC_ var would be inlined at build time.
 */
export function resolveUiStyleSplit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

/**
 * Source of the script that runs before first paint: dark mode class, then
 * the style, assigning one to brand-new browsers when splitPercent is above 0.
 */
export function appearanceBootstrapScript(splitPercent: number): string {
  const split = Math.min(100, Math.max(0, Math.round(splitPercent) || 0));

  return `(function(){
  var root = document.documentElement;
  try {
    var storedTheme = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (storedTheme === 'dark' || (storedTheme !== 'light' && prefersDark)) root.classList.add('dark');
  } catch (e) {}
  var style = 'classic';
  try {
    var stored = localStorage.getItem('${UI_STYLE_STORAGE_KEY}');
    if (stored === 'clean' || stored === 'classic') {
      style = stored;
    } else if (${split} > 0 && !seenBefore()) {
      style = Math.random() * 100 < ${split} ? 'clean' : 'classic';
      localStorage.setItem('${UI_STYLE_STORAGE_KEY}', style);
      localStorage.setItem('${UI_STYLE_SOURCE_STORAGE_KEY}', 'assigned');
      localStorage.setItem('${UI_STYLE_ASSIGNED_STORAGE_KEY}', style);
    }
  } catch (e) {}
  root.dataset.style = style;

  function seenBefore() {
    if (localStorage.getItem('theme')) return true;
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.indexOf('ph_') === 0 && key.indexOf('_posthog') > 0) return true;
    }
    return document.cookie.indexOf('sb-') !== -1;
  }
})();`;
}
