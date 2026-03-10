"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isDocsSearchUrl, normalizePagefindUrl } from "@/lib/docs-search";

interface SearchResult {
  url: string;
  title: string;
  excerpt: string;
  section?: string;
}

export function SearchModal() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pagefind, setPagefind] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const router = useRouter();

  // Load Pagefind on first open
  useEffect(() => {
    if (!open || pagefind) return;

    async function loadPagefind() {
      try {
        // @ts-expect-error -- Pagefind is generated at build time, not a real module
        const pf = await import(/* webpackIgnore: true */ "/_pagefind/pagefind.js");
        await pf.init();
        setPagefind(pf);
      } catch {
        console.debug("Pagefind not available — search disabled");
      }
    }

    loadPagefind();
  }, [open, pagefind]);

  // Keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Listen for sidebar search button click
  useEffect(() => {
    function handleOpen() {
      setOpen(true);
    }

    window.addEventListener("open-docs-search", handleOpen);
    return () => window.removeEventListener("open-docs-search", handleOpen);
  }, []);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      setQuery("");
      setResults([]);
      setActiveIndex(0);
    }
  }, [open]);

  // Debounced search
  const search = useCallback(
    async (q: string) => {
      if (!pagefind || q.length < 2) {
        setResults([]);
        return;
      }

      const searchResult = await pagefind.search(q);
      const items: SearchResult[] = [];

      for (const result of searchResult.results) {
        if (items.length === 8) break;

        const data = await result.data();
        const url = normalizePagefindUrl(data.url);

        if (!isDocsSearchUrl(url)) {
          continue;
        }

        items.push({
          url,
          title: data.meta?.title ?? url,
          excerpt: data.excerpt ?? "",
          section: data.meta?.section,
        });
      }

      setResults(items);
      setActiveIndex(0);
    },
    [pagefind]
  );

  function handleInput(value: string) {
    setQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value), 150);
  }

  function navigate(url: string) {
    setOpen(false);
    router.push(url);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[activeIndex]) {
      e.preventDefault();
      navigate(results[activeIndex].url);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* Modal */}
      <div className="relative w-full max-w-xl mx-4 border-2 border-foreground bg-background shadow-neo">
        {/* Input */}
        <div className="flex items-center border-b-2 border-foreground px-4">
          <Search className="h-5 w-5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search docs..."
            className="flex-1 px-3 py-3 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground"
          />
          <button
            onClick={() => setOpen(false)}
            type="button"
            className="p-1 text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <ul className="max-h-80 overflow-y-auto py-2">
            {results.map((result, i) => (
              <li key={result.url}>
                <button
                  onClick={() => navigate(result.url)}
                  type="button"
                  className={cn(
                    "w-full text-left px-4 py-3 cursor-pointer transition-colors",
                    i === activeIndex ? "bg-muted border-l-4 border-l-primary" : "hover:bg-muted/50"
                  )}
                >
                  <p className="font-bold text-sm">{result.title}</p>
                  {result.section && (
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {result.section}
                    </p>
                  )}
                  <p
                    className="text-sm text-muted-foreground mt-1 line-clamp-2 [&>mark]:bg-primary/20 [&>mark]:text-foreground"
                    dangerouslySetInnerHTML={{ __html: result.excerpt }}
                  />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Empty state */}
        {query.length >= 2 && results.length === 0 && pagefind && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No results for &ldquo;{query}&rdquo;
          </div>
        )}

        {/* Pagefind not loaded */}
        {query.length >= 2 && !pagefind && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Search is available in production builds.
          </div>
        )}

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2 border-t-2 border-foreground text-xs text-muted-foreground">
          <span>
            <kbd className="border border-foreground/30 px-1 py-0.5 font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="border border-foreground/30 px-1 py-0.5 font-mono">↵</kbd> open
          </span>
          <span>
            <kbd className="border border-foreground/30 px-1 py-0.5 font-mono">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
