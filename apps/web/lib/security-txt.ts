import { webhooksOrigin } from "@/lib/site";
import { tunnelConfig } from "@/lib/tunnels/config";

/** How long ahead Expires points (RFC 9116 asks for less than a year). */
const VALID_DAYS = 180;

/**
 * The body of /.well-known/security.txt (RFC 9116) at a given time: where to
 * report security issues and abuse. Every shared preview's own security.txt
 * redirects here (apps/edge-rs), so the report form is listed as a contact
 * while sharing is on (the form refuses reports about anything but previews,
 * and without sharing there are none to report).
 */
export function securityTxt(
  now = Date.now(),
  origin = webhooksOrigin(),
  sharing = tunnelConfig() !== null
): string {
  const expires = new Date(now + VALID_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    "Contact: mailto:support@webhooks.cc",
    ...(sharing ? [`Contact: ${origin}/report`] : []),
    `Expires: ${expires}`,
    "Preferred-Languages: en, da",
    `Canonical: ${origin}/.well-known/security.txt`,
    "",
  ].join("\n");
}
