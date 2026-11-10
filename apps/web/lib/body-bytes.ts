/**
 * A captured body as bytes: the exact bytes the receiver kept in `body_raw`
 * (base64) when the body was not valid UTF-8, otherwise the text encoded as
 * UTF-8. Binary bodies are shown and replayed from these, never from the
 * text copy, which has replacement characters where the bytes were invalid.
 */
export function requestBodyBytes(input: {
  body?: string | null;
  bodyRaw?: string | null;
}): Uint8Array<ArrayBuffer> | null {
  if (input.bodyRaw) {
    const binary = atob(input.bodyRaw);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  if (input.body) {
    const encoded = new TextEncoder().encode(input.body);
    const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
    bytes.set(encoded);
    return bytes;
  }
  return null;
}

/** A classic hex dump: offset, 16 bytes in hex, then the printable ASCII ("." for the rest). */
export function hexDump(bytes: Uint8Array, limit = 512): string {
  const shown = bytes.subarray(0, limit);
  const lines: string[] = [];
  for (let offset = 0; offset < shown.length; offset += 16) {
    const row = shown.subarray(offset, offset + 16);
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(row, (byte) =>
      byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."
    ).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}
