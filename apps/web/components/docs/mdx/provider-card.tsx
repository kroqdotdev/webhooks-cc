import { ExternalLink } from "lucide-react";

export function ProviderCard({
  name,
  signatureHeader,
  algorithm,
  docsUrl,
}: {
  name: string;
  signatureHeader: string;
  algorithm: string;
  docsUrl: string;
}) {
  return (
    <div className="my-3 p-4 border-2 border-foreground bg-card shadow-neo-sm">
      <p className="font-bold text-foreground mb-2">{name}</p>
      <dl className="text-sm space-y-1 m-0">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Signature header:</dt>
          <dd className="font-mono font-bold">{signatureHeader}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Algorithm:</dt>
          <dd className="font-mono font-bold">{algorithm}</dd>
        </div>
      </dl>
      <a
        href={docsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline font-bold mt-2"
      >
        Official docs <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}
