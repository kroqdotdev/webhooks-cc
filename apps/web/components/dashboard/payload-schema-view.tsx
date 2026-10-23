"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { highlightCode } from "@/lib/highlight";
import { trackPayloadSchemaCopied } from "@/lib/analytics";
import { Segmented } from "./settings-primitives";
import {
  SCHEMA_FORMATS,
  SCHEMA_FORMAT_STORAGE_KEY,
  buildPayloadSchema,
  isSchemaFormat,
  schemaGroupLabel,
  schemaRootName,
  similarSchemaRequests,
  type PayloadSchemaFormat,
  type SchemaSource,
} from "@/lib/payload-schema";

const LANGUAGE: Record<PayloadSchemaFormat, "typescript" | "python" | "json"> = {
  typescript: "typescript",
  zod: "typescript",
  pydantic: "python",
  "json-schema": "json",
};

function readStoredFormat(): PayloadSchemaFormat {
  try {
    const stored = window.localStorage.getItem(SCHEMA_FORMAT_STORAGE_KEY);
    return isSchemaFormat(stored) ? stored : "typescript";
  } catch {
    return "typescript";
  }
}

interface PayloadSchemaViewProps {
  request: SchemaSource;
  /**
   * Recent requests to learn from too: those with the same payload are found
   * here, only while the view is open, since it parses every candidate body.
   */
  candidates?: SchemaSource[];
  onCopy: (text: string, key: string) => void;
  copied: string | null;
}

/** A schema for the request body: TypeScript, Zod, Pydantic or JSON Schema. */
export function PayloadSchemaView({ request, candidates, onCopy, copied }: PayloadSchemaViewProps) {
  const [format, setFormat] = useState<PayloadSchemaFormat>("typescript");
  const [scope, setScope] = useState<"similar" | "single">("similar");

  useEffect(() => {
    setFormat(readStoredFormat());
  }, []);

  const chooseFormat = (next: PayloadSchemaFormat) => {
    setFormat(next);
    try {
      window.localStorage.setItem(SCHEMA_FORMAT_STORAGE_KEY, next);
    } catch {
      // Private mode: the choice lasts for this view only.
    }
  };

  const similar = useMemo(
    () => (candidates ? similarSchemaRequests(request, candidates) : [request]),
    [request, candidates]
  );
  const peers = similar.length > 1 ? similar : null;
  const sources = useMemo(
    () => (peers && scope === "similar" ? peers : [request]),
    [peers, scope, request]
  );
  const name = schemaRootName(request);
  const result = useMemo(() => buildPayloadSchema(sources, format, name), [sources, format, name]);
  const highlighted = useMemo(
    () => highlightCode(result.code, LANGUAGE[format]),
    [result.code, format]
  );

  const copyKey = `schema-${format}`;
  const isCopied = copied === copyKey;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          name="Schema format"
          size="xs"
          value={format}
          onChange={chooseFormat}
          options={SCHEMA_FORMATS}
        />
        <button
          onClick={() => {
            onCopy(result.code, copyKey);
            trackPayloadSchemaCopied(format, result.samples);
          }}
          className="ui-btn-outline py-1! px-2! text-xs flex items-center gap-1"
        >
          {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {isCopied ? "Copied!" : "Copy"}
        </button>
      </div>

      {peers && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Segmented
            name="Samples"
            size="xs"
            value={scope}
            onChange={setScope}
            options={[
              { value: "similar", label: `${peers.length} similar` },
              { value: "single", label: "This request" },
            ]}
          />
          <span className="font-mono">{schemaGroupLabel(request)}</span>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {result.samples > 1
          ? `Learned from ${result.samples} requests: a field missing from some is optional, one that is sometimes null is nullable.`
          : "Learned from this request. Capture a few more of the same event to find optional and nullable fields."}
      </p>

      <pre className="ui-code syntax-highlight overflow-x-auto text-sm">
        {/* Safe: highlightCode returns Prism-encoded tokens or escaped text. */}
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}
