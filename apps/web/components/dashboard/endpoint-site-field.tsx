"use client";

import { Field, Segmented, type SegmentedOption } from "./settings-primitives";
import { SITES, type EndpointSite } from "@/lib/site";

const OPTIONS: SegmentedOption<EndpointSite>[] = [
  { value: "webhooks", label: SITES.webhooks.name },
  { value: "mailhooks", label: SITES.mailhooks.name },
  { value: "both", label: "Both" },
];

const HELP =
  "Which site's dashboard lists this endpoint. Its HTTP URL and email address work either way.";

/**
 * Where an endpoint is listed (lib/site.ts, migration 00078). Only shown
 * when the app serves two sites; the caller checks twoSites().
 */
export function EndpointSiteField({
  value,
  onChange,
}: {
  value: EndpointSite;
  onChange: (next: EndpointSite) => void;
}) {
  return (
    <Field label="Listed on" help={HELP}>
      <Segmented<EndpointSite>
        name="Listed on"
        value={value}
        onChange={onChange}
        options={OPTIONS}
      />
    </Field>
  );
}

/** The same setting for someone who cannot change it (a team member). */
export function EndpointSiteText({ value }: { value: EndpointSite }) {
  return (
    <Field label="Listed on" help="Set by the endpoint's owner.">
      <p className="text-sm">{value === "both" ? "Both sites" : SITES[value].name}</p>
    </Field>
  );
}
