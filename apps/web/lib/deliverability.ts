import { emailAnchors, htmlToText, type EmailCapture } from "@webhooks-cc/sdk/email";

/**
 * The deliverability report on a captured email: what a mailbox provider
 * would hold against it, as a checklist.
 *
 * Two kinds of input. What only DNS could tell at the time (the SPF, DMARC,
 * DKIM key and BIMI records, the HELO name) is recorded by the MX host when
 * the email arrives (`auth.setup`, apps/mx-rs/src/sender_setup.rs), and only
 * as facts; this module decides what counts as a problem, so a threshold can
 * change without redeploying the MX host. What the message itself shows
 * (headers, parts, links, images) is read here from the stored email, so
 * those checks also cover mail captured before the report existed.
 *
 * Nothing here decides whether mail is accepted, and links are never
 * fetched: following them would use up the one-time sign-in and
 * confirmation links that people capture here to test.
 */

export type FindingStatus = "pass" | "warn" | "fail" | "info";
export type FindingGroup = "authentication" | "server" | "message";

export interface Finding {
  /** Stable, for keys and tests. */
  id: string;
  group: FindingGroup;
  status: FindingStatus;
  title: string;
  detail: string;
}

export interface DeliverabilityReport {
  findings: Finding[];
  /** The MX host recorded the sender's DNS setup for this email. */
  setupRecorded: boolean;
}

export interface DeliverabilityInput {
  email: EmailCapture;
  /** The message's headers, lowercase names (the request's `headers`). */
  headers: Record<string, string>;
  /** When the email arrived, in milliseconds since the epoch. */
  receivedAt: number;
}

/** RFC 7208 section 4.6.4. */
const SPF_LOOKUP_LIMIT = 10;
/** Gmail cuts messages whose HTML is larger than this behind "View entire message". */
const GMAIL_CLIP_BYTES = 102 * 1024;
/** A Date header further than this from the arrival time looks wrong. */
const DATE_SKEW_MS = 24 * 60 * 60 * 1000;
/** Visible text an email with images needs at the least, and per image past the first. */
const MIN_TEXT_ANY = 20;
const MIN_TEXT_PER_IMAGE = 100;
/** Examples named in a finding. */
const MAX_EXAMPLES = 3;

const SHORTENERS = new Set([
  "bit.ly",
  "bitly.com",
  "buff.ly",
  "cutt.ly",
  "goo.gl",
  "is.gd",
  "ow.ly",
  "rb.gy",
  "rebrand.ly",
  "shorturl.at",
  "t.co",
  "t.ly",
  "tiny.cc",
  "tinyurl.com",
  "v.gd",
]);

export function deliverabilityReport(input: DeliverabilityInput): DeliverabilityReport {
  const findings: Finding[] = [];
  const add = (
    group: FindingGroup,
    id: string,
    status: FindingStatus,
    title: string,
    detail: string
  ) => findings.push({ id, group, status, title, detail });
  const setup = input.email.auth?.setup ?? null;

  authenticationFindings(input, (...args) => add("authentication", ...args));
  serverFindings(input, (...args) => add("server", ...args));
  messageFindings(input, (...args) => add("message", ...args));
  return { findings, setupRecorded: setup !== null && setup.error === null };
}

type Add = (id: string, status: FindingStatus, title: string, detail: string) => void;

