import Link from "next/link";
import { Star, FileText } from "lucide-react";
import { GitHubIcon } from "@/components/ui/icons";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const GITHUB_REPO = "kroqdotdev/webhooks-cc";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return n.toString();
}

interface GitHubCardProps {
  stars: number | null;
}

/** Below this the star count is left out: it would undersell an open repository. */
export const STARS_FLOOR = 100;

export function GitHubCard({ stars }: GitHubCardProps) {
  return (
    <Card className="shrink-0 lg:mt-12 flex flex-col items-center text-center w-full lg:w-auto">
      <div className="w-14 h-14 border rounded-md bg-foreground flex items-center justify-center mb-4 shadow-surface">
        <GitHubIcon className="h-7 w-7 text-background" />
      </div>
      <p className="text-xs font-bold text-muted-foreground mb-1">Open Source</p>
      {stars !== null && stars >= STARS_FLOOR && (
        <p className="text-2xl font-bold mb-1 flex items-center gap-1.5">
          <Star className="h-5 w-5 text-amber-500 fill-amber-500" />
          {formatCount(stars)}
        </p>
      )}
      <p className="text-xs text-muted-foreground mb-4">
        {stars !== null && stars >= STARS_FLOOR ? "stars on GitHub" : "Read the code on GitHub"}
      </p>
      <div className="flex flex-col gap-3 w-full">
        <Button
          variant="surface"
          className="text-sm py-2 text-center flex items-center justify-center gap-2"
          render={
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View the webhooks-cc repository on GitHub"
            />
          }
        >
          <GitHubIcon className="h-4 w-4" />
          View Repo
        </Button>
        <Button
          variant="soft"
          className="text-sm py-2 text-center flex items-center justify-center gap-2"
          render={
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Star webhooks-cc on GitHub"
            />
          }
        >
          <Star className="h-4 w-4" />
          Star on GitHub
        </Button>
        <Button
          variant="surface"
          className="text-sm py-2 text-center flex items-center justify-center gap-2"
          render={<Link href="/changelog" />}
        >
          <FileText className="h-4 w-4" />
          View Changelog
        </Button>
      </div>
    </Card>
  );
}
