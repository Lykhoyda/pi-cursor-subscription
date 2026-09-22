import { describe, expect, it } from "bun:test";

import { bridgeCloseGaps } from "../src/stream/debug-log.js";

describe("smoke lifecycle gaps", () => {
  it("accepts a stream that opened and closed", () => {
    const text = [
      JSON.stringify({ event: "stream_start", requestId: "req-1" }),
      JSON.stringify({ event: "bridge_close", requestId: "req-1" }),
    ].join("\n");
    expect(bridgeCloseGaps(text)).toEqual({ started: 1, open: [] });
  });

  it("reports a stream that never closed", () => {
    const text = [
      JSON.stringify({ event: "stream_start", requestId: "req-1" }),
      JSON.stringify({ event: "bridge_close", requestId: "req-1" }),
      JSON.stringify({ event: "stream_start", requestId: "req-3" }),
      JSON.stringify({ event: "exec_server", requestId: "req-3" }),
    ].join("\n");
    expect(bridgeCloseGaps(text)).toEqual({ started: 2, open: ["req-3"] });
  });

  it("ignores a torn final line", () => {
    const text = `${JSON.stringify({ event: "stream_start", requestId: "req-1" })}\n{"event":`;
    expect(bridgeCloseGaps(text).started).toBe(1);
  });
});
