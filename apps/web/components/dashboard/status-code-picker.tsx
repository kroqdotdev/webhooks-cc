"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUS_CODES = [
  { group: "2xx Success", codes: [
    { value: "200", label: "200 OK" },
    { value: "201", label: "201 Created" },
    { value: "202", label: "202 Accepted" },
    { value: "204", label: "204 No Content" },
  ]},
  { group: "3xx Redirect", codes: [
    { value: "301", label: "301 Moved Permanently" },
    { value: "302", label: "302 Found" },
    { value: "304", label: "304 Not Modified" },
    { value: "307", label: "307 Temporary Redirect" },
    { value: "308", label: "308 Permanent Redirect" },
  ]},
  { group: "4xx Client Error", codes: [
    { value: "400", label: "400 Bad Request" },
    { value: "401", label: "401 Unauthorized" },
    { value: "403", label: "403 Forbidden" },
    { value: "404", label: "404 Not Found" },
    { value: "405", label: "405 Method Not Allowed" },
    { value: "409", label: "409 Conflict" },
    { value: "422", label: "422 Unprocessable Entity" },
    { value: "429", label: "429 Too Many Requests" },
  ]},
  { group: "5xx Server Error", codes: [
    { value: "500", label: "500 Internal Server Error" },
    { value: "502", label: "502 Bad Gateway" },
    { value: "503", label: "503 Service Unavailable" },
    { value: "504", label: "504 Gateway Timeout" },
  ]},
];

const ALL_PRESET_VALUES = STATUS_CODES.flatMap((g) =>
  g.codes.map((c) => c.value)
);

const CUSTOM_VALUE = "__custom__";

interface StatusCodePickerProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

export function StatusCodePicker({
  id,
  value,
  onChange,
}: StatusCodePickerProps) {
  const isPreset = ALL_PRESET_VALUES.includes(value);
  const [isCustom, setIsCustom] = useState(!isPreset);
  const [customValue, setCustomValue] = useState(isPreset ? "" : value);

  // Sync when value changes externally
  useEffect(() => {
    const preset = ALL_PRESET_VALUES.includes(value);
    setIsCustom(!preset);
    if (!preset) setCustomValue(value);
  }, [value]);

  const handleSelectChange = (selected: string) => {
    if (selected === CUSTOM_VALUE) {
      setIsCustom(true);
      // Keep current value if it's already custom, otherwise default to empty
      if (!customValue) setCustomValue(value);
    } else {
      setIsCustom(false);
      setCustomValue("");
      onChange(selected);
    }
  };

  const handleCustomInput = (input: string) => {
    // Only allow digits, max 3 chars
    const cleaned = input.replace(/\D/g, "").slice(0, 3);
    setCustomValue(cleaned);
    if (cleaned.length === 3) {
      const num = parseInt(cleaned);
      if (num >= 100 && num <= 599) {
        onChange(cleaned);
      }
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="font-bold uppercase tracking-wide text-xs">
        Status Code
      </Label>
      <div className="flex gap-2">
        <Select
          value={isCustom ? CUSTOM_VALUE : value}
          onValueChange={handleSelectChange}
        >
          <SelectTrigger
            id={id}
            className={cn(
              "border-2 border-foreground rounded-none text-sm font-mono h-auto py-2",
              isCustom ? "w-36 shrink-0" : "w-full"
            )}
          >
            <SelectValue placeholder="Select status" />
          </SelectTrigger>
          <SelectContent className="border-2 border-foreground rounded-none shadow-neo">
            {STATUS_CODES.map((group, i) => (
              <SelectGroup key={group.group}>
                {i > 0 && <SelectSeparator className="bg-foreground/20" />}
                <SelectLabel className="font-bold uppercase tracking-wide text-xs text-muted-foreground">
                  {group.group}
                </SelectLabel>
                {group.codes.map((code) => (
                  <SelectItem
                    key={code.value}
                    value={code.value}
                    className="font-mono text-sm cursor-pointer rounded-none"
                  >
                    {code.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
            <SelectSeparator className="bg-foreground/20" />
            <SelectGroup>
              <SelectItem
                value={CUSTOM_VALUE}
                className="font-bold text-sm cursor-pointer rounded-none"
              >
                Custom...
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>

        {isCustom && (
          <input
            type="text"
            inputMode="numeric"
            value={customValue}
            onChange={(e) => handleCustomInput(e.target.value)}
            placeholder="418"
            className="neo-input flex-1 text-sm font-mono"
            autoFocus
          />
        )}
      </div>
      {isCustom && customValue.length === 3 && (
        (() => {
          const num = parseInt(customValue);
          if (num < 100 || num > 599) {
            return (
              <p className="text-xs text-destructive">
                Status code must be between 100 and 599
              </p>
            );
          }
          return null;
        })()
      )}
    </div>
  );
}
