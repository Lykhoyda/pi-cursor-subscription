import { describe, expect, it } from "bun:test";

import { checkPiPrintOutcome, unhandledExecDiagnostic } from "../scripts/smoke-pi-grok.js";
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

  it.each([true, false])("finds the sixth retry without a close (physical IDs: %s)", (ids) => {
    const lifecycle = Array.from({ length: 6 }, (_, index) => {
      const identity = { requestId: "req-1", ...(ids && { bridgeId: index + 1 }) };
      return [
        JSON.stringify({ event: "stream_start", ...identity }),
        ...(index === 5 ? [] : [JSON.stringify({ event: "bridge_close", ...identity })]),
      ];
    })
      .flat()
      .join("\n");
    expect(bridgeCloseGaps(lifecycle)).toEqual({
      started: 6,
      open: [ids ? "req-1 (bridge 6)" : "req-1"],
    });
  });

  it("counts starts from reused writers while tracking the physical bridge once", () => {
    const text = [
      '{"event":"stream_start","requestId":"req-1","bridgeId":1}',
      '{"event":"stream_start","requestId":"req-2","bridgeId":1}',
      '{"event":"bridge_close","requestId":"req-2","bridgeId":1}',
    ].join("\n");
    expect(bridgeCloseGaps(text)).toEqual({ started: 2, open: [] });
  });

  it.each([true, false])("requires the close to follow the start (physical IDs: %s)", (ids) => {
    const identity = { requestId: "req-1", ...(ids && { bridgeId: 1 }) };
    const text = ["bridge_close", "stream_start"]
      .map((event) => JSON.stringify({ event, ...identity }))
      .join("\n");
    expect(bridgeCloseGaps(text).open).toHaveLength(1);
  });
});

describe("Pi print outcome", () => {
  const start = '{"event":"stream_start","requestId":"req-1","bridgeId":1}';
  const close = '{"event":"bridge_close","requestId":"req-1","bridgeId":1}';
  const lifecycle = `${start}\n${close}`;
  const modelId = "grok-4.7";
  const assistant = {
    role: "assistant",
    provider: "cursor",
    api: "cursor-native",
    model: modelId,
    stopReason: "error",
    errorMessage: "Connect error resource_exhausted: fixture refusal",
  };
  const end = (message: object) => JSON.stringify({ type: "message_end", message });
  const transcript = `${end(assistant)}\n{"type":"agent_settled"}`;
  const result = { code: 0, signal: null, stdout: transcript, stderr: "", timedOut: false };
  const input = { modelId, timeoutMs: 120_000 };

  it("accepts only the expected, typed refusal and its matching structured error", () => {
    const errorEvent = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "error", error: assistant },
    });
    expect(
      checkPiPrintOutcome({ ...result, stdout: `${errorEvent}\n${transcript}` }, lifecycle, input),
    ).toEqual({ code: 3, refusal: "resource_exhausted", streams: 1 });
  });

  it("uses a later successful response after refusal", () => {
    const stdout = [
      transcript,
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"pong"}}',
      end({
        ...assistant,
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "pong" }],
      }),
    ].join("\n");
    expect(checkPiPrintOutcome({ ...result, stdout }, lifecycle, input).code).toBe(0);
  });

  it.each([
    { provider: "wrong" },
    { api: "wrong" },
    { model: "wrong" },
    { errorMessage: "Tool failed with 429" },
    { errorMessage: "Connect error unauthenticated: resource_exhausted" },
  ])("fails on mismatched identity or refusal text %j", (change) => {
    const stdout = end({ ...assistant, ...change });
    expect(checkPiPrintOutcome({ ...result, stdout }, lifecycle, input).code).toBe(1);
  });

  it("fails on missing JSON, a torn event, or an independent structured error", () => {
    for (const stdout of [
      "429",
      `${transcript}\n{"type":`,
      `${transcript}\n{"type":"error","errorMessage":"host failed"}`,
    ]) {
      expect(checkPiPrintOutcome({ ...result, stdout }, lifecycle, input).code).toBe(1);
    }
  });

  it("requires settlement after the final refused assistant message", () => {
    const stdout = `${transcript}\n${end(assistant)}`;
    expect(checkPiPrintOutcome({ ...result, stdout }, lifecycle, input)).toMatchObject({
      code: 1,
      reason: "assistant turn did not settle (Cursor usage refused: resource_exhausted)",
    });
  });

  it("fails for a missing retry close, unhandled exec, or missing watcher tool", () => {
    expect(
      checkPiPrintOutcome(
        result,
        `${lifecycle}\n${start.replace('"bridgeId":1', '"bridgeId":2')}`,
        input,
      ).code,
    ).toBe(1);
    expect(
      checkPiPrintOutcome({ ...result, stderr: "UNHANDLED exec case" }, lifecycle, input).code,
    ).toBe(1);
    expect(checkPiPrintOutcome(result, lifecycle, { ...input, missingTools: ["bash"] }).code).toBe(
      1,
    );
  });

  it("fails on a later host exit 1 or a deadline after the same refusal", () => {
    expect(checkPiPrintOutcome({ ...result, code: 1 }, lifecycle, input)).toMatchObject({
      code: 1,
      reason: "exited with code 1 (Cursor usage refused: resource_exhausted)",
    });
    expect(
      checkPiPrintOutcome({ ...result, code: null, timedOut: true }, lifecycle, input),
    ).toMatchObject({
      code: 1,
      reason: "no completion within 120000ms (Cursor usage refused: resource_exhausted)",
    });
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
