/** The request inspector as one HTML document, built from app/. */
export function buildInspectorHtml(): Promise<string>;

/** The generated module's exports for `html`. */
export function inspectorExports(html: string): { html: string; hash: string };
