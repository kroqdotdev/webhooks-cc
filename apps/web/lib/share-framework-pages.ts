import type { FAQItem } from "@/lib/schemas";

/**
 * The /share/[framework] pages: what a developer meets when a framework's dev
 * server is opened through a `whk share` link, one entry per framework.
 *
 * Two kinds of fact, kept apart:
 *
 * - What the framework does (setting names, defaults, messages) comes from
 *   its official documentation, and from its source where the docs do not
 *   print a message. Each entry names the version read and lists its sources;
 *   `checked` is the day they were read. Re-read them before changing a claim.
 * - What the link does to a request comes from apps/edge-rs (main.rs: Host
 *   becomes localhost:<port>, the public name goes in X-Forwarded-Host, a
 *   WebSocket's Origin becomes the local origin, a redirect to
 *   http://localhost:<port> comes back as the public address).
 *
 * Because Host arrives as localhost, the usual tunnel advice ("add the tunnel
 * to the allowed hosts") is wrong for most dev servers here, and right only
 * where a framework reads X-Forwarded-Host or compares a form's Origin. Every
 * entry says which, so do not copy the advice written for other tunnels.
 */

export type ShareFrameworkGroup = "JavaScript" | "Python, Ruby, PHP and Elixir";

export const SHARE_FRAMEWORK_GROUPS: readonly ShareFrameworkGroup[] = [
  "JavaScript",
  "Python, Ruby, PHP and Elixir",
];

export interface ShareFrameworkSection {
  heading: string;
  /** Paragraphs; `backticks` mark code. */
  body: string[];
  snippet?: { file?: string; code: string };
  /** A paragraph after the snippet. */
  after?: string;
}

interface ShareFrameworkEntry {
  label: string;
  group: ShareFrameworkGroup;
  /** The release the facts were read for: "16.4" reads "Next.js 16.4". */
  version: string;
  /** True when a message or default was read from the framework's source. */
  fromSource?: boolean;
  /** The dev server's default port. */
  port: number;
  /** The command that starts the dev server. */
  devCommand: string;
  /** One line for the framework's card on /share. */
  card: string;
  /** The page title; Google cuts titles near 60 characters. */
  title: string;
  description: string;
  h1: string;
  /** The paragraph under the heading. */
  intro: string;
  /** At a glance: the setting to add for the link, or that none is needed. */
  hostSetting: string;
  /** At a glance: what shows when that setting is missing. */
  withoutIt: string;
  /** At a glance: whether hot reload comes through the link. */
  hotReload: string;
  /** At a glance: absolute URLs, trusted proxies and cookies. */
  urlsAndCookies: string;
  sections: ShareFrameworkSection[];
  faq: FAQItem[];
  sources: { label: string; href: string }[];
  keywords: string[];
  /** Day this page's content last changed (YYYY-MM-DD). Drives its sitemap lastmod. */
  updated: string;
}

export interface ShareFrameworkPage extends ShareFrameworkEntry {
  slug: string;
  /** The day the framework's documentation was read, in words. */
  checked: string;
  lastModified: Date;
}

/** The day every entry's sources were read. */
const DOCS_CHECKED = "12 November 2026";

