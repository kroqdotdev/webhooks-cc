import type { Options } from "rehype-pretty-code";
import type { ThemeRegistrationRaw } from "shiki";
import { createCssVariablesTheme } from "shiki/core";

/**
 * How docs and blog code blocks are highlighted (rehype-pretty-code, which
 * runs Shiki at build time). The theme names CSS variables instead of
 * colours; app/globals.css points them at the same palette as the
 * dashboard's Prism highlighting (`--syntax-*`), so all code on the site
 * reads alike and follows light and dark mode without a second theme.
 */
const generated = createCssVariablesTheme({
  name: "webhooks-cc",
  variablePrefix: "--code-",
  fontStyle: true,
});
// rehype-pretty-code's type wants the rules as `settings`; a generated theme
// keeps them in `tokenColors`, which Shiki reads only when `settings` is absent.
const theme: ThemeRegistrationRaw = {
  ...generated,
  settings: generated.settings ?? generated.tokenColors ?? [],
};

export const prettyCodeOptions: Options = {
  theme,
  keepBackground: false,
};
