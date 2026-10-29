/**
 * Keeps a machine-translated page alive. Chrome's built-in translator (Google
 * Translate, the usual one on Android) adds `translated-ltr` or
 * `translated-rtl` to `<html>`, then detaches the page's text nodes and puts
 * `<font>` elements holding the translation where they were. React still
 * holds the originals, so the next time it removes one, or inserts next to
 * one, the browser throws NotFoundError and an error boundary replaces the
 * page (facebook/react#11538). A page translated before it hydrated also
 * fails hydration (React #418) and is rendered again on the client.
 *
 * Once the page shows signs of translation, `removeChild` and `insertBefore`
 * tolerate a node that is no longer where React left it instead of throwing.
 * Elsewhere they behave exactly as before, so a real bug still surfaces.
 * Text React updates after translation stays in the detached node, so a
 * translated page can show stale words, but it no longer breaks.
 */

const TRANSLATED_CLASS = /\btranslated-(ltr|rtl)\b/;

// Sticky: a render after a failed hydration resets the attributes of <html>
// and empties <body>, which takes the translator's traces with it.
let translated = false;

/** True once the page has been machine translated. */
export function pageWasTranslated(): boolean {
  if (translated || typeof document === "undefined") return translated;
  // The app never renders <font>; the translator puts one where each text it replaced was.
  translated =
    TRANSLATED_CLASS.test(document.documentElement?.className ?? "") ||
    document.querySelector("font") !== null;
  return translated;
}

/** Notes the translator's class on <html>, which it sets before it touches any text. */
function watchForTranslation(): void {
  if (pageWasTranslated() || typeof MutationObserver === "undefined") return;
  const html = document.documentElement;
  const observer = new MutationObserver(() => {
    if (!TRANSLATED_CLASS.test(html.className)) return;
    translated = true;
    observer.disconnect();
  });
  observer.observe(html, { attributes: true, attributeFilter: ["class"] });
}

/** Lets `removeChild` and `insertBefore` survive nodes a translator moved or replaced. */
export function guardDomMutations(proto: Node): void {
  const { removeChild, insertBefore } = proto;

  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child && child.parentNode !== this && pageWasTranslated()) {
      // Wrapped inside this node: take it out of the wrapper. Detached: already gone.
      if (child.parentNode && this.contains(child)) child.parentNode.removeChild(child);
      return child;
    }
    return removeChild.call(this, child) as T;
  };

  proto.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
    if (child && child.parentNode !== this && pageWasTranslated()) {
      // Before the child of this node that now holds the reference, or last if it is gone.
      let anchor: Node = child;
      while (anchor.parentNode && anchor.parentNode !== this) anchor = anchor.parentNode;
      return insertBefore.call(this, node, anchor.parentNode === this ? anchor : null) as T;
    }
    return insertBefore.call(this, node, child) as T;
  };
}

/** Started from `instrumentation-client.ts`, before React hydrates. */
export function startTranslationGuard(): void {
  if (typeof window === "undefined" || typeof Node === "undefined") return;
  watchForTranslation();
  guardDomMutations(Node.prototype);
}
