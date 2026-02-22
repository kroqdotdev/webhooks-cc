import { Github, Star } from "lucide-react";

const GITHUB_REPO = "kroqdotdev/webhooks-cc";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return n.toString();
}

interface GitHubCardProps {
  stars: number | null;
}

export function GitHubCard({ stars }: GitHubCardProps) {
  return (
    <div className="neo-card neo-card-static shrink-0 lg:mt-12 flex flex-col items-center text-center w-full lg:w-auto">
      <div className="w-14 h-14 border-2 border-foreground bg-foreground flex items-center justify-center mb-4 shadow-neo-sm">
        <Github className="h-7 w-7 text-background" />
      </div>
      <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1">
        Open Source
      </p>
      {stars !== null && (
        <p className="text-2xl font-bold mb-1 flex items-center gap-1.5">
          <Star className="h-5 w-5 text-secondary fill-secondary" />
          {formatCount(stars)}
        </p>
      )}
      <p className="text-xs text-muted-foreground mb-4">
        {stars !== null ? "stars on GitHub" : "\u00A0"}
      </p>
      <div className="flex flex-col gap-3 w-full">
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View the webhooks-cc repository on GitHub"
          className="neo-btn-outline text-sm py-2 text-center flex items-center justify-center gap-2"
        >
          <Github className="h-4 w-4" />
          View Repo
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Star webhooks-cc on GitHub"
          className="neo-btn-secondary text-sm py-2 text-center flex items-center justify-center gap-2"
        >
          <Star className="h-4 w-4" />
          Star on GitHub
        </a>
      </div>
    </div>
  );
}
