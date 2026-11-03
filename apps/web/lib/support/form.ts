import { cleanImage, ImageError } from "./images";
import { MAX_IMAGE_BYTES, MAX_IMAGES } from "./shared";
import type { CleanImage } from "./tickets";

/** The whole body, or null once it passes `max` bytes. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The largest form a ticket or reply can be: the images plus text. */
export const MAX_FORM_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES + 256 * 1024;

export type FormResult<T> = { ok: true; value: T } | { ok: false; response: Response };

function bad(error: string, status = 400): { ok: false; response: Response } {
  return { ok: false, response: Response.json({ error }, { status }) };
}

/**
 * Reads a ticket or reply form: JSON, or multipart with up to five images
 * under "images". Returns the text fields and the cleaned images.
 */
export async function readSupportForm(
  request: Request,
  allowImages: boolean
): Promise<FormResult<{ fields: Record<string, unknown>; images: CleanImage[] }>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_FORM_BYTES) return bad("The message and its images are too large.", 413);
  // A chunked body has no length to check up front: read it with a cap.
  if (!request.headers.get("content-length") && request.body) {
    const capped = await readCapped(request.body, MAX_FORM_BYTES);
    if (!capped) return bad("The message and its images are too large.", 413);
    request = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(capped),
    });
  }

  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) {
    try {
      const body: unknown = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Invalid body.");
      return { ok: true, value: { fields: body as Record<string, unknown>, images: [] } };
    } catch {
      return bad("Invalid JSON.");
    }
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("The form could not be read.");
  }
  const fields: Record<string, unknown> = {};
  const files: File[] = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
    } else if (key === "images") {
      files.push(value);
    }
  }
  if (files.length > 0 && !allowImages) return bad("Screenshots cannot be attached right now.");
  if (files.length > MAX_IMAGES) return bad(`Attach at most ${MAX_IMAGES} images.`);

  const images: CleanImage[] = [];
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) return bad("Each image can be at most 5 MB.", 413);
    try {
      images.push(cleanImage(new Uint8Array(await file.arrayBuffer())));
    } catch (error) {
      return bad(error instanceof ImageError ? error.message : "An image could not be read.");
    }
  }
  return { ok: true, value: { fields, images } };
}

/** A boolean form field: JSON true/false or the strings "true"/"false". */
export function boolField(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function textField(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}
