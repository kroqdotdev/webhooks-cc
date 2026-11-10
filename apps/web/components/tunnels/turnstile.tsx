"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Cloudflare Turnstile, rendered explicitly and invisible unless Cloudflare
 * wants a click ("interaction-only"). Without a site key it renders nothing,
 * and the server asks for no token either (lib/turnstile.ts). It says when it
 * fails or is still waiting after GIVE_UP_MS (a blocker, no network), since
 * the form's button waits for it.
 */

const GIVE_UP_MS = 15_000;

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      appearance: "interaction-only";
      theme: "auto";
    }
  ): string;
  remove(id: string): void;
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<TurnstileApi> | null = null;

function load(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SRC;
    script.async = true;
    script.onload = () => {
      const api = (window as { turnstile?: TurnstileApi }).turnstile;
      if (api) resolve(api);
      else reject(new Error("Turnstile did not load"));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error("Turnstile did not load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export function Turnstile({
  siteKey,
  onToken,
}: {
  siteKey: string | null;
  onToken: (token: string | null) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const latest = useRef(onToken);
  const [state, setState] = useState<"checking" | "passed" | "failed">("checking");
  useEffect(() => {
    latest.current = onToken;
  });

  useEffect(() => {
    if (!siteKey) return;
    let id: string | undefined;
    let api: TurnstileApi | undefined;
    let gone = false;
    let passed = false;
    const fail = () => {
      if (gone) return;
      latest.current(null);
      setState("failed");
    };
    const giveUp = setTimeout(() => {
      if (!passed) fail();
    }, GIVE_UP_MS);
    load()
      .then((t) => {
        if (gone || !holder.current) return;
        api = t;
        id = t.render(holder.current, {
          sitekey: siteKey,
          callback: (token) => {
            passed = true;
            latest.current(token);
            setState("passed");
          },
          // Turnstile checks again by itself; until then there is no token.
          "expired-callback": () => {
            passed = false;
            latest.current(null);
            setState("checking");
          },
          "error-callback": fail,
          appearance: "interaction-only",
          theme: "auto",
        });
      })
      .catch(fail);
    return () => {
      gone = true;
      clearTimeout(giveUp);
      if (api && id) api.remove(id);
    };
  }, [siteKey]);

  if (!siteKey) return null;
  return (
    <>
      <div ref={holder} />
      {state === "checking" && (
        <p className="text-xs text-muted-foreground">Checking this browser.</p>
      )}
      {state === "failed" && (
        <p role="alert" className="text-sm text-destructive-ink">
          The browser check didn&rsquo;t load. Reload the page, or write to support@webhooks.cc.
        </p>
      )}
    </>
  );
}
