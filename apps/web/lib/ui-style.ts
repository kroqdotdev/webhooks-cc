/**
 * Visual style bootstrap.
 *
 * Everyone gets the clean style unless they picked the classic one themselves
 * (Account > Appearance). The style has to be on <html> before first paint, so
 * the inline script below reads the browser's choice and applies it, along
 * with dark mode, before React loads.
 *
 * The choice lives in the browser: a visitor who picked classic keeps it on
 * that browser, including after signing out.
 */

export type UiStyle = "classic" | "clean";

export const DEFAULT_UI_STYLE: UiStyle = "clean";

export const UI_STYLE_STORAGE_KEY = "ui-style";
/** "chosen" marks a pick the visitor made; anything else falls back to the default. */
export const UI_STYLE_SOURCE_STORAGE_KEY = "ui-style-source";

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The style the inline script applied (and any later switch). Client only. */
export function readUiStyle(): UiStyle {
  const stored = readKey(UI_STYLE_STORAGE_KEY);
  const chosen = readKey(UI_STYLE_SOURCE_STORAGE_KEY) === "chosen";
  return chosen && (stored === "classic" || stored === "clean") ? stored : DEFAULT_UI_STYLE;
}

/** Records the visitor's own pick. */
export function storeChosenUiStyle(style: UiStyle): void {
  try {
    localStorage.setItem(UI_STYLE_STORAGE_KEY, style);
    localStorage.setItem(UI_STYLE_SOURCE_STORAGE_KEY, "chosen");
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

/**
 * Source of the script that runs before first paint: the dark mode class,
 * then the style. A style stored by the retired A/B split (source "assigned")
 * no longer counts; only a pick the visitor made keeps them on classic.
 */
export function appearanceBootstrapScript(): string {
  return `(function(){
  var root = document.documentElement;
  var storedTheme = null;
  try {
    storedTheme = localStorage.getItem('theme');
  } catch (e) {}
  var prefersDark = false;
  try {
    prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {}
  if (storedTheme === 'dark' || (storedTheme !== 'light' && prefersDark)) root.classList.add('dark');
  var style = '${DEFAULT_UI_STYLE}';
  try {
    var stored = localStorage.getItem('${UI_STYLE_STORAGE_KEY}');
    var chosen = localStorage.getItem('${UI_STYLE_SOURCE_STORAGE_KEY}') === 'chosen';
    if (chosen && (stored === 'clean' || stored === 'classic')) style = stored;
  } catch (e) {}
  root.dataset.style = style;
})();`;
}
