"use client";

import { useEffect, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  BLOCK_REQUESTS,
  MAX_BLOCKS,
  SLIDER_MAX_REQUESTS,
  parseRequestAmount,
} from "@/lib/capacity";
import { formatCents } from "@/lib/team-pricing";

function requests(count: number): string {
  return count.toLocaleString("en-US");
}

/**
 * Picks a number of 25,000-request blocks: a slider up to 500,000 requests,
 * and a field for an exact amount, which may go past the slider (up to the
 * purchase maximum) and rounds up to whole blocks. Controlled in blocks.
 */
export function BlockAmountPicker({
  label,
  blocks,
  onBlocksChange,
  minBlocks = 0,
  blockPriceCents,
  perMonth = false,
  disabled = false,
  children,
}: {
  /** What is being picked, for screen readers ("Monthly blocks"). */
  label: string;
  blocks: number;
  onBlocksChange: (blocks: number) => void;
  minBlocks?: number;
  blockPriceCents: number;
  perMonth?: boolean;
  disabled?: boolean;
  /** The action button, shown on the row with the amount. */
  children?: React.ReactNode;
}) {
  const inputId = useId();
  const [text, setText] = useState(() => requests(blocks * BLOCK_REQUESTS));
  /** Why a typed amount was changed, shown under the field. */
  const [note, setNote] = useState<string | null>(null);

  // Follows the slider and outside changes; typing keeps its own text until
  // it is committed.
  useEffect(() => {
    setText(requests(blocks * BLOCK_REQUESTS));
  }, [blocks]);

  const commit = () => {
    // Leaving the field after Enter commits the same text again; keep the note.
    if (text === requests(blocks * BLOCK_REQUESTS)) return;
    const parsed = parseRequestAmount(text, { minBlocks });
    if (!parsed) {
      setText(requests(blocks * BLOCK_REQUESTS));
      setNote("Type a number of requests, such as 75,000.");
      return;
    }
    setNote(
      !parsed.adjusted
        ? null
        : parsed.blocks === MAX_BLOCKS
          ? `The most at once is ${requests(MAX_BLOCKS * BLOCK_REQUESTS)} requests.`
          : parsed.blocks === minBlocks && minBlocks > 0
            ? `The least is ${requests(minBlocks * BLOCK_REQUESTS)} requests.`
            : "Rounded up to whole blocks of 25,000 requests."
    );
    setText(requests(parsed.blocks * BLOCK_REQUESTS));
    if (parsed.blocks !== blocks) onBlocksChange(parsed.blocks);
  };

  const sliderValue = Math.min(blocks * BLOCK_REQUESTS, SLIDER_MAX_REQUESTS);
  const price = formatCents(blocks * blockPriceCents);

  return (
    <div className="space-y-2">
      <Slider
        value={[sliderValue]}
        min={minBlocks * BLOCK_REQUESTS}
        max={SLIDER_MAX_REQUESTS}
        step={BLOCK_REQUESTS}
        onValueChange={([value]) => {
          setNote(null);
          onBlocksChange(Math.round(value / BLOCK_REQUESTS));
        }}
        disabled={disabled}
        aria-label={label}
        className="max-w-sm py-1"
      />
      <div className="flex max-w-sm justify-between text-xs text-muted-foreground tabular-nums">
        <span>{requests(minBlocks * BLOCK_REQUESTS)}</span>
        <span>{requests(SLIDER_MAX_REQUESTS)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          {label}, in requests
        </label>
        <Input
          id={inputId}
          inputMode="numeric"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          disabled={disabled}
          className="w-36 tabular-nums"
        />
        <span className="text-sm text-muted-foreground">
          requests: {blocks} {blocks === 1 ? "block" : "blocks"}, {price}
          {perMonth ? " a month" : ""}
        </span>
        {children}
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
