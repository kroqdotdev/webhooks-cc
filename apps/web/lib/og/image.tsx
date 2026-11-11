import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE } from "@/lib/seo";
import { fitTitle, ogText } from "./text";

/**
 * The Open Graph card for a page: its kind, its title, the wordmark.
 *
 * Drawn in the site's look (app/globals.css): cool paper, a white surface with
 * a hairline, ink text, one pine green, IBM Plex Sans with IBM Plex Mono. The
 * fonts are files in assets/og (SIL Open Font License, OFL.txt beside them),
 * never fetched: images are built in CI and rendered on the production host,
 * and neither may depend on Google. next.config.ts traces the folder into the
 * standalone output for the images rendered at request time.
 */

// The light tokens, as hex because the renderer has no CSS variables.
const PAPER = "#f7f8fa";
const SURFACE = "#ffffff";
const INK = "#171b21";
const MUTED = "#606876";
const HAIRLINE = "#dbdfe5";
const PINE = "#0f6c53";

const SANS = "IBM Plex Sans";
const MONO = "IBM Plex Mono";

function font(file: string): Promise<Buffer> {
  // process.cwd() is apps/web in dev and at build time, and the standalone
  // server changes into its own apps/web before it starts.
  return readFile(join(process.cwd(), "assets/og", file));
}

let fonts: Promise<[Buffer, Buffer, Buffer]> | undefined;

function loadFonts(): Promise<[Buffer, Buffer, Buffer]> {
  fonts ??= Promise.all([
    font("IBMPlexSans-SemiBold.ttf"),
    font("IBMPlexSans-Regular.ttf"),
    font("IBMPlexMono-Medium.ttf"),
  ]);
  // A failed read is not kept: the next image tries again.
  fonts.catch(() => {
    fonts = undefined;
  });
  return fonts;
}

export interface OgImageInput {
  /** The short label above the title: "Compare", "Blog", "Webhooks". */
  kind: string;
  title: string;
  /** One line under the title. Left out when it would not fit on one line. */
  subtitle?: string;
  /** The page's path, shown after the wordmark's host: "/compare/ngrok". */
  path?: string;
}

/** Longest subtitle and path that stay on one line at their sizes. */
const SUBTITLE_MAX = 62;
const PATH_MAX = 44;

export async function ogImageResponse(input: OgImageInput): Promise<ImageResponse> {
  const [semiBold, regular, mono] = await loadFonts();

  const cleanSubtitle = input.subtitle ? ogText(input.subtitle) : "";
  const subtitle = cleanSubtitle && cleanSubtitle.length <= SUBTITLE_MAX ? cleanSubtitle : "";
  const { lines, fontSize } = fitTitle(input.title, { subtitle: Boolean(subtitle) });
  const cleanPath = input.path ? ogText(input.path) : "";
  const path = cleanPath.length <= PATH_MAX ? cleanPath : "";

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        padding: 40,
        backgroundColor: PAPER,
        fontFamily: SANS,
        color: INK,
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 56,
          backgroundColor: SURFACE,
          border: `1px solid ${HAIRLINE}`,
          borderRadius: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: PINE }} />
          <div
            style={{
              marginLeft: 14,
              fontFamily: MONO,
              fontSize: 24,
              fontWeight: 500,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: PINE,
            }}
          >
            {ogText(input.kind)}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize,
              fontWeight: 600,
              lineHeight: 1.12,
              letterSpacing: -fontSize * 0.02,
              // The fit is an estimate; nothing may ever leave the card.
              overflow: "hidden",
            }}
          >
            {lines.map((line, index) => (
              <div key={index} style={{ whiteSpace: "nowrap" }}>
                {line}
              </div>
            ))}
          </div>
          {subtitle ? (
            <div style={{ marginTop: 20, fontSize: 30, fontWeight: 400, color: MUTED }}>
              {subtitle}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            paddingTop: 24,
            borderTop: `1px solid ${HAIRLINE}`,
          }}
        >
          <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: -0.4 }}>webhooks.cc</div>
          {path ? (
            <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 500, color: MUTED }}>
              {path}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    {
      ...OG_IMAGE_SIZE,
      fonts: [
        { name: SANS, data: semiBold, weight: 600, style: "normal" },
        { name: SANS, data: regular, weight: 400, style: "normal" },
        { name: MONO, data: mono, weight: 500, style: "normal" },
      ],
      headers: {
        // next/og's own default is a year, immutable. A blog title can change.
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}

/** For an image route asked for a page that does not exist. */
export function ogImageNotFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
