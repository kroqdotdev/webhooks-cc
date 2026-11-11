/**
 * Dark mode bootstrap.
 *
 * Light or dark has to be on <html> before first paint, so the inline script
 * below reads the browser's choice (Account > Appearance, kept in
 * localStorage) or the system preference and applies it before React loads.
 */

export const THEME_STORAGE_KEY = "theme";

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
