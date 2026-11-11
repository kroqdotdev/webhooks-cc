/**
 * Dark mode bootstrap.
 *
 * Light or dark has to be on <html> before first paint, so the inline script
 * below reads the browser's choice (Account > Appearance, kept in
 * localStorage) or the system preference and applies it before React loads.
 */

export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "theme";

/**
 * The stored choice, read the way the bootstrap script reads it: anything
 * other than light or dark (nothing stored, blocked storage) follows the system.
 */
export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Source of the script that sets the dark mode class before first paint. */
export function themeBootstrapScript(): string {
  return `(function(){
  var storedTheme = null;
  try {
    storedTheme = localStorage.getItem('${THEME_STORAGE_KEY}');
  } catch (e) {}
  var prefersDark = false;
  try {
    prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {}
  if (storedTheme === 'dark' || (storedTheme !== 'light' && prefersDark)) document.documentElement.classList.add('dark');
})();`;
}
