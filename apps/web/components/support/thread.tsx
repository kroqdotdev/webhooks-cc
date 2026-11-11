"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { shortDateTime } from "@/lib/support/client";
import {
  eventText,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  type SupportMessageView,
} from "@/lib/support/shared";
import { Markdown } from "./markdown";

/**
 * Pieces shared by the user's ticket page and the staff inbox: the turn
 * line, the conversation, screenshots and the image picker.
 */

/**
 * Whose move it is, drawn as a line between the two parties with a marker
 * at the one who should act. Replaces a status badge: "waiting on you"
 * reads at a glance without learning a vocabulary of states.
 */
export function TurnLine({
  waitingOn,
  closed,
  left,
  right,
}: {
  waitingOn: "support" | "user";
  closed: boolean;
  /** The party on the left: "You" for the user, the person's name for staff. */
  left: string;
  right: string;
}) {
  const atLeft = waitingOn === "user";
  return (
    <div
      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 text-xs text-muted-foreground"
      aria-hidden="true"
    >
      <span className={cn(!closed && atLeft && "font-semibold text-primary")}>{left}</span>
      <span className="relative h-0.5 rounded-full bg-border">
        {!closed && (
          <span
            className={cn(
              "absolute -top-[5px] h-3 w-3 rounded-full bg-primary ring-4 ring-selected",
              "motion-safe:transition-[left] motion-safe:duration-500",
              atLeft ? "left-0" : "left-[calc(100%-0.75rem)]"
            )}
          />
        )}
      </span>
      <span className={cn(!closed && !atLeft && "font-semibold text-primary")}>{right}</span>
    </div>
  );
}

function initials(name: string | null): string {
  if (!name) return "?";
  const parts = name
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function Screenshot({ id, token }: { id: string; token: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!token) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/support/attachments/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error();
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, token]);

  if (failed) {
    return (
      <span className="flex h-20 w-28 items-center justify-center rounded-md border border-dashed border-input text-xs text-muted-foreground">
        Not available
      </span>
    );
  }
  if (!url) return <span className="block h-20 w-28 animate-pulse rounded-md bg-muted" />;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Screenshot"
        className="h-20 w-28 rounded-md border border-border object-cover hover:border-foreground/40"
      />
    </a>
  );
}

export function Conversation({
  messages,
  audience,
  token,
  userName,
}: {
  messages: SupportMessageView[];
  audience: "user" | "staff";
  token: string | null;
  /** The ticket owner's name, for event lines staff read. */
  userName?: string;
}) {
  return (
    <ol className="ph-no-capture">
      {messages.map((message, index) => {
        if (message.kind === "event" && message.event) {
          return (
            <li
              key={message.id}
              className="border-t border-border py-2.5 pl-11 text-xs text-muted-foreground first:border-t-0"
            >
              {eventText(message.event, audience, userName)}{" "}
              <time dateTime={message.createdAt} className="opacity-70">
                {shortDateTime(message.createdAt)}
              </time>
            </li>
          );
        }
        const isNote = message.kind === "note";
        const isStaff = message.author === "staff";
        return (
          <li
            key={message.id}
            className={cn(
              "grid grid-cols-[2rem_minmax(0,1fr)] gap-3 border-t border-border py-4",
              index === 0 && "border-t-0 pt-0",
              isNote && "my-2 rounded-md border border-staff-line bg-staff-wash px-3 py-3"
            )}
          >
            <span
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold",
                isStaff && !isNote
                  ? "bg-primary text-primary-foreground"
                  : isNote
                    ? "bg-staff text-background"
                    : "bg-muted text-muted-foreground"
              )}
              aria-hidden="true"
            >
              {initials(message.authorName)}
            </span>
            <div className="min-w-0">
              <p className="text-sm">
                {isNote ? (
                  <span className="font-semibold text-staff">
                    Note from {message.authorName ?? "staff"}, only staff see this
                  </span>
                ) : (
                  <span className="font-semibold">
                    {message.authorName ?? (isStaff ? "Support" : "You")}
                  </span>
                )}{" "}
                <span className="text-muted-foreground">
                  {isStaff && !isNote && audience === "user" ? "from support, " : ""}
                  <time dateTime={message.createdAt}>{shortDateTime(message.createdAt)}</time>
                </span>
              </p>
              {message.body && (
                <Markdown
                  source={message.body}
                  className="mt-1.5 max-w-[68ch] space-y-3 text-sm leading-relaxed break-words"
                />
              )}
              {message.attachments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {message.attachments.map((attachment) => (
                    <Screenshot key={attachment.id} id={attachment.id} token={token} />
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Up to five images, previewed before they are sent. */
export function ImagePicker({
  files,
  onChange,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  const add = (list: FileList | null) => {
    if (!list) return;
    setError(null);
    const next = [...files];
    for (const file of Array.from(list)) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        setError("Only PNG, JPEG and WebP images can be attached.");
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(`${file.name} is larger than 5 MB.`);
        continue;
      }
      if (next.length >= MAX_IMAGES) {
        setError(`Attach at most ${MAX_IMAGES} images.`);
        break;
      }
      next.push(file);
    }
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "flex flex-wrap items-center gap-3 rounded-md border border-dashed border-input p-3 text-sm text-muted-foreground",
          disabled && "opacity-50"
        )}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (!disabled) add(event.dataTransfer.files);
        }}
      >
        {previews.map((url, index) => (
          <span key={url} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt=""
              className="h-14 w-20 rounded-md border border-border object-cover"
            />
            <button
              type="button"
              onClick={() => onChange(files.filter((_, i) => i !== index))}
              className="absolute -right-2 -top-2 rounded-full border border-border bg-background p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Remove ${files[index]?.name ?? "image"}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <button
          type="button"
          disabled={disabled || files.length >= MAX_IMAGES}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-md px-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        >
          <ImagePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Drop images here or{" "}
            <span className="text-primary underline underline-offset-2">choose files</span>. PNG,
            JPEG or WebP, up to {MAX_IMAGES} files of 5 MB.
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            add(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      {error && <p className="text-xs text-destructive-ink">{error}</p>}
    </div>
  );
}

/** A form body for the support routes: JSON without images, multipart with them. */
export function supportBody(
  fields: Record<string, string | boolean>,
  images: File[]
): {
  body: BodyInit;
  json: boolean;
} {
  if (images.length === 0) return { body: JSON.stringify(fields), json: true };
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  for (const image of images) form.append("images", image);
  return { body: form, json: false };
}

/** A checkbox row with a title and an explanation under it. */
export function CheckRow({
  checked,
  onChange,
  title,
  children,
  id,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: React.ReactNode;
  children?: React.ReactNode;
  id: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1.25rem_1fr] items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-input accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{title}</span>
        {children && <span className="mt-0.5 block text-muted-foreground">{children}</span>}
      </label>
    </div>
  );
}
