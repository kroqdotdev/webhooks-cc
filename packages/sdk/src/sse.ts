/** A parsed SSE frame with event type and data. */
export interface SSEFrame {
  event: string;
  data: string;
}

/**
 * Async generator that parses SSE frames from a ReadableStream.
 *
 * Handles:
 * - Multi-line `data:` fields (joined with newlines)
 * - `event:` type fields
 * - Comment lines (`: ...`) — yielded with event "comment"
 * - Empty data fields
 * - Frames terminated by blank lines
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SSEFrame, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last partial line in the buffer
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line === "" || line === "\r") {
          // Blank line = end of frame
          if (dataLines.length > 0) {
            yield { event: currentEvent, data: dataLines.join("\n") };
            dataLines = [];
            currentEvent = "message";
          }
          continue;
        }

        const trimmedLine = line.endsWith("\r") ? line.slice(0, -1) : line;

        if (trimmedLine.startsWith(":")) {
          // Comment line — strip single leading space per SSE spec
          const rawComment = trimmedLine.slice(1);
          yield {
            event: "comment",
            data: rawComment.startsWith(" ") ? rawComment.slice(1) : rawComment,
          };
          continue;
        }

        const colonIdx = trimmedLine.indexOf(":");
        if (colonIdx === -1) continue;

        const field = trimmedLine.slice(0, colonIdx);
        // Per SSE spec: strip exactly one leading space after the colon, not all whitespace
        const rawVal = trimmedLine.slice(colonIdx + 1);
        const val = rawVal.startsWith(" ") ? rawVal.slice(1) : rawVal;

        switch (field) {
          case "event":
            currentEvent = val;
            break;
          case "data":
            dataLines.push(val);
            break;
          // Ignore other fields (id, retry, etc.)
        }
      }
    }

    // Process any remaining data in the buffer (stream ended without trailing newline)
    if (buffer.length > 0) {
      const trimmedLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (trimmedLine.startsWith(":")) {
        const rawComment = trimmedLine.slice(1);
        yield {
          event: "comment",
          data: rawComment.startsWith(" ") ? rawComment.slice(1) : rawComment,
        };
      } else {
        const colonIdx = trimmedLine.indexOf(":");
        if (colonIdx !== -1) {
          const field = trimmedLine.slice(0, colonIdx);
          const rawVal = trimmedLine.slice(colonIdx + 1);
          const val = rawVal.startsWith(" ") ? rawVal.slice(1) : rawVal;
          if (field === "event") currentEvent = val;
          else if (field === "data") dataLines.push(val);
        }
      }
    }

    // Flush remaining data if stream ends without a trailing blank line
    if (dataLines.length > 0) {
      yield { event: currentEvent, data: dataLines.join("\n") };
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