const FRAMEWORKS: Record<string, ShareFrameworkEntry> = {
  nextjs: {
    label: "Next.js",
    group: "JavaScript",
    version: "16.4",
    fromSource: true,
    port: 3000,
    devCommand: "npm run dev",
    card: "Nothing to add: pages, Fast Refresh and Server Actions work as they are. Watch for redirects built from request.url in route handlers.",
    title: "Share a Next.js Dev Server: allowedDevOrigins and HMR",
    description:
      "Run whk share 3000 to put next dev at a public HTTPS link. Why allowedDevOrigins is not needed, how Fast Refresh and Server Actions get through, and the one redirect pattern that sends visitors to localhost.",
    h1: "Share a Next.js dev server at a public URL",
    intro:
      "`next dev` serves your app on `localhost:3000`, and `whk share 3000` gives it an HTTPS link. Pages, Fast Refresh and Server Actions work with an untouched `next.config`, which is not what Next.js's own tunnel advice would lead you to expect.",
    hostSetting:
      "None for `whk share`. `allowedDevOrigins` exists for tunnels that pass the public origin on to dev resources; the link sends those requests with your local origin.",
    withoutIt:
      'Nothing through `whk share`. Other tunnels get `403 Unauthorized` on `/_next/*` and the terminal warning `Blocked cross-origin request to Next.js dev resource ... from "<host>"`.',
    hotReload:
      "Yes. Fast Refresh connects to `/_next/hmr` on the host the page was loaded from, and the socket comes through the link.",
    urlsAndCookies:
      "`request.url` reads `https://localhost:3000/...`; the public name is in the `x-forwarded-host` header. Redirect with paths, not with URLs built from `request.url`.",
    sections: [
      {
        heading: "Why allowedDevOrigins is not needed",
        body: [
          'Since 16.2, `next dev` blocks cross-origin requests to its dev-only assets and endpoints by default. It checks requests under `/_next` and `/__nextjs`, the Fast Refresh socket included, and compares the hostname of the `Origin` header with `localhost` and the entries of `allowedDevOrigins`. A request that fails gets `403` with the body `Unauthorized`, and the terminal prints `Blocked cross-origin request to Next.js dev resource /_next/hmr from "<host>"`, followed by the config to add.',
          "That is why the Next.js docs tell you to list a tunnel's hostname. `whk share` takes the other route: for WebSocket upgrades and for paths under `/_next/` and `/__nextjs`, an `Origin` that is the preview's own address is sent to your dev server as `http://localhost:3000`. A visitor's page is same-origin with those resources, so Next.js sees what it would see from your own browser. Requests from any other site keep their `Origin` and are still refused.",
          "If you use a tunnel that does not do this, or want the entry in place anyway, this is the setting. A `*` stands for exactly one label, which covers every preview name:",
        ],
        snippet: {
          file: "next.config.ts",
          code: `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Not needed for whk share; for tunnels that pass the public Origin on
  allowedDevOrigins: ["*.sharehooks.cc"],
};

export default nextConfig;`,
        },
        after:
          "Entries are hostnames only, without `https://` or a port, and the dev server must be restarted after the change.",
      },
      {
        heading: "Fast Refresh and Server Actions",
        body: [
          "The dev client builds its socket address from `window.location`, so a page opened at `https://<name>.sharehooks.cc` connects to `wss://<name>.sharehooks.cc/_next/hmr` (the path was `/_next/webpack-hmr` before 16.3). WebSockets pass through the link, and edits show up for whoever has the page open. Turbopack is the default bundler in Next.js 16 and needs nothing extra.",
          "Server Actions carry their own CSRF check: Next.js compares the host of the `Origin` header with the app's host, taken from `x-forwarded-host` when present and from `host` otherwise. The link sets `X-Forwarded-Host` to the preview's name, the browser's `Origin` is the same name, and the action runs. `experimental.serverActions.allowedOrigins` is for proxies that do not forward the public host; without that header an action fails with status `500` and `Invalid Server Actions request.`",
        ],
      },
      {
        heading: "request.url says localhost",
        body: [
          "Inside a route handler, `request.url` and `request.nextUrl.origin` use the dev server's own hostname with the scheme from `X-Forwarded-Proto`: `https://localhost:3000/...`. The public name is only in the `x-forwarded-host` header. A redirect built the usual way, `NextResponse.redirect(new URL(\"/login\", request.url))`, therefore answers with `Location: https://localhost:3000/login`, and the visitor's browser tries their own machine.",
          "Redirects from `proxy.ts` (middleware), `redirect()` from `next/navigation` and any `Location` that is a path are sent as paths and work. In a route handler, redirect to a path, or build the origin from the forwarded headers, which is also right behind a production proxy:",
        ],
        snippet: {
          file: "app/api/go/route.ts",
          code: `import { NextResponse, type NextRequest } from "next/server";

export function GET(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  return NextResponse.redirect(new URL("/login", \`\${proto}://\${host}\`));
}`,
        },
        after:
          "The same goes for absolute URLs you hand to someone else: an OAuth callback, a link in an email. In development `metadataBase` falls back to `http://localhost:3000`, so Open Graph image URLs point at localhost until you set it.",
      },
      {
        heading: "Images from next/image",
        body: [
          "The image optimizer answers `/_next/image` with `Content-Disposition: attachment` (the default of `images.contentDispositionType`). A share does not hand out downloads, with one exception made for exactly this: an image a page loads into an `<img>` is passed on. Pages render normally; opening an optimized image's URL on its own in a tab is refused.",
        ],
      },
    ],
    faq: [
      {
        question: "Do I need allowedDevOrigins to use a tunnel with Next.js?",
        answer:
          'With whk share, no: requests to dev resources reach next dev with your local origin, so the default check passes. With a tunnel that forwards the public Origin, yes: add its hostname, for example allowedDevOrigins: ["*.sharehooks.cc"], to next.config and restart the dev server.',
      },
      {
        question: 'What does "Blocked cross-origin request to Next.js dev resource" mean?',
        answer:
          "Since Next.js 16.2 the dev server refuses requests to /_next and /__nextjs paths whose Origin hostname is not localhost or listed in allowedDevOrigins. The request gets 403 Unauthorized and the terminal prints that warning with the hostname to add. Earlier versions only warned.",
      },
      {
        question: "Does Fast Refresh work through a public link?",
        answer:
          "Yes. The dev client opens its WebSocket to the host the page was loaded from, at /_next/hmr, and whk share carries WebSockets. A page someone has open updates as you save.",
      },
      {
        question: "Why does my Next.js redirect go to localhost behind a tunnel?",
        answer:
          "request.url in a route handler uses the dev server's hostname, so new URL(path, request.url) is a localhost URL. Redirect to a path instead, or build the origin from the x-forwarded-host and x-forwarded-proto headers.",
      },
      {
        question: "Do Server Actions work through the link?",
        answer:
          "Yes. Next.js compares the form's Origin host with x-forwarded-host, and whk share sets that header to the preview's name, so the check passes without serverActions.allowedOrigins.",
      },
    ],
    sources: [
      {
        label: "next.config.js: allowedDevOrigins",
        href: "https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins",
      },
      {
        label: "next.config.js: serverActions (allowedOrigins)",
        href: "https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions",
      },
      {
        label: "next CLI: next dev, port and hostname",
        href: "https://nextjs.org/docs/app/api-reference/cli/next",
      },
      {
        label: "block-cross-site-dev.ts in Next.js 16.4 (the check and its message)",
        href: "https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/lib/router-utils/block-cross-site-dev.ts",
      },
      {
        label: "Image component: contentDispositionType",
        href: "https://nextjs.org/docs/app/api-reference/components/image",
      },
    ],
    keywords: [
      "nextjs alloweddevorigins",
      "next dev tunnel",
      "share nextjs localhost",
      "blocked cross-origin request next.js dev resource",
      "nextjs ngrok hmr",
      "expose next dev to internet",
      "nextjs server actions tunnel",
    ],
    updated: "2026-11-12",
  },
  vite: {
    label: "Vite",
    group: "JavaScript",
    version: "8.3",
    fromSource: true,
    port: 5173,
    devCommand: "npm run dev",
    card: "React, Vue and Svelte templates alike. Nothing to add: server.allowedHosts is checked against Host, and HMR dials the page's own address.",
    title: "Share a Vite Dev Server: allowedHosts, HMR and Port 5173",
    description:
      "Run whk share 5173 to put a Vite dev server (React, Vue or Svelte) at a public HTTPS link. Why Blocked request. This host is not allowed does not appear, how HMR connects through the link, and when server.allowedHosts is still the answer.",
    h1: "Share a Vite dev server at a public URL",
    intro:
      "`npm run dev` serves a Vite app on `localhost:5173`, whichever template it started from: React, Vue or Svelte. `whk share 5173` gives that port an HTTPS link, and hot module replacement keeps working for whoever has the page open.",
    hostSetting:
      "None for `whk share`. `server.allowedHosts` is checked against the `Host` header, which arrives as `localhost:5173`.",
    withoutIt:
      'Nothing through `whk share`. Other tunnels get `403` and `Blocked request. This host ("<host>") is not allowed.`',
    hotReload:
      "Yes. The HMR client opens its WebSocket to the host and port the page was loaded from, and the link carries it.",
    urlsAndCookies:
      "Nothing to set for a client-rendered app. An API on another port is not reachable through one share: put it behind `server.proxy`.",
    sections: [
      {
        heading: "Why the host check passes",
        body: [
          'Vite responds only to hosts it knows. `localhost`, domains under `.localhost` and all IP addresses are allowed by default; a request with any other `Host` gets status `403` and the text `Blocked request. This host ("<host>") is not allowed.`, followed by the instruction to add that host to `server.allowedHosts` in `vite.config.js`. Most tunnels pass their public hostname as `Host`, which is how people meet that message.',
          "`whk share` sends `Host: localhost:5173` and carries the public name in `X-Forwarded-Host`, which Vite does not look at. The check passes with an untouched `vite.config`, for the React, Vue and Svelte templates alike: all three run plain `vite` with no `server` block.",
          "For a proxy that does send the public `Host`, the setting takes a leading dot for a domain and its subdomains:",
        ],
        snippet: {
          file: "vite.config.ts",
          code: `import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Not needed for whk share; for proxies that send the public Host
    allowedHosts: [".sharehooks.cc"],
  },
});`,
        },
        after:
          "Do not reach for `allowedHosts: true`. Vite's docs warn that it lets any website send requests to your dev server through DNS rebinding and download your source code.",
      },
      {
        heading: "HMR through the link",
        body: [
          "Unless told otherwise, Vite's client builds its WebSocket address from the URL its own script was loaded from. A page opened at `https://<name>.sharehooks.cc` connects to `wss://<name>.sharehooks.cc/` with the token Vite put in the page, the link carries the socket to your dev server, and the server accepts it: it checks the `Host` header and that token.",
          "If you once set `server.hmr.port`, `server.hmr.clientPort` or `server.hmr.host` for another proxy (named `server.ws` since Vite 8.1; the old names still work), take them out for sharing. A share is one port, and a client told to dial a different one will not find it. When the socket cannot connect, the client tries the dev server's own address directly, which on a visitor's machine is their localhost: the page works, the console shows `[vite] failed to connect to websocket`, and updates stop arriving.",
        ],
      },
      {
        heading: "Ports, IPv6 and vite preview",
        body: [
          "The default port is `5173`. If it is taken, Vite moves to the next free port unless `server.strictPort` is set, so share the port Vite prints.",
          "Vite listens on `localhost`, which on many systems means the IPv6 address `::1` and nothing on `127.0.0.1`. `whk share 5173` tries IPv4 and then IPv6, so it reaches the server either way. `whk share 127.0.0.1:5173` connects to IPv4 only and can report that nothing is running while Vite is up.",
          "`vite preview` serves the production build on port `4173` and checks hosts the same way (`preview.allowedHosts` defaults to `server.allowedHosts`). `whk share 4173` shares the build.",
        ],
      },
      {
        heading: "An API on another port",
        body: [
          "A page loaded from the link can only reach what is on the shared port. If your frontend calls `http://localhost:8000` directly, that address is the visitor's own machine. Route the API through the dev server with `server.proxy`, so the browser asks the link for `/api/...` and Vite passes it on locally. The page and its API are then one origin, and `server.cors`, whose default allows only localhost origins, does not come into it.",
        ],
      },
    ],
    faq: [
      {
        question: "Do I need server.allowedHosts to share a Vite dev server?",
        answer:
          'Not with whk share: Vite receives Host: localhost:5173, which is allowed by default. With a tunnel or reverse proxy that passes its public hostname as Host, add it, for example allowedHosts: [".example.com"].',
      },
      {
        question: 'What does "Blocked request. This host is not allowed" mean in Vite?',
        answer:
          "Since Vite 6.0.9 (and 5.4.12 and 4.5.6) the dev server answers only localhost, .localhost domains, IP addresses and the hosts listed in server.allowedHosts. A request with another Host header gets 403 and that message, which names the host to add.",
      },
      {
        question: "Does Vite HMR work over a public link?",
        answer:
          "Yes. By default the HMR client connects its WebSocket to the host and port the page came from, and whk share passes WebSockets through. Remove any server.hmr port or host overrides made for another proxy.",
      },
      {
        question: "Does this cover React, Vue and Svelte projects?",
        answer:
          "Yes. The create-vite templates for React, Vue and Svelte all start the same dev server with npm run dev on port 5173 and no server settings of their own, so they behave the same through the link.",
      },
    ],
    sources: [
      {
        label: "Server options: server.allowedHosts",
        href: "https://vite.dev/config/server-options#server-allowedhosts",
      },
      {
        label: "Server options: server.ws (HMR socket) and reverse proxies",
        href: "https://vite.dev/config/server-options#server-ws",
      },
      {
        label: "Server options: server.host and server.port",
        href: "https://vite.dev/config/server-options#server-host",
      },
      {
        label: "Preview options: preview.allowedHosts",
        href: "https://vite.dev/config/preview-options",
      },
      {
        label: "hostCheck.ts in Vite 8.3 (the blocked message)",
        href: "https://github.com/vitejs/vite/blob/v8.3.8/packages/vite/src/node/server/middlewares/hostCheck.ts",
      },
      {
        label: "Security advisory GHSA-vg6x-rcgg-rjx6",
        href: "https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6",
      },
    ],
    keywords: [
      "vite allowedhosts",
      "vite blocked request this host is not allowed",
      "share vite dev server",
      "vite ngrok hmr",
      "vite server.allowedhosts tunnel",
      "expose vite to internet",
      "react vite localhost public url",
    ],
    updated: "2026-11-12",
  },
  nuxt: {
    label: "Nuxt",
    group: "JavaScript",
    version: "4.6",
    fromSource: true,
    port: 3000,
    devCommand: "npm run dev",
    card: "Nothing to add: HMR shares the dev server's port. Server-side useRequestURL() says localhost until you opt into the forwarded host.",
    title: "Share a Nuxt Dev Server: HMR, Hosts and useRequestURL",
    description:
      "Run whk share 3000 to put nuxt dev at a public HTTPS link. The host check passes, HMR uses the same port as the page, and useRequestURL needs xForwardedHost to return the public address on the server.",
    h1: "Share a Nuxt dev server at a public URL",
    intro:
      "`nuxt dev` serves your app on `localhost:3000`, and `whk share 3000` gives it an HTTPS link. Pages and HMR come through without a setting. The one surprise is server-side: the URL Nuxt reports while rendering is not the one in the visitor's address bar.",
    hostSetting:
      "None for `whk share`. Nuxt's dev server checks the `Host` header, which arrives as `localhost:3000`.",
    withoutIt:
      'Nothing through `whk share`. Other tunnels get `403` and Vite\'s `Blocked request. This host ("<host>") is not allowed.`',
    hotReload:
      "Yes. In Nuxt 4 the HMR WebSocket is attached to the dev server itself, so it uses the same port as the page.",
    urlsAndCookies:
      "On the server `useRequestURL()` returns `https://localhost:3000/...`; in the browser it returns the public URL. Pass `{ xForwardedHost: true }` to make them agree.",
    sections: [
      {
        heading: "The host check and HMR",
        body: [
          "Nuxt's dev server is Vite and Nitro behind the Nuxt CLI. Both Vite and the CLI's own pages accept `localhost`, names under `.localhost` and IP addresses, and refuse any other `Host` with `403`: Vite's text is `Blocked request. This host (\"<host>\") is not allowed.`, the CLI's is `Forbidden: this host is not allowed.` Through `whk share` the `Host` is `localhost:3000`, so neither appears.",
          "The HMR socket is where older Nuxt setups broke behind one-port proxies: it used a port of its own, 24678. Nuxt 4 attaches Vite's HMR WebSocket to the main dev server, at `/_nuxt/` on the page's port, and the client dials the host the page was loaded from. A page opened through the link keeps receiving updates.",
          "For a proxy that passes the public hostname on, the setting is Vite's, set through Nuxt:",
        ],
        snippet: {
          file: "nuxt.config.ts",
          code: `export default defineNuxtConfig({
  vite: {
    server: {
      // Not needed for whk share; for proxies that send the public Host
      allowedHosts: [".sharehooks.cc"],
    },
  },
});`,
        },
      },
      {
        heading: "useRequestURL() on the server",
        body: [
          "During server rendering, `useRequestURL()` takes the scheme from `X-Forwarded-Proto` and the host from the `Host` header, so it returns `https://localhost:3000/...`. In the browser the same call reads the address bar and returns `https://<name>.sharehooks.cc/...`. Render that value into the page (a canonical link, a share URL) and the server and client disagree.",
          "Nuxt does not trust `X-Forwarded-Host` unless asked. The option is on the composable and on the server utilities it wraps:",
        ],
        snippet: {
          code: `// In a component or page
const url = useRequestURL({ xForwardedHost: true });

// In a server route
const url = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true });`,
        },
        after:
          "Nuxt's docs attach a condition: trust those headers only behind a proxy you control that overwrites them. The link sets `X-Forwarded-Host` and `X-Forwarded-Proto` itself on every request. The same goes for the visitor's address: `getRequestIP(event)` ignores `X-Forwarded-For` unless called with `{ xForwardedFor: true }`.",
      },
      {
        heading: "Ports and nuxt dev --tunnel",
        body: [
          "The port is `3000` unless `NUXT_PORT`, `NITRO_PORT` or `PORT` is set, in that order, or `devServer.port` or `--port` says otherwise. If the port is busy Nuxt picks another unless `--strictPort` is given, so share the one it prints.",
          "Nuxt's CLI has a tunnel flag of its own, `nuxt dev --tunnel`, which opens a Cloudflare quick tunnel. `whk share` is for when you want the same link each time (a reserved name), a password on it, or to see what visitors requested with `whk shares log`.",
        ],
      },
    ],
    faq: [
      {
        question: "Does Nuxt HMR work through a tunnel?",
        answer:
          "With Nuxt 4, yes: the HMR WebSocket is served by the dev server on the same port as the page, at /_nuxt/, and the client connects to the host the page came from. Older setups that used a separate HMR port (24678) do not work through a one-port tunnel.",
      },
      {
        question: "Do I need to set allowedHosts in nuxt.config for whk share?",
        answer:
          "No. The dev server receives Host: localhost:3000, which is always allowed. For proxies that pass the public hostname as Host, set vite.server.allowedHosts in nuxt.config, with a leading dot to cover subdomains.",
      },
      {
        question: "Why does useRequestURL return localhost on the server?",
        answer:
          "It builds the URL from the Host header and does not trust X-Forwarded-Host by default. Behind whk share, call useRequestURL({ xForwardedHost: true }) so the server returns the public address like the browser does.",
      },
      {
        question: "Which port does nuxt dev use?",
        answer:
          "3000 by default. NUXT_PORT, NITRO_PORT and PORT override it in that order, as do devServer.port in nuxt.config and the --port flag.",
      },
    ],
    sources: [
      {
        label: "nuxt dev: port, host, --tunnel and --public",
        href: "https://nuxt.com/docs/4.x/api/commands/dev",
      },
      {
        label: "nuxt.config: devServer",
        href: "https://nuxt.com/docs/4.x/api/nuxt-config#devserver",
      },
      { label: "useRequestURL", href: "https://nuxt.com/docs/4.x/api/composables/use-request-url" },
      {
        label: "Server utilities: getRequestURL and trusting forwarded headers",
        href: "https://nuxt.com/docs/4.x/guide/going-further/server-imports",
      },
      {
        label: "dev-server.ts in Nuxt 4.6 (HMR attached to the dev server)",
        href: "https://github.com/nuxt/nuxt/blob/v4.6.4/packages/vite/src/plugins/dev-server.ts",
      },
      {
        label: "Vite: server.allowedHosts",
        href: "https://vite.dev/config/server-options#server-allowedhosts",
      },
    ],
    keywords: [
      "nuxt dev tunnel",
      "share nuxt localhost",
      "nuxt hmr behind proxy",
      "nuxt allowedhosts",
      "userequesturl localhost",
      "expose nuxt dev server to internet",
    ],
    updated: "2026-11-12",
  },
  sveltekit: {
    label: "SvelteKit",
    group: "JavaScript",
    version: "3.2",
    fromSource: true,
    port: 5173,
    devCommand: "npm run dev",
    card: "Nothing to add in dev: the CSRF origin check only runs in production builds. Sharing npm run preview needs paths.origin.",
    title: "Share a SvelteKit Dev Server: Forms, CSRF and Port 5173",
    description:
      "Run whk share 5173 to put a SvelteKit dev server at a public HTTPS link. Form actions work in dev, HMR comes through, and sharing a production preview needs paths.origin to avoid Cross-site POST form submissions are forbidden.",
    h1: "Share a SvelteKit dev server at a public URL",
    intro:
      "`npm run dev` serves a SvelteKit app on `localhost:5173` through Vite, and `whk share 5173` gives it an HTTPS link. In development everything works as it is, form actions included. The setting people look for belongs to production builds, and it matters here only if you share `npm run preview`.",
    hostSetting:
      "None in dev. To share a production build (`npm run preview`), set `paths.origin` to the link. `csrf.trustedOrigins` covers form actions only, not remote functions.",
    withoutIt:
      "In dev, nothing. A shared preview answers form posts with `403` and `Cross-site POST form submissions are forbidden`, and remote function calls with `403` and `Cross-site remote requests are forbidden`.",
    hotReload:
      "Yes. It is Vite's HMR on the dev server's own port, and the client connects to the host the page came from.",
    urlsAndCookies:
      "`event.url.origin` is `http://localhost:5173` on the server. `redirect(303, '/path')` and relative links work; `paths.origin` tells a build its public origin.",
    sections: [
      {
        heading: "Development needs nothing",
        body: [
          "A SvelteKit project is a Vite project, so the host check is Vite's: `localhost` is always allowed, and `whk share` sends `Host: localhost:5173`. Pages, server `load` functions and HMR come through with no configuration.",
          "Form actions do too. SvelteKit protects them against cross-site posts by comparing the request's `Origin` with its own, but in the words of its docs, CSRF checks only apply in production, not in local development. A form posted through the link reaches your action in `npm run dev`.",
        ],
      },
      {
        heading: "Sharing a production preview",
        body: [
          "`npm run build` and `npm run preview` serve the built app on port `4173`, and there the check is live. SvelteKit derives its own origin from the `Host` header, `http://localhost:4173`, while the browser sends `Origin: https://<name>.sharehooks.cc`. The post is refused with status `403` and `Cross-site POST form submissions are forbidden`. The response has no content type; the link shows it as plain text so you can read it.",
          "Tell SvelteKit the app's public origin with `paths.origin`. That fixes both kinds of post. `csrf.trustedOrigins` also lets form actions through, but not remote `form` and `command` functions: a production build refuses those from any other origin with `403` and `Cross-site remote requests are forbidden`, whatever `trustedOrigins` says. In SvelteKit 3 both are options of the `sveltekit()` plugin in `vite.config`:",
        ],
        snippet: {
          file: "vite.config.ts",
          code: `import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      // Say where the app is served from: covers form actions and remote functions
      paths: { origin: "https://acme.sharehooks.cc" },
      // Or, for form actions only (remote functions stay refused):
      // csrf: { trustedOrigins: ["https://acme.sharehooks.cc"] },
    }),
  ],
});`,
        },
        after:
          "Either value is a complete origin and is matched exactly: `https://*.sharehooks.cc` does not work. A random name changes every session, so this is one place where a reserved name earns its keep (`whk share 4173 --name acme`). `trustedOrigins: ['*']` turns the check off for every site and is not something to leave in. Rebuild after changing either option.",
      },
      {
        heading: "What the server believes about its URL",
        body: [
          "In dev and in preview, `event.url` is built from the `Host` header, so server code sees `http://localhost:5173` and `event.getClientAddress()` returns your own machine's address. Relative links, `redirect(303, '/login')` and `fetch` inside `load` are unaffected.",
          "The environment variables for running behind a proxy (`ORIGIN`, `PROTOCOL_HEADER`, `HOST_HEADER`, `ADDRESS_HEADER`) belong to `adapter-node`'s built server, started with `node build`, which listens on port `3000`. They have no effect on `vite dev` or `vite preview`. If you share a `node build` server, `ORIGIN=https://acme.sharehooks.cc node build` gives it the public origin, unless `paths.origin` is set, which takes precedence.",
        ],
      },
    ],
    faq: [
      {
        question: "How do I fix Cross-site POST form submissions are forbidden behind a tunnel?",
        answer:
          "The built app thinks its origin is localhost while the form's Origin is the tunnel's address. Set paths.origin to the tunnel's full origin, for example \"https://acme.sharehooks.cc\"; with adapter-node you can set the ORIGIN environment variable instead. csrf.trustedOrigins also works for form actions, but remote functions ignore it and answer Cross-site remote requests are forbidden. Wildcards are not matched.",
      },
      {
        question: "Do SvelteKit form actions work through a tunnel in dev?",
        answer:
          "Yes. SvelteKit's CSRF origin check runs only in production builds, so in npm run dev a form posted from the public link reaches the action.",
      },
      {
        question: "Can I still set csrf.checkOrigin to false?",
        answer:
          "Not in SvelteKit 3. The option was removed in favour of csrf.trustedOrigins, and setting it stops the dev server with a configuration error. Trust the specific origin you need instead.",
      },
      {
        question: "Does HMR work when I share a SvelteKit dev server?",
        answer:
          "Yes. HMR is Vite's, on the same port as the app, and its client connects to the host the page was loaded from, so updates reach pages opened through the link.",
      },
    ],
    sources: [
      {
        label: "SvelteKit configuration: csrf.trustedOrigins",
        href: "https://svelte.dev/docs/kit/@sveltejs-kit-vite#csrf",
      },
      {
        label: "SvelteKit configuration: paths.origin",
        href: "https://svelte.dev/docs/kit/@sveltejs-kit-vite#paths",
      },
      {
        label: "Migrating to SvelteKit 3",
        href: "https://svelte.dev/docs/kit/migrating-to-sveltekit-3",
      },
      {
        label: "adapter-node: ORIGIN, PROTOCOL_HEADER and HOST_HEADER",
        href: "https://svelte.dev/docs/kit/adapter-node",
      },
      {
        label: "Creating a project: npm run dev on localhost:5173",
        href: "https://svelte.dev/docs/kit/creating-a-project",
      },
      {
        label: "respond.js in SvelteKit 3.2 (the check and its message)",
        href: "https://github.com/sveltejs/kit/blob/%40sveltejs/kit%403.2.0/packages/kit/src/runtime/server/respond.js",
      },
    ],
    keywords: [
      "cross-site post form submissions are forbidden",
      "sveltekit csrf trustedorigins",
      "sveltekit tunnel",
      "share sveltekit localhost",
      "sveltekit origin behind proxy",
      "sveltekit ngrok form actions",
    ],
    updated: "2026-11-12",
  },
  astro: {
    label: "Astro",
    group: "JavaScript",
    version: "7.4",
    fromSource: true,
    port: 4321,
    devCommand: "npm run dev",
    card: "Nothing to add for pages and HMR. security.allowedDomains makes Astro.url the public address and settles form posts from non-browser clients.",
    title: "Share an Astro Dev Server: allowedHosts and checkOrigin",
    description:
      "Run whk share 4321 to put astro dev at a public HTTPS link. The host check passes, HMR comes through, browser form posts pass security.checkOrigin, and security.allowedDomains makes Astro.url use the public address.",
    h1: "Share an Astro dev server at a public URL",
    intro:
      "`astro dev` serves your site on `localhost:4321`, and `whk share 4321` gives it an HTTPS link. Static pages, on-demand pages and HMR work without configuration. One optional setting makes Astro aware of the public address.",
    hostSetting:
      "None for `whk share`. `server.allowedHosts` is checked against `Host`, which arrives as `localhost:4321`.",
    withoutIt:
      'Nothing through `whk share`. Other tunnels get `403` and `Blocked request. This host ("<host>") is not allowed.`',
    hotReload:
      "Yes. It is Vite's HMR on the dev server's own port, and the client connects to the host the page came from.",
    urlsAndCookies:
      "`Astro.url` is a `localhost` URL in dev. `security.allowedDomains` lets Astro take the host and scheme from `X-Forwarded-Host` and `X-Forwarded-Proto`.",
    sections: [
      {
        heading: "server.allowedHosts and astro dev",
        body: [
          'Astro passes `server.allowedHosts` to Vite, which answers `localhost`, names under `.localhost` and IP addresses, and refuses any other `Host` with `403` and `Blocked request. This host ("<host>") is not allowed.` Through `whk share` the dev server gets `Host: localhost:4321`, so the default, an empty list, is enough.',
          "For a proxy that passes its public hostname on, the setting goes in `astro.config.mjs`, or on the command line as `--allowed-hosts`. It applies to `astro dev` and `astro preview` alike:",
        ],
        snippet: {
          file: "astro.config.mjs",
          code: `import { defineConfig } from "astro/config";

export default defineConfig({
  server: {
    // Not needed for whk share; for proxies that send the public Host
    allowedHosts: [".sharehooks.cc"],
  },
});`,
        },
      },
      {
        heading: "Forms and security.checkOrigin",
        body: [
          "For pages rendered on demand in a project built for a server (one with an adapter), Astro checks that form posts come from the same site (`security.checkOrigin`, on by default). It reads the browser's `Sec-Fetch-Site` header first, and a form on a shared page posting to the same link is `same-origin`, so it passes even though Astro itself believes it is on `localhost`.",
          "The fallback is where a share can trip. A client that sends no `Sec-Fetch-Site` header (a script, an old browser) is judged by its `Origin`, compared with the URL Astro derived from `Host`: `https://<name>.sharehooks.cc` against `http://localhost:4321`. That post gets `403` and `Cross-site POST form submissions are forbidden`.",
        ],
      },
      {
        heading: "Make Astro.url the public address",
        body: [
          "In dev `Astro.url` is a `localhost` URL: Astro builds it from the `Host` header and ignores `X-Forwarded-Host` unless you allow the domain. With `security.allowedDomains`, a forwarded host that matches a pattern is used, along with the forwarded scheme:",
        ],
        snippet: {
          file: "astro.config.mjs",
          code: `import { defineConfig } from "astro/config";

export default defineConfig({
  security: {
    // Trust X-Forwarded-Host for previews opened with whk share
    allowedDomains: [{ hostname: "**.sharehooks.cc", protocol: "https" }],
  },
});`,
        },
        after:
          "`**.sharehooks.cc` matches every name under the domain, so every preview; with a reserved name, write that name out instead. `Astro.url` and `request.url` then read `https://<name>.sharehooks.cc/...`, and the origin check compares like with like, for every client. A forwarded host outside the list is ignored. The `site` option is a different thing: it is your deployed URL, used for canonical links and the sitemap in a build.",
      },
    ],
    faq: [
      {
        question: "Do I need server.allowedHosts to share an Astro dev server?",
        answer:
          'Not with whk share: the dev server receives Host: localhost:4321, which is always allowed. With a tunnel that passes its public hostname as Host, add it to server.allowedHosts in astro.config.mjs, for example [".example.com"], or pass --allowed-hosts.',
      },
      {
        question: "Why do I get Cross-site POST form submissions are forbidden in Astro?",
        answer:
          "security.checkOrigin found a form post whose origin differs from the URL Astro thinks it is served from. Behind a proxy, add the public domain to security.allowedDomains so Astro takes its host from X-Forwarded-Host. Browsers that send Sec-Fetch-Site: same-origin pass the check without it.",
      },
      {
        question: "Does Astro HMR work through a public link?",
        answer:
          "Yes. Astro uses Vite's HMR on the same port as the site, and the client opens its WebSocket to the host the page was loaded from, so whk share carries it.",
      },
      {
        question: "Which port does astro dev use?",
        answer:
          "4321 by default. If it is in use, Astro tries the next available port, so share the port it prints. server.port in the config or --port on the command line sets another.",
      },
    ],
    sources: [
      {
        label: "Configuration reference: server.allowedHosts",
        href: "https://docs.astro.build/en/reference/configuration-reference/#serverallowedhosts",
      },
      {
        label: "Configuration reference: security.checkOrigin",
        href: "https://docs.astro.build/en/reference/configuration-reference/#securitycheckorigin",
      },
      {
        label: "Configuration reference: security.allowedDomains",
        href: "https://docs.astro.build/en/reference/configuration-reference/#securityalloweddomains",
      },
      {
        label: "CLI reference: astro dev and --allowed-hosts",
        href: "https://docs.astro.build/en/reference/cli-reference/#astro-dev",
      },
      {
        label: "origin-check.ts in Astro 7.4 (the check and its message)",
        href: "https://github.com/withastro/astro/blob/astro@7.4.11/packages/astro/src/core/app/origin-check.ts",
      },
    ],
    keywords: [
      "astro allowedhosts",
      "astro dev tunnel",
      "share astro localhost",
      "astro checkorigin proxy",
      "astro alloweddomains x-forwarded-host",
      "expose astro dev server to internet",
    ],
    updated: "2026-11-12",
  },
  angular: {
    label: "Angular",
    group: "JavaScript",
    version: "22",
    fromSource: true,
    port: 4200,
    devCommand: "ng serve",
    card: "Nothing to add: ng serve checks Host, which arrives as localhost, and live reload shares the port. SSR apps log a proxy header notice.",
    title: "Share an Angular Dev Server: allowedHosts and ng serve",
    description:
      "Run whk share 4200 to put ng serve at a public HTTPS link. Why the Blocked request page does not appear, where allowedHosts goes in angular.json, how live reload connects, and what SSR apps log about proxy headers.",
    h1: "Share an Angular dev server at a public URL",
    intro:
      "`ng serve` listens on `localhost:4200`, and `whk share 4200` gives it an HTTPS link. The dev server's host check and its live reload both work through the link without touching `angular.json`.",
    hostSetting:
      "None for `whk share`. `allowedHosts` under the `serve` target is checked against `Host`, which arrives as `localhost:4200`.",
    withoutIt:
      'Nothing through `whk share`. Other tunnels get a `403` page: `Blocked request. This host ("<host>") is not allowed.`',
    hotReload:
      "Yes. Live reload and HMR use a WebSocket on the dev server's own port, and the client connects to the host the page came from.",
    urlsAndCookies:
      "A browser-rendered app builds its URLs from the address bar, so nothing to set. With SSR, `X-Forwarded-*` headers are ignored unless `trustProxyHeaders` allows them.",
    sections: [
      {
        heading: "allowedHosts in angular.json",
        body: [
          'Angular\'s dev server is built on Vite and answers `localhost`, names under `.localhost` and IP addresses. A request with any other `Host` gets a `403` page that reads `Blocked request. This host ("<host>") is not allowed.` and tells you to add the host to `allowedHosts` under the `serve` target in `angular.json`.',
          "`whk share` sends `Host: localhost:4200`, so the check passes with the default configuration. If you work with a tunnel that passes the public hostname on, this is where the setting goes:",
        ],
        snippet: {
          file: "angular.json",
          code: `"serve": {
  "options": {
    "allowedHosts": [".sharehooks.cc"]
  }
}`,
        },
        after:
          "The same value can be given on the command line as `--allowed-hosts`. The older `--disable-host-check` and `--public-host` flags belong to the legacy webpack builder and are not options of the current one.",
      },
      {
        heading: "Live reload and HMR",
        body: [
          "`ng serve` reloads the page on change, and replaces styles and templates in place where it can; both are on by default. The messages travel over Vite's WebSocket on the dev server's own port, and the client opens it to the host the page was loaded from, so a page opened through the link connects through the link.",
          "`ng serve` listens on `localhost`, which on many machines is the IPv6 address `::1` only. `whk share 4200` tries IPv4 and then IPv6, so it finds the server either way; `whk share 127.0.0.1:4200` connects to IPv4 alone and may find nothing. If the `PORT` environment variable is set, it takes precedence over `--port`, so share the port `ng serve` prints.",
        ],
      },
      {
        heading: "Server-side rendering and proxy headers",
        body: [
          'An app with `@angular/ssr` validates request headers before rendering. `Host: localhost:4200` is accepted. The forwarded headers the link adds are treated as untrusted and removed, and the terminal says so on each request: `Received "x-forwarded-host" header but "trustProxyHeaders" was not set up to allow it.` The page still renders; the server simply believes it is on `localhost`.',
          "That only matters if server-rendered output contains absolute URLs. To have the server use the public address, the security guide's `trustProxyHeaders` option allows chosen headers (its example is `['x-forwarded-host', 'x-forwarded-proto']`), and a forwarded host that is trusted must be an allowed host as well. Angular's docs advise this only behind a proxy that overwrites those headers; the link sets `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For` itself on every request, so trust those and no others.",
        ],
      },
    ],
    faq: [
      {
        question: 'How do I fix "Blocked request. This host is not allowed" in Angular?',
        answer:
          'Add the hostname to allowedHosts under the serve target\'s options in angular.json, for example "allowedHosts": [".example.com"], or pass --allowed-hosts to ng serve. With whk share the page does not appear, because the dev server receives Host: localhost.',
      },
      {
        question: "Does ng serve still have --disable-host-check?",
        answer:
          "Not in the current builder. In Angular 22 the dev server (@angular/build:dev-server) has allowedHosts, which sets the Vite option of the same name. --disable-host-check and --public-host remain only in the legacy webpack-based builder.",
      },
      {
        question: "Does Angular live reload work through a public link?",
        answer:
          "Yes. The reload and HMR messages use a WebSocket on the same port as the app, and the client connects to the host the page was loaded from, so they pass through whk share.",
      },
      {
        question: "Which port does ng serve use?",
        answer:
          "4200 by default. ng serve --port 4300 changes it, and a PORT environment variable takes precedence over the option.",
      },
    ],
    sources: [
      {
        label: "ng serve: --allowed-hosts, --port, --host, --hmr",
        href: "https://angular.dev/cli/serve",
      },
      {
        label: "Workspace configuration: allowedHosts for the dev server",
        href: "https://angular.dev/reference/configs/workspace-config#extra-serve-options",
      },
      {
        label: "Security: validating Host and X-Forwarded headers in SSR",
        href: "https://angular.dev/best-practices/security#preventing-server-side-request-forgery-ssrf",
      },
      {
        label: "host-check-middleware.ts in Angular CLI 22 (the blocked page)",
        href: "https://github.com/angular/angular-cli/blob/v22.2.7/packages/angular/build/src/tools/vite/middlewares/host-check-middleware.ts",
      },
    ],
    keywords: [
      "angular allowedhosts",
      "ng serve disable host check",
      "angular blocked request this host is not allowed",
      "share angular localhost",
      "ng serve tunnel",
      "expose ng serve to internet",
    ],
    updated: "2026-11-12",
  },
  express: {
    label: "Express",
    group: "JavaScript",
    version: "5.3",
    port: 3000,
    devCommand: "node app.js",
    card: "No host check to pass. Set trust proxy to loopback so req.protocol, req.hostname, req.ip and secure cookies follow the link.",
    title: "Share an Express App From Localhost: trust proxy, Cookies",
    description:
      "Run whk share 3000 to put a local Express app at a public HTTPS link. Express has no host check; app.set('trust proxy', 'loopback') makes req.protocol, req.hostname, req.ip and secure session cookies follow the link.",
    h1: "Share an Express app at a public URL",
    intro:
      "An Express app listens on the port you give `app.listen`, `3000` in the docs' hello world, and `whk share 3000` gives that port an HTTPS link. Express checks no host, so every route answers at once. What it gets wrong until you tell it about the proxy is the protocol, the hostname and the client address.",
    hostSetting:
      "No host setting. `app.set('trust proxy', 'loopback')` so Express reads `X-Forwarded-*` from the link.",
    withoutIt:
      "No error. `req.protocol` is `http`, `req.hostname` is `localhost`, `req.ip` is `127.0.0.1`, and a session cookie marked `secure: true` is never set.",
    hotReload:
      "Express has no reload of its own. Restart tools restart the server, and visitors see the change on their next request.",
    urlsAndCookies:
      "With `trust proxy`, `req.hostname` and `req.host` are the public name, `req.protocol` is `https` and `req.ip` is the visitor. `req.get('host')` stays `localhost:3000`.",
    sections: [
      {
        heading: "Tell Express it is behind a proxy",
        body: [
          "By default Express treats itself as facing the client directly: `req.protocol` comes from the socket, `req.hostname` from the `Host` header and `req.ip` from the connection. Through the link those are `http`, `localhost` and `127.0.0.1`, because the request reaches your app from `whk` on your own machine.",
          "The `trust proxy` setting tells Express which addresses may speak for the client. `whk` connects from loopback, so trust loopback and nothing wider:",
        ],
        snippet: {
          file: "app.js",
          code: `const express = require("express");
const app = express();

// whk share connects from this machine
app.set("trust proxy", "loopback");`,
        },
        after:
          "Now `req.protocol` is `https`, `req.secure` is `true`, `req.hostname` is `<name>.sharehooks.cc` and `req.ip` is the visitor's address. `req.host` (which keeps a port in Express 5) follows too. `req.get('host')` reads the raw header and still says `localhost:3000`, so build absolute URLs from `req.protocol` and `req.host`.",
      },
      {
        heading: "Secure session cookies",
        body: [
          "`express-session` does not set a cookie marked `secure: true` on a connection it believes is plain HTTP. Without `trust proxy` that is every request through the link, and the symptom is a login that never sticks: the response simply carries no `Set-Cookie`.",
          "With `trust proxy` set as above, the session cookie goes out with `Secure` and the visitor's browser, which is on HTTPS, keeps it. `cookie: { secure: 'auto' }` picks the right value on localhost and on the link alike. Leave the cookie's `domain` unset: a cookie for another domain is dropped on the way out.",
        ],
      },
      {
        heading: "Redirects, WebSockets and reloads",
        body: [
          "`res.redirect('/login')` sends a path, which works on any origin. A redirect to `http://localhost:3000/...` is also returned to the link. WebSocket servers attached to the same HTTP server, `ws` or Socket.IO among them, come through on the same port.",
          "There is no dev server in Express and so no browser reload: tools that restart Node on change restart your app, and a visitor's next request reaches the new code. If nothing is listening during a restart, the visitor gets a short page saying so rather than a broken connection.",
        ],
      },
    ],
    faq: [
      {
        question: "How do I expose a local Express server to the internet?",
        answer:
          "Start the app, then run whk share with its port, for example whk share 3000. The CLI prints an HTTPS link on sharehooks.cc that reaches your app until you press Ctrl-C. Express needs no host setting for requests to be answered.",
      },
      {
        question: "Which trust proxy value should I use with a tunnel on my own machine?",
        answer:
          "loopback. The tunnel client connects from 127.0.0.1 or ::1, and app.set('trust proxy', 'loopback') trusts exactly those addresses. true trusts any address, which lets any client that can reach the port directly forge X-Forwarded headers.",
      },
      {
        question: "Why is my session cookie not set through the tunnel?",
        answer:
          "The cookie is marked secure and Express thinks the request is plain HTTP, because TLS ends at the link. Set trust proxy so X-Forwarded-Proto: https is believed, or use cookie.secure: 'auto' in express-session.",
      },
      {
        question: "Is req.hostname the tunnel's hostname?",
        answer:
          "Only with trust proxy set. Without it req.hostname comes from the Host header, which through whk share is localhost. With it, req.hostname comes from X-Forwarded-Host, the preview's name.",
      },
    ],
    sources: [
      { label: "Express behind proxies", href: "https://expressjs.com/en/guide/behind-proxies/" },
      {
        label: "Express 5 API: req.hostname, req.host, req.protocol, req.ip",
        href: "https://expressjs.com/en/5x/api/request/",
      },
      {
        label: "Hello world example (port 3000)",
        href: "https://expressjs.com/en/starter/hello-world/",
      },
      {
        label: "express-session: cookie.secure and trust proxy",
        href: "https://github.com/expressjs/session/blob/master/README.md",
      },
    ],
    keywords: [
      "express trust proxy tunnel",
      "expose express server to internet",
      "share express localhost",
      "express secure cookie not set proxy",
      "express req.protocol http behind proxy",
      "node localhost public url",
    ],
    updated: "2026-11-12",
  },
  webpack: {
    label: "webpack-dev-server",
    group: "JavaScript",
    version: "6.1",
    fromSource: true,
    port: 8080,
    devCommand: "npx webpack serve",
    card: "No Invalid Host header: the host check sees localhost. Set client.webSocketURL so hot reload uses the link's port.",
    title: "Invalid Host Header? Share webpack-dev-server Without It",
    description:
      "Run whk share 8080 to put webpack-dev-server at a public HTTPS link. Why the Invalid Host header error does not appear, what allowedHosts does, and the client.webSocketURL setting that keeps hot reload working.",
    h1: "Share webpack-dev-server at a public URL",
    intro:
      "`webpack serve` listens on `localhost:8080`, and `whk share 8080` gives it an HTTPS link. The `Invalid Host header` page that tunnels are known for does not appear, because your dev server never sees the public hostname. Hot reload needs one client setting.",
    hostSetting:
      'No host setting: `allowedHosts` is checked against `Host`, which arrives as `localhost:8080`. For hot reload, `client.webSocketURL: "auto://0.0.0.0:0/ws"`.',
    withoutIt:
      "The page and bundles load. Without the socket setting, the hot reload client tries port `8080` on the public name and never connects.",
    hotReload: "Yes, once `client.webSocketURL` lets the client use the page's own host and port.",
    urlsAndCookies:
      "Nothing to set: the dev server serves files and builds no absolute URLs. A backend you reach through `devServer.proxy` sees the dev server as its client.",
    sections: [
      {
        heading: "Why there is no Invalid Host header",
        body: [
          'webpack-dev-server answers only hosts it expects. With the default `allowedHosts: "auto"` those are `localhost`, names under `.localhost`, IP addresses and the configured `host`. Anything else gets status `403` and the body `Invalid Host header`, which is what a tunnel produces when it passes its public hostname through.',
          "`whk share` sends `Host: localhost:8080`, so the default passes and `allowedHosts` can stay as it is. The setting, for tunnels that do need it, takes a leading dot for subdomains:",
        ],
        snippet: {
          file: "webpack.config.js",
          code: `module.exports = {
  devServer: {
    // Not needed for whk share; for tunnels that send the public Host
    allowedHosts: [".sharehooks.cc"],
  },
};`,
        },
        after:
          'Avoid `allowedHosts: "all"`. The webpack docs say it in capitals: a server that does not check the host is open to DNS rebinding attacks.',
      },
      {
        heading: "Point the hot reload client at the page's own address",
        body: [
          "The dev server's socket lives at `/ws` on the same port, and the server checks both `Host` and `Origin` on it; a mismatch closes the socket with `Invalid Host/Origin header`. The link sends a WebSocket's `Origin` as your local origin, so the server side accepts it.",
          "The client side is the catch. The bundle is told which port to dial, and that is the dev server's port: a page opened at `https://<name>.sharehooks.cc` tries `wss://<name>.sharehooks.cc:8080/ws`, a port the link does not have. Tell the client to take protocol, hostname and port from the browser instead:",
        ],
        snippet: {
          file: "webpack.config.js",
          code: `module.exports = {
  devServer: {
    client: {
      // Use the page's own protocol, host and port for the socket
      webSocketURL: "auto://0.0.0.0:0/ws",
    },
  },
};`,
        },
        after:
          "With that, the same config works on `localhost:8080` and through the link: the socket goes to whatever address the page came from.",
      },
      {
        heading: "Cross-origin requests and proxied APIs",
        body: [
          "The dev server also refuses script-tag style requests from other sites (`403` with `Cross-Origin request blocked`) and sets `Cross-Origin-Resource-Policy: same-origin` on what it serves. A visitor's page and its bundles are the same origin on the link, so neither gets in the way.",
          "If your app calls a backend on another port, put it behind `devServer.proxy` so it shares the dev server's origin. A share is one port, and the visitor's browser cannot reach a second one on your machine.",
        ],
      },
    ],
    faq: [
      {
        question: "How do I fix Invalid Host header in webpack-dev-server?",
        answer:
          'The dev server got a Host it does not expect. Add the hostname to devServer.allowedHosts, with a leading dot to cover subdomains, such as allowedHosts: [".example.com"]. With whk share the error does not occur, because the dev server receives Host: localhost.',
      },
      {
        question: "Is allowedHosts: all safe?",
        answer:
          "No. The webpack docs state that bypassing host checking is not recommended, as apps that do not check the host are vulnerable to DNS rebinding attacks. List the hosts you need instead.",
      },
      {
        question: "Why does hot reload not connect through a tunnel?",
        answer:
          "The client was built with the dev server's port and dials that port on the public hostname. Set devServer.client.webSocketURL to auto://0.0.0.0:0/ws so it uses the page's own protocol, hostname and port.",
      },
      {
        question: "Which port does webpack-dev-server use?",
        answer:
          "8080 by default; if it is taken, the server looks for a free one unless you set devServer.port. Share the port printed when the server starts.",
      },
    ],
    sources: [
      {
        label: "DevServer: devServer.allowedHosts",
        href: "https://webpack.js.org/configuration/dev-server/#devserverallowedhosts",
      },
      {
        label: "DevServer: client.webSocketURL",
        href: "https://webpack.js.org/configuration/dev-server/#websocketurl",
      },
      {
        label: "Development guide: webpack-dev-server on localhost:8080",
        href: "https://webpack.js.org/guides/development/",
      },
      {
        label: "Server.js in webpack-dev-server 6.1 (the host and origin checks)",
        href: "https://github.com/webpack/webpack-dev-server/blob/v6.1.0/lib/Server.js",
      },
    ],
    keywords: [
      "invalid host header",
      "invalid host header webpack",
      "webpack dev server allowedhosts",
      "webpack dev server tunnel",
      "webpack dev server hot reload proxy",
      "share webpack dev server",
      "websocketurl auto",
    ],
    updated: "2026-11-12",
  },
  rails: {
    label: "Ruby on Rails",
    group: "Python, Ruby, PHP and Elixir",
    version: "8.1",
    fromSource: true,
    port: 3000,
    devCommand: "bin/rails server",
    card: "Add the preview to config.hosts: Rails checks X-Forwarded-Host as well as Host, and answers Blocked hosts without it.",
    title: "Share a Rails Dev Server: config.hosts and Blocked Hosts",
    description:
      "Run whk share 3000 to put a Rails development server at a public HTTPS link. The config.hosts line that stops the Blocked hosts page, how forms, redirects and Action Cable behave, and what web-console does for visitors.",
    h1: "Share a Rails dev server at a public URL",
    intro:
      "`bin/rails server` listens on `localhost:3000`, and `whk share 3000` gives it an HTTPS link. Rails is one of the few frameworks that needs a line of configuration first, because its host check reads the forwarded host too.",
    hostSetting:
      '`config.hosts << ".sharehooks.cc"` in `config/environments/development.rb`. Rails checks `X-Forwarded-Host` as well as `Host`.',
    withoutIt:
      "A `403` page headed `Blocked hosts: <name>.sharehooks.cc`, and the same words in the server log.",
    hotReload:
      "Rails reloads changed code before the next request, so a visitor sees your edit on their next page load. There is no browser reload in a default app.",
    urlsAndCookies:
      "URLs and redirects use the public name: Rails reads `X-Forwarded-Host` and `X-Forwarded-Proto`. Mailer links stay on `localhost:3000` until `default_url_options` says otherwise.",
    sections: [
      {
        heading: "Allow the preview in config.hosts",
        body: [
          "In development Rails only answers hosts it knows: `localhost`, names under `.localhost` and `.test`, and IP addresses. The link sends `Host: localhost:3000`, which passes, but `ActionDispatch::HostAuthorization` also checks the last value of `X-Forwarded-Host`, and that is your preview's name. So the first request through a share gets `403 Forbidden` and a page that starts `Blocked hosts: <name>.sharehooks.cc`.",
          "Add the domain to the development environment. A leading dot permits the domain and every name under it, so one line covers random names and reserved ones:",
        ],
        snippet: {
          file: "config/environments/development.rb",
          code: `Rails.application.configure do
  # Previews opened with whk share
  config.hosts << ".sharehooks.cc"
end`,
        },
        after:
          'Restart the server afterwards: environment files are read at boot. With a reserved name you can list just that name (`config.hosts << "acme.sharehooks.cc"`), which keeps other people\'s previews out of the list.',
      },
      {
        heading: "Forms, redirects and Action Cable",
        body: [
          "Rails builds `request.base_url` from `X-Forwarded-Host` and `X-Forwarded-Proto`, so inside a request the app believes it is at `https://<name>.sharehooks.cc`. The CSRF origin check (`forgery_protection_origin_check`) compares the form's `Origin` with that, and they match; `redirect_to` and `*_url` helpers point at the link.",
          "Action Cable accepts origins matching `/https?:\\/\\/localhost:\\d+/` in development. The link sends a WebSocket's `Origin` as `http://localhost:3000`, so `/cable` connects without changing `allowed_request_origins`, and Turbo Streams keep arriving.",
        ],
      },
      {
        heading: "What visitors see when something raises",
        body: [
          "Development shows full error pages, source lines included, to whoever makes the request, so a visitor who hits an exception sees it. The interactive console on those pages is another matter: `web-console` only renders for local addresses and reads the forwarded client address, so a visitor does not get it, and your log says `Cannot render console from <address>!`.",
          'Mailers have no request to read a host from. The generated `development.rb` sets `config.action_mailer.default_url_options = { host: "localhost", port: 3000 }`, so links in emails sent while you share still point at localhost. Change it if someone else needs to click them.',
        ],
      },
    ],
    faq: [
      {
        question: "How do I fix Blocked hosts in Rails with a tunnel?",
        answer:
          'Add the tunnel\'s domain to config.hosts in config/environments/development.rb and restart the server. For whk share that is config.hosts << ".sharehooks.cc"; the leading dot allows every name under the domain. Rails checks the X-Forwarded-Host header as well as Host, which is why a tunnel that sends Host: localhost is still blocked.',
      },
      {
        question: "Do I need config.force_ssl or config.assume_ssl to share a Rails app?",
        answer:
          "No. The link is HTTPS for the visitor and passes X-Forwarded-Proto: https, which Rails reads when it builds URLs and checks a form's origin. force_ssl and assume_ssl are for production setups.",
      },
      {
        question: "Does live reload work when I share a Rails app?",
        answer:
          "Rails reloads your code on the next request, so visitors get your latest edit when they load or reload a page. A default Rails app has no browser live reload. WebSockets pass through the link, so Action Cable and Turbo Streams work.",
      },
      {
        question: "Which port does the Rails server use?",
        answer:
          "3000 by default. bin/rails server -p 4000 picks another, and the PORT environment variable is read when -p is not given. Share whichever port the server prints.",
      },
    ],
    sources: [
      {
        label: "Configuring Rails Applications: config.hosts and HostAuthorization",
        href: "https://guides.rubyonrails.org/configuring.html#actiondispatch-hostauthorization",
      },
      {
        label: "host_authorization.rb in Rails 8.1 (the Host and X-Forwarded-Host checks)",
        href: "https://github.com/rails/rails/blob/v8.1.4.1/actionpack/lib/action_dispatch/middleware/host_authorization.rb",
      },
      {
        label: "Action Cable Overview: allowed request origins",
        href: "https://guides.rubyonrails.org/action_cable_overview.html#allowed-request-origins",
      },
      {
        label: "The Rails Command Line: bin/rails server",
        href: "https://guides.rubyonrails.org/command_line.html#starting-a-rails-application-server",
      },
      {
        label: "web-console: permissions",
        href: "https://github.com/rails/web-console#configuration",
      },
    ],
    keywords: [
      "rails blocked hosts",
      "rails config.hosts ngrok",
      "share rails app localhost",
      "rails tunnel localhost",
      "expose rails server to internet",
      "rails blocked host tunnel",
    ],
    updated: "2026-11-12",
  },
  laravel: {
    label: "Laravel",
    group: "Python, Ruby, PHP and Elixir",
    version: "13",
    fromSource: true,
    port: 8000,
    devCommand: "php artisan serve",
    card: "Trust the proxy so links and assets use the public name, and build your assets: the Vite dev server is a second port.",
    title: "Share a Laravel App From Localhost: Proxies, Vite, APP_URL",
    description:
      "Run whk share 8000 to put php artisan serve at a public HTTPS link. Why links and assets point at localhost until trustProxies is set, why npm run dev breaks styles for visitors, and what APP_URL is for.",
    h1: "Share a Laravel app at a public URL",
    intro:
      "`php artisan serve` listens on `localhost:8000`, and `whk share 8000` gives it an HTTPS link. Laravel answers any host, so the page loads at once; what needs attention is where its links and assets point.",
    hostSetting:
      "No host setting: Laravel answers every `Host` unless you turned on `trustHosts`. Add `trustProxies` so generated URLs use the public name.",
    withoutIt:
      "No error page. Links and assets from `url()`, `route()` and `asset()` point at `http://localhost:8000`, which is the visitor's own machine, so styles and scripts are missing.",
    hotReload:
      "Not through the link: Vite's dev server is a second port. Run `npm run build` and reload by hand.",
    urlsAndCookies:
      "`trustProxies` makes URLs use `X-Forwarded-Host` and `X-Forwarded-Proto`. `APP_URL` is for URLs made outside a request (Artisan, queues). Session cookies need no change.",
    sections: [
      {
        heading: "Trust the proxy, or URLs point at localhost",
        body: [
          "During a request Laravel generates URLs from the request's own scheme and host. Through the link those are `http` and `localhost:8000`, so every `route()`, `url()` and `asset()` call writes `http://localhost:8000/...` into the page. Redirects to such an address come back to the link, but a stylesheet or script tag does not: the visitor's browser looks for it on their own machine.",
          "Laravel's `TrustProxies` middleware reads `X-Forwarded-Host` and `X-Forwarded-Proto` from proxies you name. `whk` runs on your machine, so the proxy to trust is the loopback address:",
        ],
        snippet: {
          file: "bootstrap/app.php",
          code: `->withMiddleware(function (Middleware $middleware): void {
    // whk share connects from this machine, and sets only these headers
    $middleware->trustProxies(
        at: ['127.0.0.1', '::1'],
        headers: Request::HEADER_X_FORWARDED_FOR
            | Request::HEADER_X_FORWARDED_HOST
            | Request::HEADER_X_FORWARDED_PROTO,
    );
})`,
        },
        after:
          "With that, generated URLs read `https://<name>.sharehooks.cc/...`. `Request` is `Illuminate\\Http\\Request`. Listing the headers matters because Laravel otherwise also trusts `X-Forwarded-Port` and `X-Forwarded-Prefix`, which the link passes through from the visitor unchanged. The docs also allow `trustProxies(at: '*')`, which trusts whatever connects; naming loopback is enough here.",
      },
      {
        heading: "Stop the Vite dev server and build",
        body: [
          "`npm run dev` (and `composer run dev`, which starts it for you) runs Vite on its own port and writes its address into `public/hot`. While that file exists, the `@vite` directive points script and style tags at the Vite server, such as `http://localhost:5173` or `http://[::1]:5173`. A share is one port, so visitors get your HTML without its CSS and JavaScript.",
          "For sharing, stop the Vite dev server (it removes `public/hot` on exit) and build once. `@vite` then loads the compiled files from `public/build`, served by `php artisan serve` on the shared port:",
        ],
        snippet: {
          code: `npm run build
php artisan serve
whk share 8000`,
        },
        after:
          "Run `npm run build` again after changing CSS or JavaScript. Blade and PHP changes show on the next page load without a rebuild.",
      },
      {
        heading: "APP_URL, forms and sessions",
        body: [
          "`APP_URL` is what the console uses to generate URLs when there is no request: Artisan commands, queued mail, scheduled jobs. Set it to the link if those need to produce working links, which is practical with a reserved name that stays the same.",
          "Forms work as they are. Laravel 13's `PreventRequestForgery` middleware first looks at the browser's `Sec-Fetch-Site` header, which says same-origin for a form posted from the link to the link, and falls back to the CSRF token. Neither compares hosts. Session cookies are set without a domain by default, so the browser keeps them for the link; leave `SESSION_DOMAIN` unset, because a cookie set for another domain is dropped on the way out.",
          "If the port is taken, `php artisan serve` moves to the next one (8001, and on up to ten tries), so share the port it prints.",
        ],
      },
    ],
    faq: [
      {
        question: "Why are CSS and JavaScript missing when I share my Laravel app?",
        answer:
          "Either the Vite dev server is running, so the @vite directive points assets at localhost:5173, which visitors cannot reach, or the asset URLs were generated as http://localhost:8000 because the proxy is not trusted. Stop npm run dev, run npm run build, and add trustProxies in bootstrap/app.php.",
      },
      {
        question: "Do I have to change APP_URL to share a Laravel app?",
        answer:
          "Not for pages: during a request Laravel takes the scheme and host from the request, and with trustProxies set those are the link's. APP_URL matters for URLs generated outside a request, such as queued emails and Artisan commands.",
      },
      {
        question: "Does Laravel block the tunnel's host?",
        answer:
          "No. By default Laravel responds to every request whatever its Host header. The trustHosts middleware is opt-in, it is skipped in the local environment, and whk share sends Host: localhost in any case.",
      },
      {
        question: "Will I get 419 Page Expired on forms through the link?",
        answer:
          "Not from sharing itself. The CSRF middleware accepts a same-origin form post by its Sec-Fetch-Site header and otherwise checks the token from the session, and the session cookie works on the link. A 419 means the token or session is missing, for example when a cookie domain was set for another host.",
      },
    ],
    sources: [
      {
        label: "Requests: Configuring Trusted Proxies",
        href: "https://laravel.com/docs/13.x/requests#configuring-trusted-proxies",
      },
      {
        label: "Requests: Configuring Trusted Hosts",
        href: "https://laravel.com/docs/13.x/requests#configuring-trusted-hosts",
      },
      { label: "Asset Bundling (Vite)", href: "https://laravel.com/docs/13.x/vite" },
      { label: "URL Generation", href: "https://laravel.com/docs/13.x/urls#generating-urls" },
      {
        label: "CSRF Protection",
        href: "https://laravel.com/docs/13.x/csrf#preventing-csrf-requests",
      },
      {
        label: "config/app.php in laravel/laravel (APP_URL)",
        href: "https://github.com/laravel/laravel/blob/13.x/config/app.php",
      },
    ],
    keywords: [
      "share laravel localhost",
      "laravel ngrok assets not loading",
      "laravel trusted proxies tunnel",
      "laravel app_url tunnel",
      "expose laravel to internet",
      "php artisan serve public url",
    ],
    updated: "2026-11-12",
  },
  django: {
    label: "Django",
    group: "Python, Ruby, PHP and Elixir",
    version: "6.1",
    fromSource: true,
    port: 8000,
    devCommand: "python manage.py runserver",
    card: "ALLOWED_HOSTS passes as it is. Forms need the preview in CSRF_TRUSTED_ORIGINS, or POSTs fail with Origin checking failed.",
    title: "Share a Django Dev Server: CSRF_TRUSTED_ORIGINS and Hosts",
    description:
      "Run whk share 8000 to put Django's runserver at a public HTTPS link. Why ALLOWED_HOSTS needs no change, the CSRF_TRUSTED_ORIGINS line that fixes Origin checking failed on forms, and the proxy settings for absolute URLs.",
    h1: "Share a Django dev server at a public URL",
    intro:
      "`python manage.py runserver` listens on `127.0.0.1:8000`, and `whk share 8000` gives it an HTTPS link. Pages load with your settings untouched; forms need one line, because Django compares each POST's origin with the host it sees.",
    hostSetting:
      '`CSRF_TRUSTED_ORIGINS = ["https://*.sharehooks.cc"]` in `settings.py`. `ALLOWED_HOSTS` can stay as it is.',
    withoutIt:
      "Pages load, but every form POST answers `403 Forbidden` with `Origin checking failed - https://<name>.sharehooks.cc does not match any trusted origins.`",
    hotReload:
      "`runserver` reloads Python code as it changes, so visitors get your edit on their next request. It does not refresh the browser.",
    urlsAndCookies:
      "`build_absolute_uri()` returns `http://localhost:8000/...` unless `USE_X_FORWARDED_HOST` and `SECURE_PROXY_SSL_HEADER` are set, together with `ALLOWED_HOSTS`. Cookie defaults work.",
    sections: [
      {
        heading: "ALLOWED_HOSTS is already satisfied",
        body: [
          "With `DEBUG = True` and an empty `ALLOWED_HOSTS`, Django validates the host against `['.localhost', '127.0.0.1', '[::1]']`. The link sends `Host: localhost:8000`, so a fresh project serves its pages through a share with no change.",
          "The error most tunnel guides are about, `Invalid HTTP_HOST header: '<name>'. You may need to add '<name>' to ALLOWED_HOSTS.` with status `400`, belongs to tunnels that pass the public name as `Host`. You will only meet it here if you turn on `USE_X_FORWARDED_HOST`, which is covered below.",
        ],
      },
      {
        heading: "Trust the preview's origin for forms",
        body: [
          "For a POST that carries an `Origin` header, Django's CSRF protection requires it to match the origin of the host it sees. The browser sends `Origin: https://<name>.sharehooks.cc`; Django sees `http://localhost:8000`. The form answers `403` with the reason `Origin checking failed - https://<name>.sharehooks.cc does not match any trusted origins.`",
          "List the origin in `CSRF_TRUSTED_ORIGINS`. Values need their scheme, and `*` stands for a subdomain:",
        ],
        snippet: {
          file: "settings.py",
          code: `# Previews opened with whk share
CSRF_TRUSTED_ORIGINS = ["https://*.sharehooks.cc"]`,
        },
        after:
          'That one setting is enough for login forms, the admin and your own views. The wildcard trusts every preview name, other people\'s included; with a reserved name, list only yours: `["https://acme.sharehooks.cc"]`.',
      },
      {
        heading: "Absolute URLs behind the link",
        body: [
          "`request.build_absolute_uri()` and `request.get_host()` go by the `Host` header, so they say `http://localhost:8000`. Relative links and redirects are unaffected, and a redirect to that address comes back to the link. If you need the public address in an email, a sitemap or an OAuth callback, tell Django to read the forwarded headers:",
        ],
        snippet: {
          file: "settings.py",
          code: `# Only while sharing: the link sets these headers on every request
USE_X_FORWARDED_HOST = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
ALLOWED_HOSTS = [".sharehooks.cc", "localhost", "127.0.0.1"]`,
        },
        after:
          "Set all three together. `USE_X_FORWARDED_HOST` alone makes every request fail the host check with status `400`, since the forwarded name is then validated against `ALLOWED_HOSTS`; `SECURE_PROXY_SSL_HEADER` alone leaves the CSRF check comparing against `https://localhost:8000`. With the three in place Django sees the public origin itself, and forms pass without `CSRF_TRUSTED_ORIGINS`. Take them out again for direct local use: Django's docs warn against trusting these headers when no proxy sets them.",
      },
      {
        heading: "Static files, cookies and the debug page",
        body: [
          "`runserver` serves static files itself when `DEBUG` is on and `django.contrib.staticfiles` is installed, on the same port, so styles and scripts come through the link. The session and CSRF cookies are set without a domain and without `Secure` by default, which works on the link as it does locally.",
          "`DEBUG = True` also means a visitor who triggers an error sees Django's debug page, with settings and local variables. Share what you would show, or put a password on the share.",
        ],
      },
    ],
    faq: [
      {
        question: "How do I fix CSRF verification failed with a tunnel in Django?",
        answer:
          'Add the tunnel\'s origin, scheme included, to CSRF_TRUSTED_ORIGINS. For whk share that is CSRF_TRUSTED_ORIGINS = ["https://*.sharehooks.cc"]. The 403 page\'s reason is "Origin checking failed": the form\'s Origin header is the public address while Django sees localhost.',
      },
      {
        question: "Do I need to add the tunnel to ALLOWED_HOSTS?",
        answer:
          "Not with whk share. Your dev server gets Host: localhost:8000, which Django's development default accepts. Add .sharehooks.cc only if you enable USE_X_FORWARDED_HOST, because Django then validates the forwarded host instead.",
      },
      {
        question: "Does Django's dev server auto-reload through the link?",
        answer:
          "The server reloads your Python code when files change, so the next request a visitor makes runs the new code. Django does not push a refresh to the browser; visitors reload the page themselves.",
      },
      {
        question: "Which port does runserver use?",
        answer:
          "8000 on 127.0.0.1 by default. python manage.py runserver 7000 picks another port; share the same number with whk share 7000.",
      },
    ],
    sources: [
      {
        label: "Settings: CSRF_TRUSTED_ORIGINS",
        href: "https://docs.djangoproject.com/en/6.1/ref/settings/#csrf-trusted-origins",
      },
      {
        label: "Settings: ALLOWED_HOSTS",
        href: "https://docs.djangoproject.com/en/6.1/ref/settings/#allowed-hosts",
      },
      {
        label: "Cross Site Request Forgery protection: how it works",
        href: "https://docs.djangoproject.com/en/6.1/ref/csrf/#how-it-works",
      },
      {
        label: "Settings: SECURE_PROXY_SSL_HEADER",
        href: "https://docs.djangoproject.com/en/6.1/ref/settings/#secure-proxy-ssl-header",
      },
      {
        label: "Settings: USE_X_FORWARDED_HOST",
        href: "https://docs.djangoproject.com/en/6.1/ref/settings/#use-x-forwarded-host",
      },
      {
        label: "django-admin: runserver",
        href: "https://docs.djangoproject.com/en/6.1/ref/django-admin/#runserver",
      },
    ],
    keywords: [
      "django csrf_trusted_origins tunnel",
      "django origin checking failed",
      "django allowed_hosts ngrok",
      "share django localhost",
      "expose django runserver to internet",
      "django csrf verification failed tunnel",
    ],
    updated: "2026-11-12",
  },
  flask: {
    label: "Flask",
    group: "Python, Ruby, PHP and Elixir",
    version: "3.1",
    fromSource: true,
    port: 5000,
    devCommand: "flask run",
    card: "No setting needed to load pages. ProxyFix makes external URLs use the public name, and the debugger's console is kept from visitors.",
    title: "Share a Flask App From Localhost: ProxyFix and the Debugger",
    description:
      "Run whk share 5000 to put flask run at a public HTTPS link. Flask needs no host setting, ProxyFix makes url_for external links use the public name, and the Werkzeug debugger console is refused for visitors.",
    h1: "Share a Flask app at a public URL",
    intro:
      "`flask run` listens on `127.0.0.1:5000`, and `whk share 5000` gives it an HTTPS link. Flask accepts any host, so there is nothing to allow; the two things to know are how external URLs are built and what debug mode shows a visitor.",
    hostSetting:
      "None. Flask checks no host by default, and `TRUSTED_HOSTS`, if you set it, sees `localhost`.",
    withoutIt:
      "Nothing fails. External URLs from `url_for(..., _external=True)` read `http://localhost:5000/...` until `ProxyFix` is added.",
    hotReload:
      "`flask run --debug` restarts the server when your Python code changes. It does not refresh the browser.",
    urlsAndCookies:
      "`ProxyFix` makes `request.url`, the scheme and the client address follow `X-Forwarded-*`. The session cookie has no domain by default and works on the link.",
    sections: [
      {
        heading: "Pages load without any setting",
        body: [
          'Flask\'s docs put it plainly: by default the app does not know which hosts it may be reached through and treats any host as valid. Through the link it sees `Host: localhost:5000`, so even an app that sets `TRUSTED_HOSTS = ["localhost"]` keeps answering.',
          "Port 5000 is taken on recent macOS versions by the AirPlay Receiver service. If `flask run` says the address is in use, start it with `flask run --port 5001` and share that port.",
        ],
      },
      {
        heading: "External URLs with ProxyFix",
        body: [
          "`url_for('page')` returns a path, which works anywhere. `url_for('page', _external=True)`, `request.url` and `request.host` use the `Host` header, so through the link they say `http://localhost:5000`. To build links for an email or an OAuth callback, wrap the app in Werkzeug's `ProxyFix`, which applies the forwarded headers:",
        ],
        snippet: {
          file: "app.py",
          code: `from werkzeug.middleware.proxy_fix import ProxyFix

# One proxy (the link) sets each of these headers
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)`,
        },
        after:
          "With it, `request.url` reads `https://<name>.sharehooks.cc/...` and `request.remote_addr` is the visitor's address. If you also use `TRUSTED_HOSTS`, add `\".sharehooks.cc\"` to it, because the host Flask validates is now the forwarded one; otherwise every request answers `400` with `Host '<name>.sharehooks.cc' is not trusted.` Apply `ProxyFix` only while a proxy is in front: Flask's docs call a wrong configuration a security issue.",
      },
      {
        heading: "Debug mode and the Werkzeug debugger",
        body: [
          "`flask run --debug` shows an interactive debugger in the browser when a request raises, and its console runs Python on your machine. Werkzeug only serves the console to trusted hosts, `localhost` among them, and it decides by the `Host` header, which through any share is `localhost`.",
          "So the link itself keeps the console back: requests for the debugger's console and its commands are refused with a page of its own and never reach your app. The traceback page still shows, with your source code in it. Share without `--debug`, or behind `whk share 5000 --password`.",
        ],
      },
      {
        heading: "Forms and sessions",
        body: [
          "Flask has no CSRF protection of its own, so there is no origin check to satisfy; an extension that adds one brings its own rules. The session cookie is set with `HttpOnly` and no domain, so the visitor's browser keeps it for the link. Leave `SESSION_COOKIE_DOMAIN` unset: a cookie set for another domain is dropped on the way out.",
        ],
      },
    ],
    faq: [
      {
        question: "How do I expose a Flask app on localhost to the internet?",
        answer:
          "Start it with flask run, then run whk share 5000 in another terminal. The CLI prints an HTTPS link on sharehooks.cc that reaches your app until you press Ctrl-C. Flask needs no host or proxy setting for pages to load.",
      },
      {
        question: "Do I need ProxyFix to share a Flask app?",
        answer:
          "Only for absolute URLs. Without it, url_for with _external=True and request.url say http://localhost:5000, and request.remote_addr is 127.0.0.1. ProxyFix with x_for=1, x_proto=1 and x_host=1 makes them follow the link's forwarded headers.",
      },
      {
        question: "Is it safe to share Flask in debug mode?",
        answer:
          "The interactive console is not reachable: the link refuses the Werkzeug debugger's console and command requests. Traceback pages with your source code are still shown to visitors when a request fails, so run without --debug or put a password on the share.",
      },
      {
        question: "Does Flask reload the browser when I change code?",
        answer:
          "No. In debug mode the server restarts when Python files change, and a visitor sees the change on their next request.",
      },
    ],
    sources: [
      {
        label: "Tell Flask it is Behind a Proxy",
        href: "https://flask.palletsprojects.com/en/stable/deploying/proxy_fix/",
      },
      {
        label: "Security Considerations: Host Header Validation",
        href: "https://flask.palletsprojects.com/en/stable/web-security/#host-header-validation",
      },
      {
        label: "Configuration: TRUSTED_HOSTS",
        href: "https://flask.palletsprojects.com/en/stable/config/#TRUSTED_HOSTS",
      },
      { label: "Development Server", href: "https://flask.palletsprojects.com/en/stable/server/" },
      {
        label: "Werkzeug: Debugging Applications (allowed hosts, PIN)",
        href: "https://werkzeug.palletsprojects.com/en/stable/debug/",
      },
      {
        label: "Werkzeug: X-Forwarded-For Proxy Fix",
        href: "https://werkzeug.palletsprojects.com/en/stable/middleware/proxy_fix/",
      },
    ],
    keywords: [
      "expose flask app to internet",
      "share flask localhost",
      "flask proxyfix tunnel",
      "flask ngrok alternative",
      "flask public url localhost",
      "flask debugger tunnel",
    ],
    updated: "2026-11-12",
  },
  fastapi: {
    label: "FastAPI",
    group: "Python, Ruby, PHP and Elixir",
    version: "0.162",
    fromSource: true,
    port: 8000,
    devCommand: "fastapi dev --no-proxy-headers",
    card: "No host setting. Start it with --no-proxy-headers so redirects come back to the link, and link with paths rather than url_for's full URLs.",
    title: "Share a FastAPI Dev Server: Proxy Headers and Redirects",
    description:
      "Run whk share 8000 to put fastapi dev at a public HTTPS link. Why trailing-slash redirects land on https://localhost:8000 by default, the --no-proxy-headers flag that fixes it, and how /docs and url_for behave.",
    h1: "Share a FastAPI dev server at a public URL",
    intro:
      "`fastapi dev` listens on `127.0.0.1:8000`, and `whk share 8000` gives it an HTTPS link. There is no host check to pass. The catch is Uvicorn's proxy headers, which are on by default and change where redirects go.",
    hostSetting:
      "None for the host. Start the server with `--no-proxy-headers` while sharing, so its redirects are ones the link can send back.",
    withoutIt:
      "A request for `/items/` when the route is `/items` redirects to `https://localhost:8000/items`, which the visitor's browser cannot open.",
    hotReload:
      "`fastapi dev` reloads the server when your code changes. It does not refresh the browser.",
    urlsAndCookies:
      "`request.url` and `url_for` use the `Host` header, so they say `localhost:8000`. Link with paths (`url_for(...).path`); `/docs` already loads `/openapi.json` by path.",
    sections: [
      {
        heading: "Why redirects go to https://localhost:8000",
        body: [
          "Uvicorn applies `X-Forwarded-Proto` and `X-Forwarded-For` from addresses it trusts, and by default it trusts `127.0.0.1` and `::1`. `whk` connects from your own machine, so the scheme becomes `https` and the client address becomes the visitor's. Uvicorn does not read `X-Forwarded-Host`, so the host stays `localhost:8000`.",
          "The mix shows in anything absolute. Starlette's trailing-slash redirect, the one that sends `/items/` to `/items`, answers with `Location: https://localhost:8000/items`. The link rewrites redirects to `http://localhost:8000`, which is what a local server normally sends, but not this `https` form, so the visitor's browser is sent to its own machine.",
          "Turn the proxy headers off while sharing. The redirect is then `http://localhost:8000/items`, and the link returns it as `https://<name>.sharehooks.cc/items`:",
        ],
        snippet: {
          code: `fastapi dev main.py --no-proxy-headers
whk share 8000`,
        },
        after:
          "The same flag exists on `uvicorn main:app --reload --no-proxy-headers`. Without proxy headers `request.client.host` is `127.0.0.1`; the visitor's address is still in the `X-Forwarded-For` header if you need it.",
      },
      {
        heading: "url_for, templates and /docs",
        body: [
          '`request.url_for("static", path="/app.css")` returns a full URL built from the `Host` header: `http://localhost:8000/static/app.css`. In a template that is a stylesheet the visitor\'s browser cannot load. Use the path instead, which is the same on localhost and on the link: `url_for("static", path="/app.css").path`.',
          "The interactive docs need nothing. `/docs` asks for `/openapi.json` by path, and the schema has no `servers` entry unless you set a root path, so Swagger UI calls your API on whatever origin the page was opened from. Its own scripts and styles come from a CDN, not through the link.",
        ],
      },
      {
        heading: "Hosts, CORS and WebSockets",
        body: [
          'FastAPI adds no host check. If your app uses `TrustedHostMiddleware`, it compares the `Host` header, so `allowed_hosts=["localhost"]` keeps passing; a host it does not know gets `400` with `Invalid host header`.',
          "A page served by the app and calling the same app is same-origin on the link, so `CORSMiddleware` is not involved. A separate frontend on another port is a second share and a second origin: allow that origin in `CORSMiddleware`, or serve both from one port. WebSocket routes pass through the link like any other request.",
        ],
      },
    ],
    faq: [
      {
        question: "How do I expose a FastAPI app on localhost to the internet?",
        answer:
          "Start it with fastapi dev main.py --no-proxy-headers, then run whk share 8000 in another terminal. The CLI prints an HTTPS link on sharehooks.cc that reaches your app, /docs included, until you press Ctrl-C.",
      },
      {
        question: "Why does my FastAPI redirect go to localhost behind a tunnel?",
        answer:
          "Starlette builds redirect URLs from the Host header, and through whk share that is localhost:8000. With Uvicorn's default proxy headers the scheme is https, giving https://localhost:8000, which the link does not rewrite. Start the server with --no-proxy-headers and the redirect comes back to the public address.",
      },
      {
        question: "Does the Swagger UI at /docs work through the link?",
        answer:
          "Yes. The page requests /openapi.json by path and sends API calls to the origin it was loaded from, so Try it out calls your local app through the link.",
      },
      {
        question: "Do I need --forwarded-allow-ips or --root-path?",
        answer:
          "No. --forwarded-allow-ips widens which addresses Uvicorn trusts for proxy headers, and loopback is trusted already. --root-path is for an app mounted under a path prefix; a share serves the whole port at the root.",
      },
    ],
    sources: [
      {
        label: "FastAPI: Behind a Proxy",
        href: "https://fastapi.tiangolo.com/advanced/behind-a-proxy/",
      },
      {
        label: "FastAPI CLI: fastapi dev",
        href: "https://fastapi.tiangolo.com/fastapi-cli/#fastapi-dev",
      },
      {
        label: "Uvicorn settings: --proxy-headers and --forwarded-allow-ips",
        href: "https://uvicorn.dev/settings/",
      },
      {
        label: "Uvicorn deployment: proxies and forwarded headers",
        href: "https://uvicorn.dev/deployment/#proxies-and-forwarded-headers",
      },
      {
        label: "FastAPI: TrustedHostMiddleware",
        href: "https://fastapi.tiangolo.com/advanced/middleware/#trustedhostmiddleware",
      },
    ],
    keywords: [
      "expose fastapi to internet",
      "share fastapi localhost",
      "fastapi redirect localhost behind proxy",
      "fastapi proxy headers tunnel",
      "uvicorn forwarded-allow-ips tunnel",
      "fastapi ngrok alternative",
    ],
    updated: "2026-11-12",
  },
  phoenix: {
    label: "Phoenix",
    group: "Python, Ruby, PHP and Elixir",
    version: "1.8",
    fromSource: true,
    port: 4000,
    devCommand: "mix phx.server",
    card: "Nothing to add for pages, LiveView or live reload: sockets share the port, and their Origin arrives as localhost.",
    title: "Share a Phoenix Dev Server: check_origin and LiveView",
    description:
      "Run whk share 4000 to put mix phx.server at a public HTTPS link. LiveView and live reload sockets come through the same port, check_origin is satisfied, and generated URLs follow the endpoint's url config.",
    h1: "Share a Phoenix dev server at a public URL",
    intro:
      "`mix phx.server` listens on `127.0.0.1:4000`, and `whk share 4000` gives it an HTTPS link. LiveView, channels and live reload all use WebSockets on that one port, so they come along.",
    hostSetting:
      "None. A generated app sets `check_origin: false` in `config/dev.exs`, and with the check on, the link sends a socket's `Origin` as `http://localhost:4000`, which matches the endpoint's host.",
    withoutIt:
      "Nothing to hit through `whk share`. With another tunnel and the check on, sockets get `403` and the log says `Could not check origin for Phoenix.Socket transport.`",
    hotReload:
      "Yes. `Phoenix.LiveReloader` connects to the browser's own host and port, so open tabs reload when matching files change.",
    urlsAndCookies:
      "Path helpers (`~p`) are relative and work as they are. Full URLs come from the endpoint's `:url` config, `localhost` by default. Forms use session tokens with no host comparison.",
    sections: [
      {
        heading: "Sockets and check_origin",
        body: [
          "Phoenix checks the `Origin` header of socket connections against the host in the endpoint's `:url` config. A generated app turns that off for development with `check_origin: false` in `config/dev.exs`, so LiveView at `/live` and your channels connect through a share as they are.",
          "If your project has the check on in development, it still passes: the link sends a WebSocket's `Origin` as your local origin, `http://localhost:4000`, and with `check_origin: true` Phoenix compares only the host, `localhost`, which is the default `:url` host. The failure you may have met with other tunnels is a `403` on the socket and a log entry beginning `Could not check origin for Phoenix.Socket transport.`; its fix is an explicit list:",
        ],
        snippet: {
          file: "config/dev.exs",
          code: `# Only for a proxy that passes the public Origin on
config :my_app, MyAppWeb.Endpoint,
  check_origin: ["//localhost", "//*.sharehooks.cc"]`,
        },
      },
      {
        heading: "Live reload comes through",
        body: [
          "In development the endpoint serves `Phoenix.LiveReloader`'s socket at `/phoenix/live_reload/socket`, on the same port as the app. By default the reloader's script connects to the browser's host and port, which on a shared page is the link. When a file matching your `live_reload` patterns changes, a visitor's tab reloads like your own.",
          "Code changes are picked up by `Phoenix.CodeReloader` on the next request, as usual.",
        ],
      },
      {
        heading: "URLs, forms and the listening address",
        body: [
          'Verified routes written with `~p` produce paths, so links and form actions are the same on localhost and on the link. Functions that return full URLs use the endpoint\'s `:url` config, which is `[host: "localhost"]` in a generated app, so `url(~p"/")` says `localhost`. Set `:url` for the session if an email or a callback needs the public address; a reserved name keeps that address stable.',
          "Form protection is `Plug.CSRFProtection`: a token in the session compared with the one sent. No host is involved for forms posted to a path, so they work through the link.",
          "A generated app binds `127.0.0.1` in development, and the port comes from the `PORT` environment variable, `4000` when unset. `whk share 4000` connects to the loopback address, so the binding needs no change.",
        ],
      },
    ],
    faq: [
      {
        question: "Does LiveView work through a public link?",
        answer:
          "Yes. LiveView's socket at /live is a WebSocket on the app's own port, and WebSockets pass through whk share. A generated app has check_origin: false in development; with the check on, the socket's Origin arrives as localhost and matches.",
      },
      {
        question: "How do I fix Could not check origin for Phoenix.Socket transport?",
        answer:
          "That log entry means a socket's Origin host differs from the endpoint's configured host. Either set url: [host: ...] to the host you are using, or pass check_origin a list of allowed origins such as [\"//*.example.com\"]. Through whk share the Origin is sent as your local origin, so the default configuration passes.",
      },
      {
        question: "Does Phoenix live reload work for visitors?",
        answer:
          "Yes. The live reload socket is served by the same endpoint and port, and its script connects to the host the page was loaded from, so visitors' tabs reload when you change a watched file.",
      },
      {
        question: "Which port does Phoenix use?",
        answer:
          "4000 by default, or the PORT environment variable. Share the port mix phx.server prints.",
      },
    ],
    sources: [
      {
        label: "Phoenix.Endpoint: :check_origin, :url and socket/3",
        href: "https://hexdocs.pm/phoenix/Phoenix.Endpoint.html",
      },
      {
        label: "Up and Running: mix phx.server",
        href: "https://hexdocs.pm/phoenix/up_and_running.html",
      },
      {
        label: "Phoenix.LiveReloader",
        href: "https://hexdocs.pm/phoenix_live_reload/Phoenix.LiveReloader.html",
      },
      { label: "Plug.CSRFProtection", href: "https://hexdocs.pm/plug/Plug.CSRFProtection.html" },
      {
        label: "The generated config/dev.exs in Phoenix 1.8",
        href: "https://github.com/phoenixframework/phoenix/blob/v1.8.16/installer/templates/phx_single/config/dev.exs.eex",
      },
    ],
    keywords: [
      "share phoenix localhost",
      "phoenix check_origin tunnel",
      "phoenix liveview ngrok",
      "could not check origin phoenix socket",
      "expose phoenix server to internet",
      "phoenix live reload tunnel",
    ],
    updated: "2026-11-12",
  },
};

