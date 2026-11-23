import { describe, expect, it } from "bun:test";

import { unhandledExecDiagnostic } from "../scripts/smoke-pi-grok.js";
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

describe("unhandled exec smoke diagnostics", () => {
  const opened = '{"event":"stream_start","requestId":"req-1"}';
  const closed = '{"event":"bridge_close","requestId":"req-1"}';

  it("reports the protobuf field in the lifecycle log without copying any payload", () => {
    const lifecycle = [
      opened,
      '{"event":"exec_unknown_shape","execCase":"unknown","unknownFields":"57:wt2:8b","payload":"fixture-secret"}',
      closed,
    ].join("\n");
    expect(unhandledExecDiagnostic(lifecycle, "")).toBe("UNHANDLED exec case: protobuf field 57");
  });

  it("reports a schema case name from the literal warning when the lifecycle event is missing", () => {
    const warning = '[cursor-provider] UNHANDLED exec case: "shellArgs". Answering with a throw.';
    expect(unhandledExecDiagnostic(`${opened}\n${closed}`, warning)).toBe(
      "UNHANDLED exec case: shellArgs",
    );
  });

  it("keeps a literal warning fatal without copying an unrecognized case name", () => {
    const warning =
      '[cursor-provider] UNHANDLED exec case: "fixture-secret". Answering with a throw.';
    expect(unhandledExecDiagnostic(`${opened}\n${warning}\n${closed}`, "")).toBe(
      "UNHANDLED exec case: unknown",
    );
  });

  it("accepts a clean lifecycle log", () => {
    expect(unhandledExecDiagnostic(`${opened}\n${closed}`, "")).toBeUndefined();
  });
});
