"use client";

import * as React from "react";
import { OTPInput, REGEXP_ONLY_DIGITS } from "input-otp";
import { cn } from "@/lib/utils";
import { CONTROL_INPUT_CLASS } from "./input";
import { joinClasses } from "./render-as";

type CodeInputProps = {
  value: string;
  onChange: (value: string) => void;
  /** How many digits the code has. */
  length?: number;
  /** The input look it draws: `Input`'s (control) or `FieldControl`'s (field). */
  look?: "control" | "field";
  /** Where the digits sit, as `text-align` would put them in an input. */
  align?: "start" | "center";
  className?: string;
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  ref?: React.Ref<HTMLInputElement>;
  "aria-label"?: string;
  "aria-describedby"?: string;
};

/**
 * A one-time code field (input-otp): digits only, a pasted "123 456" lands as
 * 123456, and the browser's one-time-code autofill works. It looks like a
 * plain input: the digits in one row in the box `look` names, a blinking
 * caret where the next digit goes, and the box's focus ring while focused.
 */
export function CodeInput({
  value,
  onChange,
  length = 6,
  look = "control",
  align = "start",
  className,
  placeholder,
  ...props
}: CodeInputProps) {
  const box =
    look === "field"
      ? joinClasses(
          "ui-input",
          // .ui-input:focus adds this ring (its border colour is held by the control rule).
          "has-[input:focus]:[box-shadow:0_0_0_3px_hsl(var(--ring)/0.18)]",
          className
        )
      : cn(
          CONTROL_INPUT_CLASS,
          "has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring has-[input:focus-visible]:ring-offset-2",
          "has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-50",
          className
        );
  return (
    <OTPInput
      {...props}
      value={value}
      onChange={onChange}
      maxLength={length}
      pattern={REGEXP_ONLY_DIGITS}
      pasteTransformer={(pasted) => pasted.replace(/\D/g, "")}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder={placeholder}
      textAlign={align === "center" ? "center" : "left"}
      pushPasswordManagerStrategy="none"
      containerClassName={cn(
        box,
        "relative flex items-center",
        align === "center" ? "justify-center" : "justify-start"
      )}
      render={({ slots }) => (
        // Drawn only: the input itself carries the value and placeholder for
        // assistive technology, so these digits stay out of its name.
        <span aria-hidden className="flex items-center whitespace-pre">
          {slots.map((slot, index) =>
            slot.char ? (
              // The digit the next key replaces (input-otp selects one), shown as selected text.
              <span
                key={index}
                className={slot.isActive ? "bg-selected text-selected-foreground" : undefined}
              >
                {slot.char}
              </span>
            ) : (
              <React.Fragment key={index}>
                {slot.hasFakeCaret && (
                  // No width of its own, like a text field's caret: the digits do not move.
                  <span aria-hidden data-caret className="relative w-0 self-stretch">
                    <span className="absolute left-0 top-1/2 h-[1.15em] w-px -translate-y-1/2 animate-caret-blink motion-reduce:animate-none bg-foreground forced-colors:bg-[CanvasText]" />
                  </span>
                )}
                {slot.placeholderChar && (
                  <span className="text-muted-foreground">{slot.placeholderChar}</span>
                )}
              </React.Fragment>
            )
          )}
        </span>
      )}
    />
  );
}
