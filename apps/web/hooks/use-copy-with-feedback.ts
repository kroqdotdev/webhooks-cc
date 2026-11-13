"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * Copies text and remembers for a moment that it did, so a button can show a
 * check. The one copy-with-feedback mechanism: every copy button uses it.
 *
 * `copy(text, key)` answers whether the copy worked, and only a copy that
 * worked shows feedback. `key` tells several buttons that share one hook
 * apart: `isCopied(key)` or `copiedKey` say which one was last copied.
 * `reset()` drops the feedback at once. The timer is cleared on unmount.
 */
export function useCopyWithFeedback(feedbackDuration = 2000) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = useCallback(
    async (text: string, key = "default") => {
      const success = await copyToClipboard(text);
      if (success) {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setCopiedKey(key);
        timeoutRef.current = setTimeout(() => setCopiedKey(null), feedbackDuration);
      }
      return success;
    },
    [feedbackDuration]
  );

  const reset = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setCopiedKey(null);
  }, []);

  const isCopied = useCallback((key = "default") => copiedKey === key, [copiedKey]);

  return { copy, isCopied, copiedKey, reset };
}
