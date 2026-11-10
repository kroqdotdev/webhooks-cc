import { randomInt } from "node:crypto";

/*
 * Preview names are the first label of a preview's address: `acme` in
 * acme.sharehooks.cc. Free previews get a random name ending in `-free` each
 * time; plans with reserved names keep the ones they ask for. Some names are
 * never newly given out: the ones the service uses itself, the examples on our
 * own pages, names with words phishing pages borrow, and the ones staff
 * blocked (tunnel_blocked_names, tunnel_blocked_words; lib/tunnels/names.ts).
 */

export const FREE_SUFFIX = "-free";

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * Names refused exactly: the ones the service uses or that would confuse
 * people, mail and login addresses, and short brands that would catch
 * innocent names as a part of one (ups is in groups, visa in improvisation).
 */
const SERVICE_NAMES = `www api app edge tunnel relay admin root mail smtp imap pop ftp ns ns1 ns2
  dns mx webmail autodiscover autoconfig mta-sts postmaster hostmaster webmaster
  noreply no-reply status docs help support helpdesk billing pay payment
  payments checkout invoice invoices refund refunds login logon signin signup
  sign-in sign-up auth oauth sso account accounts secure security verify
  verification password reset update cdn static assets dashboard ops
  operations internal test staging dev localhost abuse report phishing
  official domains portal console my-account customer customers service
  services pricing plans invite invites team teams share shares site sites
  upload deploy download downloads install cli sdk mcp legal terms privacy
  trust press blog news jobs careers contact shop store tax customs
  delivery parcel tracking shipping police politi gov ups gls usps bring
  nets visa irs okx go capture hooks`.split(/\s+/);

/**
 * Names our own pages, guides and READMEs show as examples. Whoever kept one
 * would be behind every example link, so no one does.
 */
const EXAMPLE_NAMES = `acme acme-preview acme-staging studio demo example preview name other
  my-app myapp calm-otter-4821 quiet-otter-1234 amber-badger-0042`.split(/\s+/);

const BLOCKED_NAMES = new Set([...SERVICE_NAMES, ...EXAMPLE_NAMES]);

/** Brands phishing pages borrow, anywhere in a name. */
const BRAND_WORDS = `paypal apple icloud google gmail microsoft outlook office365
  sharepoint onedrive amazon netflix facebook instagram whatsapp linkedin
  tiktok telegram yahoo protonmail adobe dropbox docusign bank coinbase
  binance kraken bybit metamask ledger trezor wallet crypto steam roblox
  epicgames playstation discord github stripe klarna revolut mobilepay vipps
  dankort mastercard dhl fedex postnord royalmail hmrc mitid nemid skat eboks
  borger openai chatgpt webhooks mailhooks sharehooks`.split(/\s+/);

/** Words that say a page wants a password or money, anywhere in a name. */
const LURE_WORDS = `login logon signin verify verification payment invoice refund
  recovery unlock airdrop giveaway kyc password`.split(/\s+/);

const BLOCKED_WORDS = [...BRAND_WORDS, ...LURE_WORDS];

/** Digits phishing names write for the letters they look like: g00gle. */
const LOOKALIKES: Record<string, string> = {
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
};

/**
 * The ways a name may read, for finding a word in it: without its hyphens
 * (pay-pal), and with look-alike digits as letters, 1 as l and as i (paypa1,
 * 1cloud).
 */
function readings(name: string): string[] {
  const bare = name.replaceAll("-", "");
  const letters = bare.replace(/[03457]/g, (d) => LOOKALIKES[d]);
  return [...new Set([bare, letters.replaceAll("1", "l"), letters.replaceAll("1", "i")])];
}

/** Whether a word is in a name, however it is written there. */
export function hasWord(name: string, word: string): boolean {
  return readings(name).some((r) => r.includes(word));
}

export const UNAVAILABLE = "That name is not available.";

/** What is wrong with a name's shape, if anything. */
export function nameShapeProblem(name: string): string | null {
  if (!NAME_PATTERN.test(name))
    return "Names are 3 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit.";
  if (name.includes("--")) return "Names cannot have two hyphens in a row.";
  if (name.endsWith(FREE_SUFFIX))
    return `Names ending in ${FREE_SUFFIX} are kept for free previews.`;
  return null;
}

/**
 * Why a name may not be newly kept, by its shape and the lists above. Staff's
 * lists are in nameRefusal (lib/tunnels/names.ts).
 */
export function nameProblem(name: string): string | null {
  const shape = nameShapeProblem(name);
  if (shape) return shape;
  if (BLOCKED_NAMES.has(name) || BLOCKED_WORDS.some((w) => hasWord(name, w))) return UNAVAILABLE;
  return null;
}

/** The lists above, for the operations center to show. */
export const BUILT_IN_BLOCKS = {
  names: [...BLOCKED_NAMES].sort(),
  words: [...BLOCKED_WORDS].sort(),
};

const ADJECTIVES = `amber brisk calm clever coral crisp dusty eager fair gentle
  golden hazy keen lively lucky merry misty nimble olive plain quiet rapid
  rosy sandy shy silver sunny swift tidy warm`.split(/\s+/);
const NOUNS = `badger birch brook canyon cedar comet cove dune falcon fern
  fjord harbor heron lagoon maple meadow otter pebble pine quail raven reef
  ridge river robin sparrow spruce tern tide willow`.split(/\s+/);

function pick<T>(list: T[]): T {
  return list[randomInt(list.length)];
}

/** "amber-badger-0042", or "amber-badger-0042-free" for a free preview. */
export function drawName(free: boolean): string {
  const digits = String(randomInt(10_000)).padStart(4, "0");
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}${free ? FREE_SUFFIX : ""}`;
}

/** Whether a name is one drawName could have drawn for this kind of preview. */
export function isDrawnName(name: string, free: boolean): boolean {
  const parts = /^([a-z]+)-([a-z]+)-(\d{4})(-free)?$/.exec(name);
  if (!parts || !ADJECTIVES.includes(parts[1]) || !NOUNS.includes(parts[2])) return false;
  return Boolean(parts[4]) === free;
}

/** "calm-otter" for https://calm-otter.sharehooks.cc/anything under that host, else null. */
export function previewNameOf(address: string, previewHost: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  let host: string;
  try {
    host = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    ).host.toLowerCase();
  } catch {
    return null;
  }
  const suffix = `.${previewHost.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const name = host.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? name : null;
}
