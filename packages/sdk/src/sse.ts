/** A parsed SSE frame with event type and data. */
export interface SSEFrame {
  event: string;
  data: string;
}

/** Options for {@link parseSSE}. */
export interface ParseSSEOptions {
  /**
   * Aborting this signal cancels the underlying reader: a pending read settles and
   * the generator completes (without flushing partial frames) instead of hanging on
   * a stream that never delivers another byte.
   */
  signal?: AbortSignal;
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
 * - Early termination via `options.signal`
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  options: ParseSSEOptions = {}
): AsyncGenerator<SSEFrame, void, undefined> {
  const { signal } = options;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let dataLines: string[] = [];

  const onAbort = () => {
    reader.cancel().catch(() => {
      // Stream may already be closed or errored
    });
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) return;

      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        // An aborted fetch rejects pending reads; that is the end of this stream.
        if (signal?.aborted) return;
        throw error;
      }
      if (signal?.aborted) return;

      const { done, value } = result;
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
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // Stream may already be errored (e.g. an aborted fetch); nothing left to release
    }
    reader.releaseLock();
  }
}
