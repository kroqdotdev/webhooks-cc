/**
 * Where the "Skip to content" link (app/layout.tsx) lands: right after the
 * site header, or at the top of a page shown before its header can render
 * (a sign-in check still loading, the two-factor step). Render it once per
 * page.
 */
export const SKIP_TARGET_ID = "main-content";

export function SkipTarget() {
  return <div id={SKIP_TARGET_ID} tabIndex={-1} className="outline-none" />;
}
