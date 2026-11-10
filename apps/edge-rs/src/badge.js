// The report button on every preview, served by the edge as
// /__whk/badge.js and added to each page the edge passes on (inject.rs).
// It is not an ad: one quiet button, and when opened it says where a
// report goes (webhooks.cc, not the site's owner). It lives in a closed shadow
// root, styled with a constructable stylesheet (not blocked by the page's
// CSP) and built without innerHTML (allowed under Trusted Types), and it
// appears only after the page has loaded, so it never meets hydration.
//
// It also looks at the page once it has run, for what phishing pages have
// (a password or card field, and a brand or lure word in the title), which the
// edge cannot see in a page built in the browser. If both are there it
// tells the edge, once a tab; only those facts leave the page.
(() => {
  if (window.top !== window || document.querySelector("whk-report")) return;
  const REPORT = "__REPORT_URL__";
  const HIDDEN = "whk-report-hidden";
  const FLAGGED = "whk-report-flagged";
  const BRANDS = __BRANDS__;

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
      font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #ecebe5; }
    button { font: inherit; cursor: pointer; border: 0; border-radius: 4px; }
    button:focus-visible, a:focus-visible { outline: 2px solid #7cc7a8; outline-offset: 2px; }
    .open { display: inline-flex; align-items: center; gap: 6px; padding: 7px 10px;
      background: rgba(22, 23, 21, 0.86); color: #ecebe5; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); }
    .open:hover { background: #161715; }
    svg { width: 14px; height: 14px; fill: currentColor; flex: none; }
    .panel { width: min(290px, calc(100vw - 24px)); box-sizing: border-box; padding: 14px;
      border-radius: 6px; background: #161715; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3); }
    .panel p { margin: 0 0 12px; color: #c9c8c2; font-weight: 400; }
    .panel strong { display: block; margin-bottom: 6px; color: #ecebe5; font-size: 14px; font-weight: 600; }
    .row { display: flex; gap: 8px; align-items: center; }
    .go { display: inline-block; padding: 7px 11px; border-radius: 4px; background: #ecebe5;
      color: #161715; text-decoration: none; font-weight: 600; }
    .go:hover { background: #ffffff; }
    .hide { padding: 7px 8px; background: transparent; color: #c9c8c2; }
    .hide:hover { color: #ecebe5; }
  `;

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const child of children)
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    return node;
  };

  const flag = () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      "M42.76,50A8,8,0,0,0,40,56V224a8,8,0,0,0,16,0V179.77c26.79-21.16,49.87-9.75,76.45,3.41,16.4,8.11,34.06,16.85,53,16.85,13.93,0,28.54-4.75,43.82-18a8,8,0,0,0,2.76-6V56A8,8,0,0,0,218.76,50c-28,24.23-51.72,12.49-79.21-1.12C111.07,34.76,78.78,18.79,42.76,50ZM216,172.25c-26.79,21.16-49.87,9.74-76.45-3.41-25-12.35-52.81-26.13-83.55-8.4V59.79c26.79-21.16,49.87-9.75,76.45,3.4,25,12.35,52.82,26.13,83.55,8.4Z"
    );
    svg.append(path);
    return svg;
  };

  const show = () => {
    try {
      if (sessionStorage.getItem(HIDDEN)) return;
    } catch {}
    const host = document.createElement("whk-report");
    const root = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(el("style", {}, CSS));
    }
    const wrap = el("div", { class: "wrap" });
    root.append(wrap);

    const collapsed = () => {
      const button = el(
        "button",
        { class: "open", type: "button", "aria-haspopup": "dialog" },
        "Report"
      );
      button.prepend(flag());
      button.addEventListener("click", expanded);
      wrap.replaceChildren(button);
      return button;
    };

    function expanded() {
      const href = `${REPORT}?url=${encodeURIComponent(location.href)}`;
      const go = el("a", { class: "go", href, target: "_blank", rel: "noopener" }, "Report it");
      const hide = el("button", { class: "hide", type: "button" }, "Hide");
      const panel = el(
        "div",
        { class: "panel", role: "dialog", "aria-label": "Report this page" },
        el("strong", {}, "Report this page"),
        el(
          "p",
          {},
          "Your report goes to webhooks.cc, the service that shares this preview. It does not go to the person who built the site."
        ),
        el("div", { class: "row" }, go, hide)
      );
      hide.addEventListener("click", () => {
        try {
          sessionStorage.setItem(HIDDEN, "1");
        } catch {}
        host.remove();
      });
      panel.addEventListener("keydown", (e) => {
        if (e.key === "Escape") collapsed().focus();
      });
      go.addEventListener("click", () => setTimeout(() => collapsed(), 0));
      wrap.replaceChildren(panel);
      go.focus();
    }

    collapsed();
    (document.body || document.documentElement).append(host);
  };

  // True once the page has been looked at and either reported or not
  // worth reporting for good (flagged already in this tab).
  const look = () => {
    try {
      if (sessionStorage.getItem(FLAGGED)) return true;
    } catch {}
    const title = (document.title || "").toLowerCase();
    const brands = BRANDS.filter((brand) => title.includes(brand));
    const password = !!document.querySelector('input[type="password" i]');
    const card = !!document.querySelector(
      'input[autocomplete~="cc-number" i], input[name="cardnumber" i]'
    );
    if (brands.length === 0 || !(password || card)) return false;
    const body = JSON.stringify({ password, card, brands, url: location.href });
    try {
      navigator.sendBeacon("/__whk/flag", new Blob([body], { type: "text/plain" }));
      sessionStorage.setItem(FLAGGED, "1");
    } catch {}
    return true;
  };

  // A page may draw its form after fetching data, so it is looked at a few
  // times in its first half minute.
  const lookLater = (delays) => {
    if (look() || delays.length === 0) return;
    setTimeout(() => lookLater(delays.slice(1)), delays[0]);
  };

  const later = () => {
    setTimeout(show, 400);
    setTimeout(() => lookLater([2600, 7000, 20000]), 400);
  };
  if (document.readyState === "complete") later();
  else addEventListener("load", later, { once: true });
})();