export const SHARE_FRAMEWORK_SLUGS: readonly string[] = Object.keys(FRAMEWORKS);

function toPage(slug: string, entry: ShareFrameworkEntry): ShareFrameworkPage {
  return {
    ...entry,
    slug,
    checked: DOCS_CHECKED,
    lastModified: new Date(`${entry.updated}T00:00:00.000Z`),
  };
}

const PAGES: ReadonlyMap<string, ShareFrameworkPage> = new Map(
  Object.entries(FRAMEWORKS).map(([slug, entry]) => [slug, toPage(slug, entry)])
);

export function getShareFrameworkPage(slug: string): ShareFrameworkPage | null {
  return PAGES.get(slug) ?? null;
}

export function getAllShareFrameworkPages(): readonly ShareFrameworkPage[] {
  return [...PAGES.values()];
}

/** The command that shares a framework's default port: "whk share 3000". */
export function shareCommand(page: Pick<ShareFrameworkEntry, "port">): string {
  return `whk share ${page.port}`;
}

/**
 * The frameworks listed after this one in its group, wrapping around, so every
 * page is linked from the same number of siblings (as the provider pages do).
 */
export function getRelatedShareFrameworkPages(slug: string, count = 3): ShareFrameworkPage[] {
  const page = getShareFrameworkPage(slug);
  if (!page) return [];
  const siblings = getAllShareFrameworkPages().filter((p) => p.group === page.group);
  const position = siblings.findIndex((p) => p.slug === slug);
  const related: ShareFrameworkPage[] = [];
  for (let step = 1; step < siblings.length && related.length < count; step++) {
    related.push(siblings[(position + step) % siblings.length]);
  }
  return related;
}

/** When the /share page's own copy last changed (YYYY-MM-DD). */
export const SHARE_PAGE_UPDATED = "2026-11-12";

/** Newest change among /share and its framework pages: the hub lists them all. */
export function getShareFrameworksLastModified(): Date {
  return getAllShareFrameworkPages().reduce(
    (latest, page) => (page.lastModified > latest ? page.lastModified : latest),
    new Date(`${SHARE_PAGE_UPDATED}T00:00:00.000Z`)
  );
}
