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
          // Comment line
          yield { event: "comment", data: trimmedLine.slice(1).trimStart() };
          continue;
        }

        const colonIdx = trimmedLine.indexOf(":");
        if (colonIdx === -1) continue;

        const field = trimmedLine.slice(0, colonIdx);
        const val = trimmedLine.slice(colonIdx + 1).trimStart();

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
        yield { event: "comment", data: trimmedLine.slice(1).trimStart() };
      } else {
        const colonIdx = trimmedLine.indexOf(":");
        if (colonIdx !== -1) {
          const field = trimmedLine.slice(0, colonIdx);
          const val = trimmedLine.slice(colonIdx + 1).trimStart();
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
    reader.releaseLock();
  }
}
