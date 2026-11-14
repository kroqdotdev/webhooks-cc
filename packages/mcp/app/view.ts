import { append, button, bytes, el, type Child } from "./dom";
import { jsonTree } from "./json-tree";
import type { Address, EmailView, HttpView, RecentItem, View } from "./model";

/** What the views may do, from the host's capabilities. */
export interface Abilities {
  /** The host granted the clipboard: Copy buttons appear. */
  copy: boolean;
  /** The host opens links on request: Open buttons appear. */
  openLink: ((url: string) => Promise<void>) | null;
  locale: string | undefined;
  timeZone: string | undefined;
}

/** The longest body the page draws; the rest is left out with a note. */
const MAX_BODY_CHARS = 200_000;

/** Headers whose values are secrets: shown masked until revealed. */
const SENSITIVE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token)$|secret|password|token/i;

export function formatTime(ms: number | null, abilities: Abilities): string | null {
  if (ms === null) return null;
  const date = new Date(ms);
  try {
    return new Intl.DateTimeFormat(abilities.locale, {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: abilities.timeZone,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function relativeTime(ms: number | null, now = Date.now()): string {
  if (ms === null) return "";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A Copy button, or nothing when the host gave no clipboard. */
function copyButton(
  abilities: Abilities,
  text: () => string,
  label = "Copy"
): HTMLButtonElement | null {
  if (!abilities.copy) return null;
  const control = button(label, async () => {
    try {
      await navigator.clipboard.writeText(text());
      control.textContent = "Copied";
    } catch {
      control.textContent = "Copy failed";
    }
    window.setTimeout(() => {
      control.textContent = label;
    }, 1600);
  });
  return control;
}

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** An Open button for an http(s) link, when the host opens links; never opened on its own. */
function openButton(abilities: Abilities, url: string): HTMLButtonElement | null {
  const open = abilities.openLink;
  if (!open || !isWebUrl(url)) return null;
  const control = button("Open", async () => {
    try {
      await open(url);
    } catch {
      control.textContent = "Not opened";
    }
  });
  return control;
}

function section(title: string, aside: Child[], ...body: Child[]): HTMLElement {
  return el(
    "section",
    { class: "sec" },
    el(
      "div",
      { class: "sec-head" },
      el("h2", null, title),
      el("div", { class: "sec-aside" }, ...aside)
    ),
    ...body
  );
}

function chip(text: Child, tone: "ok" | "bad" | "plain" = "plain", title?: string): HTMLElement {
  return el("span", { class: `chip chip-${tone}`, title }, text);
}

function note(text: Child): HTMLElement {
  return el("p", { class: "note" }, text);
}

function headersTable(headers: [string, string][], abilities: Abilities): HTMLElement {
  const rows = headers.map(([name, value]) => {
    const secret = SENSITIVE.test(name);
    const shown = el(
      "span",
      { class: "hv-text" },
      secret ? "•".repeat(Math.min(12, Math.max(6, value.length))) : value
    );
    const controls: Child[] = [];
    if (secret) {
      let revealed = false;
      const toggle = button(
        "Reveal",
        () => {
          revealed = !revealed;
          shown.textContent = revealed
            ? value
            : "•".repeat(Math.min(12, Math.max(6, value.length)));
          toggle.textContent = revealed ? "Hide" : "Reveal";
          toggle.setAttribute("aria-pressed", String(revealed));
        },
        "btn btn-quiet"
      );
      toggle.setAttribute("aria-pressed", "false");
      controls.push(toggle);
    }
    controls.push(copyButton(abilities, () => value));
    return el(
      "tr",
      null,
      el("th", { attrs: { scope: "row" } }, name),
      el(
        "td",
        null,
        el("div", { class: "hv" }, shown, el("span", { class: "hv-tools" }, ...controls))
      )
    );
  });
  return el(
    "div",
    { class: "table-wrap" },
    el("table", { class: "kv" }, el("tbody", null, ...rows))
  );
}

/** The body: pretty JSON with folding, or the text as received. */
function bodySection(view: HttpView, abilities: Abilities): HTMLElement | null {
  if (view.bodyBinary && !view.body) {
    return section(
      "Body",
      [],
      note(`Binary body (${bytes(view.size) ?? "unknown size"}), not shown here.`)
    );
  }
  const body = view.body;
  if (body === null || body === "") {
    return section("Body", [], note("No body."));
  }
  const cut = body.length > MAX_BODY_CHARS;
  const text = cut ? body.slice(0, MAX_BODY_CHARS) : body;
  let parsed: unknown;
  let json = false;
  if (!cut) {
    try {
      parsed = JSON.parse(text);
      json = typeof parsed === "object" && parsed !== null;
    } catch {
      json = false;
    }
  }
  const tree = json ? jsonTree(parsed) : null;
  const raw = el("pre", { class: "code raw" }, json ? JSON.stringify(parsed, null, 2) : text);
  const frame = el("div", { class: "code-frame" });
  const aside: Child[] = [];
  if (tree) {
    const pretty = button("Pretty", () => show("pretty"), "seg");
    const plain = button("Raw", () => show("raw"), "seg");
    const show = (mode: "pretty" | "raw") => {
      frame.replaceChildren(mode === "pretty" ? tree : el("pre", { class: "code raw" }, text));
      pretty.setAttribute("aria-pressed", String(mode === "pretty"));
      plain.setAttribute("aria-pressed", String(mode === "raw"));
    };
    aside.push(
      el(
        "div",
        { class: "segs", attrs: { role: "group", "aria-label": "Body view" } },
        pretty,
        plain
      )
    );
    show("pretty");
  } else {
    frame.appendChild(raw);
  }
  aside.push(copyButton(abilities, () => text));
  const notes: Child[] = [];
  if (cut) notes.push(note(`Showing the first ${bytes(MAX_BODY_CHARS)} of ${bytes(body.length)}.`));
  if (view.bodyTruncated) {
    notes.push(
      note(
        `The tool output cut this body${view.bodySize !== null ? ` (${bytes(view.bodySize)} in all)` : ""}. The API, the SDKs and whk requests get return all of it.`
      )
    );
  }
  return section("Body", aside, frame, ...notes);
}

function methodClass(method: string): string {
  const known = ["GET", "POST", "PUT", "PATCH", "DELETE", "MAIL"];
  return known.includes(method) ? `m-${method.toLowerCase()}` : "m-other";
}

export function httpPanel(view: HttpView, abilities: Abilities): HTMLElement {
  const answer: Child[] = [];
  if (view.live) {
    const outcome =
      view.live.outcome && view.live.outcome !== "answered" ? view.live.outcome : null;
    answer.push(
      el(
        "div",
        { class: "wire wire-out" },
        el("span", { class: "wire-dir", attrs: { "aria-hidden": "true" } }, "←"),
        el(
          "span",
          { class: "status" },
          view.live.status === null ? "no answer" : String(view.live.status)
        ),
        el(
          "span",
          { class: "wire-why" },
          outcome ? `from your local app (${outcome})` : "from your local app",
          view.live.ms !== null ? ` in ${view.live.ms} ms` : null
        )
      )
    );
  } else if (view.answer) {
    answer.push(
      el(
        "div",
        { class: "wire wire-out" },
        el("span", { class: "wire-dir", attrs: { "aria-hidden": "true" } }, "←"),
        el("span", { class: "status" }, String(view.answer.status)),
        el(
          "span",
          { class: "wire-why" },
          view.answer.rule
            ? `answered by the rule “${view.answer.rule}”`
            : "sent back to the sender"
        )
      )
    );
  }

  const facts: Child[] = [
    el("span", null, formatTime(view.receivedAt, abilities)),
    bytes(view.size) ? el("span", null, bytes(view.size)) : null,
    view.contentType ? el("span", { class: "mono" }, view.contentType) : null,
    view.ip ? el("span", null, "from ", el("span", { class: "mono" }, view.ip)) : null,
  ];

  const verdicts: Child[] = [];
  if (view.signature) {
    const provider = view.signature.provider ? ` (${view.signature.provider})` : "";
    verdicts.push(
      view.signature.verified
        ? chip(`Signature valid${provider}`, "ok")
        : chip(`Signature failed${provider}`, "bad", view.signature.error ?? undefined)
    );
  }
  if (view.provider) {
    verdicts.push(chip(view.event ? `${view.provider}: ${view.event}` : view.provider));
  }

  const notes: Child[] = [];
  if (view.signature && !view.signature.verified && view.signature.error) {
    notes.push(note(view.signature.error));
  }
  if (view.shortened) {
    notes.push(
      note(
        "Only a summary of this request fit the tool output. The API, the SDKs and whk requests get return all of it."
      )
    );
  }

  return el(
    "article",
    { class: "panel" },
    el(
      "header",
      { class: "head" },
      el(
        "div",
        { class: "wire wire-in" },
        el("span", { class: "wire-dir", attrs: { "aria-hidden": "true" } }, "→"),
        el("span", { class: `method ${methodClass(view.method)}` }, view.method),
        el(
          "h1",
          { class: "target" },
          view.path,
          view.query ? el("span", { class: "query" }, view.query) : null
        )
      ),
      ...answer,
      el("div", { class: "facts" }, ...facts),
      verdicts.length > 0 ? el("div", { class: "chips" }, ...verdicts) : null
    ),
    ...notes,
    view.shortened
      ? null
      : section(
          "Headers",
          [el("span", { class: "count" }, String(view.headers.length))],
          view.headers.length > 0
            ? headersTable(view.headers, abilities)
            : note(view.headersNote ?? "No headers.")
        ),
    view.shortened ? null : bodySection(view, abilities)
  );
}

function addressText(address: Address | null): string {
  if (!address) return "";
  if (address.name && address.address) return `${address.name} <${address.address}>`;
  return address.name ?? address.address ?? "";
}

function verdictChip(name: string, result: string | null): HTMLElement | null {
  if (!result) return null;
  const tone =
    result === "pass" ? "ok" : /fail|softfail|permerror|temperror/.test(result) ? "bad" : "plain";
  return chip(`${name} ${result}`, tone);
}

export function emailPanel(view: EmailView, abilities: Abilities, upgrading: boolean): HTMLElement {
  const [main, ...more] = view.codes;
  const extracts: Child[] = [];
  if (main) {
    extracts.push(
      el(
        "div",
        { class: "code-hero" },
        el("div", { class: "code-label" }, "Code"),
        el("div", { class: "code-value" }, main),
        el(
          "div",
          { class: "code-tools" },
          copyButton(abilities, () => main, "Copy code")
        ),
        more.length > 0
          ? el(
              "div",
              { class: "code-more" },
              "Also found: ",
              ...more.flatMap((code, i) => [
                i > 0 ? ", " : null,
                el("span", { class: "mono" }, code),
              ])
            )
          : null
      )
    );
  }
  if (view.links.length > 0) {
    extracts.push(
      section(
        "Links",
        [el("span", { class: "count" }, String(view.links.length))],
        el(
          "ul",
          { class: "links" },
          ...view.links.map((link) =>
            el(
              "li",
              null,
              el(
                "div",
                { class: "link-text" },
                link.text ? el("div", { class: "link-label" }, link.text) : null,
                el("div", { class: "link-url mono" }, link.url)
              ),
              el(
                "div",
                { class: "link-tools" },
                openButton(abilities, link.url),
                copyButton(abilities, () => link.url)
              )
            )
          )
        )
      )
    );
  }
  if (!view.full && upgrading) {
    extracts.push(note("Looking for codes and links..."));
  }

  const checks: Child[] = [];
  if (view.auth) {
    checks.push(
      verdictChip("SPF", view.auth.spf),
      verdictChip("DKIM", view.auth.dkim),
      verdictChip("DMARC", view.auth.dmarc)
    );
  }
  if (view.spam && view.spam.score !== null) {
    const over = view.spam.required !== null && view.spam.score >= view.spam.required;
    checks.push(
      chip(
        `Spam score ${view.spam.score}${view.spam.required !== null ? ` of ${view.spam.required}` : ""}`,
        over ? "bad" : "plain",
        view.spam.action ? `rspamd suggests: ${view.spam.action}` : undefined
      )
    );
  }
  if (view.test) checks.push(chip("Test email"));

  const people: Child[] = [
    el(
      "div",
      { class: "who" },
      el("span", { class: "who-k" }, "From"),
      el("span", { class: "who-v" }, addressText(view.from) || "unknown")
    ),
    view.to.length > 0
      ? el(
          "div",
          { class: "who" },
          el("span", { class: "who-k" }, "To"),
          el("span", { class: "who-v" }, view.to.map(addressText).join(", "))
        )
      : null,
    view.cc.length > 0
      ? el(
          "div",
          { class: "who" },
          el("span", { class: "who-k" }, "Cc"),
          el("span", { class: "who-v" }, view.cc.map(addressText).join(", "))
        )
      : null,
  ];

  const facts: Child[] = [
    el("span", null, formatTime(view.receivedAt, abilities)),
    view.tag ? el("span", null, "tag ", el("span", { class: "mono" }, view.tag)) : null,
    bytes(view.size) ? el("span", null, bytes(view.size)) : null,
  ];

  const fieldRows = view.fields.map(([name, value]) =>
    el(
      "tr",
      null,
      el("th", { attrs: { scope: "row" } }, name),
      el(
        "td",
        null,
        el(
          "div",
          { class: "hv" },
          el("span", { class: "hv-text" }, value ?? "not found"),
          el("span", { class: "hv-tools" }, value ? copyButton(abilities, () => value) : null)
        )
      )
    )
  );

  const text = view.text ?? "";
  const textCut = text.length > MAX_BODY_CHARS;
  const textNotes: Child[] = [];
  if (view.textTruncated || textCut)
    textNotes.push(note("The text part was cut to fit the tool output."));
  if (view.htmlSize > 0)
    textNotes.push(note(`HTML part not shown here (${bytes(view.htmlSize)}).`));

  const total = view.attachmentsTotal ?? view.attachments.length;

  return el(
    "article",
    { class: "panel" },
    el(
      "header",
      { class: "head" },
      el(
        "div",
        { class: "wire wire-in" },
        el("span", { class: "method m-mail" }, "MAIL"),
        el("span", { class: "mono addr" }, view.address ?? "")
      ),
      el("h1", { class: "subject" }, view.subject ?? "(no subject)"),
      el("div", { class: "people" }, ...people),
      el("div", { class: "facts" }, ...facts),
      checks.some(Boolean) ? el("div", { class: "chips" }, ...checks) : null
    ),
    view.note ? note(view.note) : null,
    ...extracts,
    fieldRows.length > 0
      ? section(
          "Fields",
          [],
          el(
            "div",
            { class: "table-wrap" },
            el("table", { class: "kv" }, el("tbody", null, ...fieldRows))
          )
        )
      : null,
    section(
      "Text",
      [text ? copyButton(abilities, () => text) : null],
      text
        ? el(
            "div",
            { class: "code-frame" },
            el("pre", { class: "code prose" }, textCut ? text.slice(0, MAX_BODY_CHARS) : text)
          )
        : note("No text part."),
      ...textNotes
    ),
    total > 0
      ? section(
          "Attachments",
          [el("span", { class: "count" }, String(total))],
          el(
            "ul",
            { class: "files" },
            ...view.attachments.map((file) =>
              el(
                "li",
                null,
                el("span", { class: "file-name" }, file.name ?? "(unnamed)"),
                el(
                  "span",
                  { class: "file-meta mono" },
                  [file.type, bytes(file.size), file.inline ? "inline" : null]
                    .filter(Boolean)
                    .join("  ")
                )
              )
            )
          ),
          total > view.attachments.length
            ? note(`${total - view.attachments.length} more not listed in the tool output.`)
            : null
        )
      : null
  );
}

export function viewPanel(view: View, abilities: Abilities, upgrading: boolean): HTMLElement {
  return view.kind === "http" ? httpPanel(view, abilities) : emailPanel(view, abilities, upgrading);
}

export function skeleton(): HTMLElement {
  return el(
    "div",
    { class: "panel skeleton", attrs: { "aria-busy": "true", "aria-label": "Loading" } },
    el("div", { class: "sk sk-line w60" }),
    el("div", { class: "sk sk-line w35" }),
    el("div", { class: "sk sk-block" }),
    el("div", { class: "sk sk-block short" })
  );
}

export function problem(title: string, detail: string | null): HTMLElement {
  return el(
    "div",
    { class: "problem", attrs: { role: "alert" } },
    el("strong", null, title),
    detail ? el("p", null, detail) : null
  );
}

export interface StripState {
  slug: string;
  items: RecentItem[];
  currentId: string | null;
  loadingId: string | null;
  refreshing: boolean;
  failed: string | null;
}

/** The endpoint's recent requests, to click through. */
export function strip(
  state: StripState,
  onPick: (item: RecentItem) => void,
  onRefresh: () => void
): HTMLElement {
  const list = el("ol", { class: "recent-list" });
  for (const item of state.items) {
    const current = item.id === state.currentId;
    const pick = el(
      "button",
      {
        class: `recent-item${current ? " is-current" : ""}${item.id === state.loadingId ? " is-loading" : ""}`,
        attrs: { type: "button", ...(current ? { "aria-current": "true" } : {}) },
        onClick: () => onPick(item),
      },
      el("span", { class: `method ${methodClass(item.method)}` }, item.method),
      el("span", { class: item.email ? "recent-label is-subject" : "recent-label" }, item.label),
      el("span", { class: "recent-time" }, relativeTime(item.receivedAt))
    );
    list.appendChild(el("li", null, pick));
  }
  const refresh = button(state.refreshing ? "Refreshing" : "Refresh", onRefresh, "btn btn-quiet");
  if (state.refreshing) refresh.disabled = true;
  const body: Child[] = [];
  if (state.failed) body.push(note(state.failed));
  else if (state.items.length === 0) body.push(note("Nothing captured at this endpoint yet."));
  else body.push(list);
  const head = el(
    "div",
    { class: "sec-head" },
    el("h2", null, "Recent at ", el("span", { class: "mono" }, state.slug)),
    el("div", { class: "sec-aside" }, refresh)
  );
  const root = el("nav", { class: "recent", attrs: { "aria-label": "Recent requests" } }, head);
  append(root, body);
  return root;
}
