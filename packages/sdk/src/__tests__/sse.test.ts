import { describe, it, expect } from "vitest";
import { parseSSE } from "../sse";

/** Helper to create a ReadableStream from a string. */
function streamFromString(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Helper to create a ReadableStream that sends chunks separately. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Collect all frames from an SSE stream. */
async function collectFrames(stream: ReadableStream<Uint8Array>) {
  const frames = [];
  for await (const frame of parseSSE(stream)) {
    frames.push(frame);
  }
  return frames;
}

describe("parseSSE", () => {
  it("parses a single event frame", async () => {
    const frames = await collectFrames(streamFromString('event: request\ndata: {"id":"r1"}\n\n'));
    expect(frames).toEqual([{ event: "request", data: '{"id":"r1"}' }]);
  });

  it("parses multiple frames", async () => {
    const frames = await collectFrames(
      streamFromString(
        'event: connected\ndata: {"slug":"abc"}\n\nevent: request\ndata: {"id":"r1"}\n\n'
      )
    );
    expect(frames).toEqual([
      { event: "connected", data: '{"slug":"abc"}' },
      { event: "request", data: '{"id":"r1"}' },
    ]);
  });

  it("handles multi-line data", async () => {
    const frames = await collectFrames(
      streamFromString("event: message\ndata: line1\ndata: line2\ndata: line3\n\n")
    );
    expect(frames).toEqual([{ event: "message", data: "line1\nline2\nline3" }]);
  });

  it("handles comment lines", async () => {
    const frames = await collectFrames(
      streamFromString(": keepalive\n\nevent: request\ndata: {}\n\n")
    );
    expect(frames).toEqual([
      { event: "comment", data: "keepalive" },
      { event: "request", data: "{}" },
    ]);
  });

  it("defaults event to 'message' when no event field", async () => {
    const frames = await collectFrames(streamFromString("data: hello\n\n"));
    expect(frames).toEqual([{ event: "message", data: "hello" }]);
  });

  it("handles empty data", async () => {
    const frames = await collectFrames(streamFromString("event: ping\ndata: \n\n"));
    expect(frames).toEqual([{ event: "ping", data: "" }]);
  });

  it("handles chunked delivery across frame boundary", async () => {
    const frames = await collectFrames(
      streamFromChunks(["event: request\nda", 'ta: {"id":"r1"}\n\n'])
    );
    expect(frames).toEqual([{ event: "request", data: '{"id":"r1"}' }]);
  });

  it("handles \\r\\n line endings", async () => {
    const frames = await collectFrames(streamFromString("event: test\r\ndata: value\r\n\r\n"));
    expect(frames).toEqual([{ event: "test", data: "value" }]);
  });

  it("flushes remaining frame at end of stream", async () => {
    // Stream ends without trailing blank line
    const frames = await collectFrames(streamFromString("event: final\ndata: last"));
    expect(frames).toEqual([{ event: "final", data: "last" }]);
  });

  it("ignores unknown fields", async () => {
    const frames = await collectFrames(
      streamFromString("event: test\nid: 123\nretry: 5000\ndata: value\n\n")
    );
    expect(frames).toEqual([{ event: "test", data: "value" }]);
  });
});