function list(items: string[]): string {
  const shown = items.slice(0, MAX_EXAMPLES);
  const more = items.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ------------------------------------------------------------ authentication

function authenticationFindings({ email }: DeliverabilityInput, add: Add) {
  const auth = email.auth;
  if (!auth || auth.error) return;
  const setup = auth.setup ?? null;
  const spf = setup?.spf ?? null;

  if (spf) {
    const domain = spf.domain ?? "The sender's domain";
    if (spf.error) {
      add(
        "spf-record",
        "info",
        "SPF record not checked",
        `The SPF record of ${domain} could not be looked up.`
      );
    } else if (spf.records === 0 && !email.smtp?.envelopeFrom) {
      // A bounce: SPF checked the HELO name, which often has no record.
      add(
        "spf-record",
        "warn",
        "No SPF record for the HELO name",
        `The envelope sender is empty (a bounce or automated message), so SPF checked the server's HELO name, ${domain}, which publishes no SPF record.${setup?.helo?.ipLiteral ? " The server introduced itself with an address rather than a name, so give it a hostname first." : ' Publishing "v=spf1 a -all" there lets receivers check bounces too.'}`
      );
    } else if (spf.records === 0) {
      add(
        "spf-record",
        "fail",
        "No SPF record",
        `${domain} publishes no SPF record, so receivers cannot tell which servers may send its mail. Gmail and Yahoo require SPF or DKIM, and both for bulk senders.`
      );
    } else if (spf.records > 1) {
      add(
        "spf-record",
        "fail",
        "More than one SPF record",
        `${domain} publishes ${spf.records} SPF records. Receivers treat that as an error (permerror), as if there were none: merge them into one.`
      );
    } else {
      if (spf.all === "+all") {
        add(
          "spf-all",
          "fail",
          "SPF allows every server",
          `The record of ${domain} ends in +all, so any server in the world passes SPF for it. End it in ~all or -all.`
        );
      } else if (spf.all === "?all" || spf.all === null) {
        add(
          "spf-all",
          "warn",
          "SPF says nothing about other servers",
          `The record of ${domain} ${spf.all === null ? "has no all term" : "ends in ?all"}, so servers it does not list are neutral rather than failing. End it in ~all or -all.`
        );
      } else {
        add(
          "spf-all",
          "pass",
          `SPF record ends in ${spf.all}`,
          `Servers ${domain} does not list fail SPF.`
        );
      }
      if (spf.lookups !== null) {
        const count = spf.lookupsCapped
          ? `more than ${spf.lookups}`
          : spf.lookupsIncomplete || spf.lookupsUnfollowed
            ? `at least ${spf.lookups}`
            : String(spf.lookups);
        // Includes with a macro depend on each message and are never
        // followed; the verdict stands on what was counted.
        const unfollowed = spf.lookupsUnfollowed
          ? " Includes with macros are not followed, so they may add more."
          : "";
        if (spf.lookups > SPF_LOOKUP_LIMIT || spf.lookupsCapped) {
          add(
            "spf-lookups",
            "fail",
            "SPF takes too many DNS lookups",
            `Checking the record of ${domain} takes ${count} DNS lookups, includes followed. Past ${SPF_LOOKUP_LIMIT}, SPF fails with a permerror for every receiver. Drop includes you no longer send through, or replace them with ip4 and ip6 ranges.`
          );
        } else if (spf.lookupsIncomplete) {
          // A record that could not be read may add any number: no verdict.
          add(
            "spf-lookups",
            "info",
            "SPF lookup count incomplete",
            `Checking the record of ${domain} takes ${count} DNS lookups, but a record it includes could not be looked up when the email arrived, so the total may be higher.`
          );
        } else if (spf.lookups >= SPF_LOOKUP_LIMIT - 1) {
          add(
            "spf-lookups",
            "warn",
            "SPF is close to its lookup limit",
            `Checking the record of ${domain} takes ${count} of the ${SPF_LOOKUP_LIMIT} DNS lookups SPF allows. One more include and it fails for every receiver.${unfollowed}`
          );
        } else {
          add(
            "spf-lookups",
            "pass",
            `SPF takes ${spf.lookupsUnfollowed ? "at least " : ""}${plural(spf.lookups, "DNS lookup")}`,
            `Well within the limit of ${SPF_LOOKUP_LIMIT}.${unfollowed}`
          );
        }
      }
      if (spf.missingIncludes.length > 0 || spf.duplicateIncludes.length > 0) {
        const problems = [
          spf.missingIncludes.length > 0 &&
            `${list(spf.missingIncludes)} ${spf.missingIncludes.length === 1 ? "publishes" : "publish"} no SPF record`,
          spf.duplicateIncludes.length > 0 &&
            `${list(spf.duplicateIncludes)} ${spf.duplicateIncludes.length === 1 ? "publishes" : "publish"} more than one`,
        ].filter(Boolean);
        add(
          "spf-includes",
          "fail",
          "SPF points at a broken record",
          `The record of ${domain} includes or redirects to domains whose SPF is broken: ${problems.join("; ")}. A receiver that reaches one fails SPF with a permerror. Remove the include or redirect, fix its name, or merge the records.`
        );
      }
      if (spf.ptr) {
        add(
          "spf-ptr",
          "warn",
          "SPF uses ptr",
          `The record of ${domain} (or one it includes) uses the ptr mechanism, which RFC 7208 says not to use: it is slow, and some receivers skip it.`
        );
      }
    }
  }

  const dmarc = auth.dmarc;
  const setupOk = setup !== null && setup.error === null;
  const record = setupOk ? setup.dmarc : null;
  const fromDomain = dmarc?.domain || "The From domain";
  const result = dmarc?.result ?? null;
  const dkimPassed = auth.dkim.some((signature) => signature.result === "pass");
  // DMARC is evaluated only for mail with one From domain (the MX host
  // leaves the domain empty otherwise). Before the MX host took
  // mail-auth's own verdict, "none" also covered a record that nothing
  // aligned with, so for mail without the recorded setup it only means "no
  // record" when SPF or DKIM passed.
  const noRecord =
    Boolean(dmarc?.domain) &&
    result === "none" &&
    (setupOk || auth.spf?.result === "pass" || dkimPassed);
  if (result === "permerror") {
    add(
      "dmarc-record",
      "fail",
      "DMARC record is invalid",
      `The DMARC record of ${fromDomain} could not be read (permerror), so receivers apply no policy at all. Check its syntax: v=DMARC1 first, then p=none, quarantine or reject.`
    );
  } else if (result === "temperror") {
    add(
      "dmarc-record",
      "info",
      "DMARC not checked",
      `The DMARC record of ${fromDomain} could not be looked up when the email arrived.`
    );
  } else if (noRecord) {
    add(
      "dmarc-record",
      "fail",
      "No DMARC record",
      `${fromDomain} publishes no DMARC record. Gmail and Yahoo require one from bulk senders, and without it anyone can put ${fromDomain} in the From line.`
    );
  } else if (result === "pass" || result === "fail") {
    // The policy that applied to this From domain: for a subdomain that is
    // the record's sp (or np), not its p.
    const applied =
      dmarc?.policy === "none" || dmarc?.policy === "quarantine" || dmarc?.policy === "reject"
        ? dmarc.policy
        : (record?.p ?? null);
    // Name where the policy came from only when it is the record's sp; a
    // policy lowered by t=y, or a record with rua and no p, is not that.
    const fromSubdomainPolicy =
      record !== null &&
      applied !== null &&
      applied !== record.p &&
      applied === record.sp &&
      !record.testing;
    if (applied === "none" || (applied === null && record !== null)) {
      add(
        "dmarc-policy",
        "warn",
        "DMARC only monitors",
        `The policy that applies to ${fromDomain} is none${fromSubdomainPolicy ? " (the record's policy for subdomains)" : ""}: mail that fails DMARC is delivered as usual. Once the reports show only your own servers, move to quarantine and then reject.`
      );
    } else if (applied !== null) {
      add(
        "dmarc-policy",
        "pass",
        `DMARC policy is ${applied}`,
        `Mail that fails DMARC for ${fromDomain} is ${applied === "reject" ? "refused" : "sent to spam"}${fromSubdomainPolicy ? " (the record's policy for subdomains)" : ""}.`
      );
    }
    if (record?.testing) {
      add(
        "dmarc-testing",
        "warn",
        "DMARC is in testing mode",
        "The record has t=y, so receivers apply a weaker policy than it names."
      );
    }
    if (record && record.rua.length === 0) {
      add(
        "dmarc-reports",
        "warn",
        "No DMARC reports",
        "The record has no rua address, so you never learn which servers send mail as your domain or whether it passes."
      );
    } else if (record) {
      add(
        "dmarc-reports",
        "pass",
        "DMARC reports are on",
        `Aggregate reports go to ${list(record.rua)}.`
      );
    }

    const dkimDomains = auth.dkim
      .filter((signature) => signature.result === "pass" && signature.domain)
      .map((signature) => signature.domain!);
    const parts: string[] = [];
    if (dmarc?.dkim === "pass") parts.push(`DKIM (${list([...new Set(dkimDomains)])})`);
    if (dmarc?.spf === "pass") parts.push(`SPF (${auth.spf?.domain ?? "the envelope sender"})`);
    if (parts.length > 0) {
      add(
        "alignment",
        "pass",
        "Aligned with the From domain",
        `${parts.join(" and ")} match ${fromDomain}, which is what DMARC checks.`
      );
    } else {
      add(
        "alignment",
        "fail",
        "Not aligned with the From domain",
        `Neither a passing DKIM signature nor a passing SPF domain matches ${fromDomain}${record ? ` (alignment: DKIM ${record.adkim}, SPF ${record.aspf})` : ""}, so the email fails DMARC. Sign with a key on ${fromDomain}, or send from an envelope address on it through a server its SPF lists.`
      );
    }
  }

  // Skipped means the message was too unusual to verify, not unsigned.
  if (auth.dkim.length === 0 && result !== "skipped") {
    add(
      "dkim-signed",
      "fail",
      "Not signed with DKIM",
      "The email carries no DKIM signature. Gmail and Yahoo require DKIM from bulk senders, and it is what survives forwarding when SPF does not."
    );
  }
  // Each signature that does not verify. A missing or retired key gets its
  // own finding below, which already says why.
  const keyExplains = (domain: string | null, selector: string | null) =>
    setupOk &&
    setup.dkim.some(
      (key) =>
        key.domain === domain &&
        key.selector === selector &&
        !key.error &&
        (key.revoked || key.key === null)
    );
  for (const [index, signature] of auth.dkim.entries()) {
    if (signature.result !== "fail" && signature.result !== "permerror") continue;
    if (keyExplains(signature.domain, signature.selector)) continue;
    const otherPasses = auth.dkim.some((other) => other !== signature && other.result === "pass");
    const by = signature.domain ?? "an unknown domain";
    add(
      `dkim-signature-${index}-${signature.domain ?? "unknown"}-${signature.selector ?? "unknown"}`,
      otherPasses ? "warn" : "fail",
      "DKIM signature does not verify",
      `The signature by ${by}${signature.selector ? ` (selector ${signature.selector})` : ""} does not check out (${signature.result}): the message changed after signing, or the key does not match.${otherPasses ? " Another signature on the email passes, so delivery does not depend on this one." : ""}`
    );
  }
  const keys = setupOk ? setup.dkim : [];
  for (const [index, key] of keys.entries()) {
    const name = `${key.selector}._domainkey.${key.domain}`;
    // The position keeps ids apart whatever names a sender picks.
    const id = `dkim-key-${index}-${key.domain}-${key.selector}`;
    // A bad extra signature does not matter while another one passes.
    const otherPasses = auth.dkim.some(
      (signature) =>
        signature.result === "pass" &&
        !(signature.domain === key.domain && signature.selector === key.selector)
    );
    const severity: FindingStatus = otherPasses ? "warn" : "fail";
    const besides = otherPasses
      ? " Another signature on the email passes, so delivery does not depend on this one."
      : "";
    if (key.error) {
      add(
        id,
        "info",
        "DKIM key not checked",
        `The key at ${name} could not be looked up when the email arrived.`
      );
    } else if (key.revoked) {
      add(
        id,
        severity,
        "DKIM key revoked",
        `${name} publishes an empty key: this selector was retired, so the signature cannot pass.${besides}`
      );
    } else if (key.key === null) {
      add(
        id,
        severity,
        "No DKIM key published",
        `Nothing is published at ${name}, so the signature cannot be checked.${besides}`
      );
    } else if (key.key === "rsa" && key.bits !== null && key.bits < 1024) {
      add(
        id,
        severity,
        `DKIM key is ${key.bits} bits`,
        `The RSA key at ${name} is too short: receivers ignore keys under 1024 bits. Publish a 2048-bit key.${besides}`
      );
    } else if (key.key === "rsa" && key.bits !== null && key.bits < 2048) {
      add(
        id,
        "warn",
        `DKIM key is ${key.bits} bits`,
        `The RSA key at ${name} works, but 2048 bits is what providers recommend now. Rotate to a 2048-bit key when you next can.`
      );
    } else if (key.bits !== null) {
      add(
        id,
        "pass",
        `DKIM key is ${key.bits}-bit ${key.key === "ed25519" ? "Ed25519" : "RSA"}`,
        `The key at ${name}.`
      );
    }
    if (key.algorithm === "rsa-sha1") {
      add(
        `${id}-sha1`,
        severity,
        "Signed with rsa-sha1",
        `The signature by ${key.domain} uses SHA-1, which receivers must no longer accept (RFC 8301). Sign with rsa-sha256.${besides}`
      );
    }
  }
  if (keys.length > 0 && keys.every((key) => key.key === "ed25519")) {
    add(
      "dkim-ed25519-only",
      "warn",
      "Only an Ed25519 signature",
      "Not every receiver checks Ed25519 signatures yet. Sign with an RSA key as well, as RFC 8463 suggests."
    );
  }

  const arc = auth.arc;
  if (arc && arc.sets > 0) {
    const via = arc.sealers.length > 0 ? ` (${list(arc.sealers)})` : "";
    if (arc.result === "pass") {
      add(
        "arc",
        "pass",
        "ARC chain intact",
        `The email was forwarded by ${plural(arc.sets, "server")}${via} that sealed what they received, so receivers can trust the original results even where forwarding broke SPF or DKIM.`
      );
    } else {
      add(
        "arc",
        "warn",
        "ARC chain broken",
        `The email was forwarded by ${plural(arc.sets, "server")}${via}, but the chain does not verify (${arc.result}), so the original results cannot be trusted.`
      );
    }
  }
}

// ------------------------------------------------------------ server

function serverFindings({ email }: DeliverabilityInput, add: Add) {
  const auth = email.auth;
  const smtp = email.smtp;
  const ip = smtp?.clientIp ?? "The sending server";

  if (auth && !auth.error && auth.iprev) {
    if (auth.iprev.result === "pass" && auth.iprev.ptr) {
      add("ptr", "pass", "Reverse DNS", `${ip} resolves to ${auth.iprev.ptr} and back.`);
    } else {
      add(
        "ptr",
        "fail",
        "No reverse DNS",
        `${ip} has no reverse DNS name that resolves back to it. Many receivers, Gmail included, turn such servers away or score them as spam.`
      );
    }
  }

  const helo = auth?.setup?.helo ?? null;
  if (helo) {
    if (helo.ipLiteral) {
      add(
        "helo",
        "warn",
        "HELO is an address",
        `The server introduced itself as ${helo.name} rather than by name. Use its hostname, the one its reverse DNS names.`
      );
    } else if (!helo.fqdn) {
      add(
        "helo",
        "warn",
        "HELO is not a full name",
        `The server introduced itself as "${helo.name}", which is not a fully qualified domain name.`
      );
    } else if (helo.matchesPtr) {
      add(
        "helo",
        "pass",
        "HELO matches reverse DNS",
        `The server introduced itself as ${helo.name}, its reverse DNS name.`
      );
    } else if (helo.resolves) {
      add(
        "helo",
        "pass",
        "HELO resolves to the server",
        `The server introduced itself as ${helo.name}, which resolves to its address.`
      );
    } else {
      add(
        "helo",
        "warn",
        "HELO does not resolve to the server",
        `The server introduced itself as ${helo.name}, which does not resolve to ${ip}. Use the name its reverse DNS gives.`
      );
    }
  }

  if (smtp) {
    if (smtp.tls?.version) {
      add("tls", "pass", "Sent over TLS", "The connection was encrypted.");
    } else {
      add(
        "tls",
        "warn",
        "Sent without TLS",
        "The server did not start TLS. Gmail lists TLS among its requirements for every sender and marks unencrypted mail with a red padlock."
      );
    }
  }

  const bimi = auth?.setup?.bimi ?? null;
  // The policy that applied to this From domain (sp for a subdomain).
  const policy = auth?.dmarc?.policy ?? auth?.setup?.dmarc?.p ?? null;
  const enforced = policy === "quarantine" || policy === "reject";
  if (bimi && !bimi.error) {
    if (bimi.found && bimi.logo) {
      if (!enforced) {
        add(
          "bimi",
          "warn",
          "BIMI logo will not show",
          `${bimi.domain} publishes a BIMI logo, but receivers only show it when DMARC is at quarantine or reject.`
        );
      } else if (!bimi.authority) {
        add(
          "bimi",
          "info",
          "BIMI logo without a certificate",
          `${bimi.domain} publishes a BIMI logo. Gmail and Apple Mail only show it with a mark certificate (the a= tag); Yahoo shows it without one.`
        );
      } else {
        add(
          "bimi",
          "pass",
          "BIMI logo published",
          `${bimi.domain} publishes a logo and a mark certificate.`
        );
      }
    } else {
      add(
        "bimi",
        "info",
        "No BIMI logo",
        "Optional: a BIMI record shows your logo next to your mail in Gmail, Yahoo and Apple Mail, once DMARC is at quarantine or reject."
      );
    }
  }
}

// ------------------------------------------------------------ message

function header(headers: Record<string, string>, name: string): string | null {
  const value = headers[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Second-level labels under which country domains register names
 * (example.co.uk, example.com.au): a partial public suffix list, the same as
 * the MX host's for BIMI (sender_setup.rs).
 */
const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne"]);

/**
 * "www." dropped; the registrable domain, roughly: the last two labels, or
 * three under a country's second-level suffix, so paypal.co.uk and
 * attacker.co.uk stay apart without the full public suffix list.
 */
function site(host: string): string {
  const labels = host
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const n = labels.length;
  const country = n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL_SUFFIXES.has(labels[n - 2]);
  return labels.slice(country ? -3 : -2).join(".");
}

/**
 * Top-level domains a bare "name.tld" link text must end in to count as an
 * address. Without a scheme or "www.", text such as "invoice.pdf" or
 * "Node.js" is a file or a product name, not a site.
 */
const COMMON_TLDS = new Set(
  (
    "com net org io co app dev ai me info biz us uk de fr nl dk se no fi eu ca au nz es it " +
    "ch at be pl ie pt cz jp in br mx"
  ).split(" ")
);

/** The host a link's text names, when the text is a URL or a domain. */
function hostInText(text: string): string | null {
  // An email address is not a site: support@acme.com is not acme.com.
  if (text.length === 0 || text.length > 200 || /[\s@]/.test(text)) return null;
  const scheme = /^https?:\/\//i.test(text);
  try {
    const host = new URL(scheme ? text : `https://${text}`).hostname.toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
    if (scheme || host.startsWith("www.")) return host;
    return COMMON_TLDS.has(host.slice(host.lastIndexOf(".") + 1)) ? host : null;
  } catch {
    return null;
  }
}

function isIpHost(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Attributes read per image tag; real ones are far shorter. */
const MAX_IMG_TAG_CHARS = 2000;
/** A width or height attribute or style, never data-width or ?width= in a URL. */
const IMG_SIZE = /(?<=[\s"';])(?:width|height)\s*[=:]\s*["']?\s*(\d+)/gi;

/**
 * The images a reader sees: tracking pixels (an image 2 pixels wide or high
 * or less, or hidden) are left out. Linear: the end of a tag is looked for
 * once per tag, and only its first characters are read.
 */
function countImages(html: string): number {
  const lower = html.toLowerCase();
  let count = 0;
  let close = -1;
  for (let at = lower.indexOf("<img"); at !== -1; at = lower.indexOf("<img", at + 4)) {
    if (close < at) close = lower.indexOf(">", at);
    if (close === -1) break;
    const tag = lower.slice(at, Math.min(close, at + MAX_IMG_TAG_CHARS));
    if (/display\s*:\s*none/.test(tag)) continue;
    let pixel = false;
    for (const size of tag.matchAll(IMG_SIZE)) {
      if (Number(size[1]) <= 2) pixel = true;
    }
    if (!pixel) count++;
  }
  return count;
}

function messageFindings({ email, headers, receivedAt }: DeliverabilityInput, add: Add) {
  if (email.from.length === 0) {
    add(
      "from",
      "fail",
      "No From address",
      "The email has no From header, which every email must have (RFC 5322)."
    );
  } else if (email.from.length > 1) {
    add(
      "from",
      "warn",
      "More than one From address",
      "RFC 5322 allows that only with a Sender header, and receivers often refuse such mail or check DMARC for every domain in it. Send from one address."
    );
  }

  if (!email.messageId) {
    add(
      "message-id",
      "fail",
      "No Message-ID",
      "The email has no Message-ID header. Gmail rejects or flags mail without one."
    );
  } else {
    add("message-id", "pass", "Message-ID present", email.messageId);
  }

  const date = email.date ? Date.parse(email.date) : NaN;
  // The receiver stores no date it cannot read; the header may still be there.
  const rawDate = header(headers, "date");
  if (!email.date && rawDate) {
    add(
      "date",
      "warn",
      "Unreadable Date header",
      `The Date header "${rawDate.slice(0, 100)}" is not a date in the form RFC 5322 asks for, such as "Tue, 3 Nov 2026 10:00:00 +0000".`
    );
  } else if (!email.date) {
    add(
      "date",
      "fail",
      "No Date header",
      "The email has no Date header, which every email must have (RFC 5322)."
    );
  } else if (Number.isNaN(date)) {
    add(
      "date",
      "warn",
      "Unreadable Date header",
      `The Date header "${email.date}" could not be read.`
    );
  } else if (Math.abs(date - receivedAt) > DATE_SKEW_MS) {
    add(
      "date",
      "warn",
      "Date is far from when it arrived",
      "The Date header is more than a day before or after the email arrived. Check the sending server's clock."
    );
  }

  if (!email.subject?.trim()) {
    add(
      "subject",
      "warn",
      "No subject",
      "An email without a subject looks like spam to people and to filters."
    );
  }

  if (email.html) {
    if (email.textFromHtml) {
      add(
        "text-part",
        "warn",
        "No plain-text part",
        "The email is HTML only. Filters score that up; send a text/plain alternative with the same content."
      );
    } else if (email.text) {
      add(
        "text-part",
        "pass",
        "Plain-text part included",
        "The email carries both HTML and plain text."
      );
    }
  }

  const unsubscribe = header(headers, "list-unsubscribe");
  const oneClick = /list-unsubscribe\s*=\s*one-click/i.test(
    header(headers, "list-unsubscribe-post") ?? ""
  );
  if (!unsubscribe) {
    add(
      "unsubscribe",
      "info",
      "No List-Unsubscribe header",
      "Gmail and Yahoo require one-click unsubscribe (List-Unsubscribe and List-Unsubscribe-Post) for bulk and marketing mail. Transactional mail such as receipts and sign-in links can do without."
    );
  } else if (!/<https:\/\//i.test(unsubscribe)) {
    add(
      "unsubscribe",
      "warn",
      "Unsubscribe without an https link",
      "List-Unsubscribe names no https URL. One-click unsubscribe, which Gmail and Yahoo require for bulk mail, needs one."
    );
  } else if (!oneClick) {
    add(
      "unsubscribe",
      "warn",
      "Unsubscribe is not one-click",
      "List-Unsubscribe has an https URL, but there is no List-Unsubscribe-Post: List-Unsubscribe=One-Click header, which Gmail and Yahoo require for bulk mail (RFC 8058)."
    );
  } else {
    add(
      "unsubscribe",
      "pass",
      "One-click unsubscribe",
      "List-Unsubscribe and List-Unsubscribe-Post are both set (RFC 8058)."
    );
  }

  const html = email.html;
  if (!html) return;
  const anchors = emailAnchors(html);
  if (anchors.length > 0) {
    const hosts = anchors.map((anchor) => new URL(anchor.url).hostname.toLowerCase());
    const shortened = [
      ...new Set(hosts.filter((host) => SHORTENERS.has(host.replace(/^www\./, "")))),
    ];
    const mismatched = [
      ...new Set(
        anchors.flatMap((anchor, index) => {
          const shown = hostInText(anchor.text);
          return shown && site(shown) !== site(hosts[index])
            ? [`${shown} goes to ${hosts[index]}`]
            : [];
        })
      ),
    ];
    const byAddress = [...new Set(hosts.filter(isIpHost))];
    const plain = anchors.filter((anchor) => anchor.url.startsWith("http:")).length;
    if (mismatched.length > 0) {
      add(
        "links-text",
        "warn",
        "Link text names another site",
        `Links whose text shows one address and go to another look like phishing to filters: ${list(mismatched)}. Click tracking often causes this; show plain words instead of an address.`
      );
    }
    if (shortened.length > 0) {
      add(
        "links-shorteners",
        "warn",
        "Shortened links",
        `Links through ${list(shortened)}. Spammers hide behind shorteners, so filters score them up; link to your own domain.`
      );
    }
    if (byAddress.length > 0) {
      add(
        "links-ip",
        "warn",
        "Links to an IP address",
        `Links to ${list(byAddress)} rather than a domain look like phishing.`
      );
    }
    if (plain > 0) {
      add("links-http", "info", "Links without https", `${plural(plain, "link")} use plain http.`);
    }
    if (mismatched.length + shortened.length + byAddress.length === 0) {
      add(
        "links",
        "pass",
        `${plural(anchors.length, "link")}, nothing unusual`,
        "No shorteners, address links, or link text naming another site."
      );
    }
  }

  const images = countImages(html);
  if (images > 0) {
    const text = htmlToText(html).length;
    // A logo above a short sign-in code is normal; a picture with nothing
    // beside it, or several with little text, is what filters flag.
    if (text < MIN_TEXT_PER_IMAGE * Math.max(images - 1, 0) || text < MIN_TEXT_ANY) {
      add(
        "images",
        "warn",
        "Mostly images",
        `${plural(images, "image")} and ${plural(text, "character")} of text. Filters cannot read images, so image-heavy mail with little text looks like spam, and many readers see nothing until they load images.`
      );
    } else {
      add(
        "images",
        "pass",
        `${plural(images, "image")} with text`,
        "There is enough text beside the images."
      );
    }
  }

  const htmlBytes = new TextEncoder().encode(html).length;
  if (email.truncated.html || htmlBytes > GMAIL_CLIP_BYTES) {
    add(
      "size",
      "warn",
      "Gmail will clip it",
      `The HTML is ${email.truncated.html ? "over 256" : Math.round(htmlBytes / 1024)} KB. Gmail hides everything past 102 KB behind "View entire message", tracking pixel and unsubscribe link included.`
    );
  }
}
