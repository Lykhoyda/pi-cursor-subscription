import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  AskQuestionArgsSchema,
  AskQuestionInteractionQuerySchema,
  ExaFetchRequestQuerySchema,
  ExaSearchRequestQuerySchema,
  InteractionQuerySchema,
  SwitchModeRequestQuerySchema,
  WebSearchRequestQuerySchema,
  type InteractionResponse,
} from "../src/proto/agent_pb.js";
import { handleInteractionQuery } from "../src/stream/interaction-query.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import type { StreamState } from "../src/stream/types.js";

function clearCursorEnvAliases(): void {
  delete process.env.PI_CURSOR_HOSTED_WEB;
  delete process.env.CURSOR_HOSTED_WEB;
  delete process.env.PI_CURSOR_PROVIDER_HOSTED_WEB;
  delete process.env.PI_CURSOR_NATIVE_EXEC;
  delete process.env.CURSOR_NATIVE_EXEC;
  delete process.env.PI_CURSOR_PROVIDER_NATIVE_EXEC;
}

beforeEach(clearCursorEnvAliases);
afterEach(clearCursorEnvAliases);

function webSearchQuery(id: number) {
  return create(InteractionQuerySchema, {
    id,
    query: {
      case: "webSearchRequestQuery",
      value: create(WebSearchRequestQuerySchema, {}),
    },
  });
}

function exaFetchQuery(id: number) {
  return create(InteractionQuerySchema, {
    id,
    query: {
      case: "exaFetchRequestQuery",
      value: create(ExaFetchRequestQuerySchema, {}),
    },
  });
}

function exaSearchQuery(id: number) {
  return create(InteractionQuerySchema, {
    id,
    query: {
      case: "exaSearchRequestQuery",
      value: create(ExaSearchRequestQuerySchema, {}),
    },
  });
}

function resultCase(frames: Uint8Array[]): string {
  const answer = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
  const response = answer.message.value as InteractionResponse;
  return (response.result.value as { result: { case: string } }).result.case;
}

function readLenDelim(
  bytes: Uint8Array,
  offset = 0,
): { fieldNo: number; value: Uint8Array; next: number } {
  const fieldNo = bytes[offset]! >> 3;
  let length = 0;
  let shift = 0;
  let index = offset + 1;
  while (index < bytes.length) {
    const byte = bytes[index++]!;
    length |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { fieldNo, value: bytes.subarray(index, index + length), next: index + length };
}

describe("handleInteractionQuery", () => {
  it("rejects web search by default", () => {
    const frames: Uint8Array[] = [];
    const result = handleInteractionQuery(webSearchQuery(7), (frame) => frames.push(frame));
    expect(result).toMatchObject({ handled: true, action: "web_search_rejected" });
    expect(frames).toHaveLength(1);
  });

  it("rejects Exa fetch by default", () => {
    const frames: Uint8Array[] = [];
    const result = handleInteractionQuery(exaFetchQuery(9), (frame) => frames.push(frame));
    expect(result).toMatchObject({ handled: true, action: "exa_fetch_rejected" });
    expect(frames).toHaveLength(1);
  });

  it("rejects Exa search by default", () => {
    const frames: Uint8Array[] = [];
    const result = handleInteractionQuery(exaSearchQuery(10), (frame) => frames.push(frame));
    expect(result).toMatchObject({ handled: true, action: "exa_search_rejected" });
    expect(frames).toHaveLength(1);
  });

  it("approves web search when explicitly enabled", () => {
    const frames: Uint8Array[] = [];
    const result = handleInteractionQuery(webSearchQuery(8), (frame) => frames.push(frame), {
      approveWeb: true,
    });
    expect(result).toMatchObject({ handled: true, action: "web_search_approved" });
    expect(frames).toHaveLength(1);
  });

  it("rejects Cursor mode switches", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 4,
      query: {
        case: "switchModeRequestQuery",
        value: create(SwitchModeRequestQuerySchema, {}),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("switch_mode_rejected");
    expect(frames).toHaveLength(1);
  });

  it("skips ask-question interactions instead of hanging", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 3,
      query: {
        case: "askQuestionInteractionQuery",
        value: create(AskQuestionInteractionQuerySchema, {
          args: create(AskQuestionArgsSchema, {}),
        }),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("ask_question_skipped");
    expect(frames).toHaveLength(1);
  });

  it("rejects unnamed proto field #9 by default", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, { id: 11 });
    (
      query as unknown as { $unknown: Array<{ no: number; wireType: number; data: Uint8Array }> }
    ).$unknown = [{ no: 9, wireType: 2, data: new Uint8Array([0x0a, 0x00]) }];
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result).toMatchObject({ handled: true, action: "unknown_field_9_rejected" });
    expect(frames).toHaveLength(1);
    const client = readLenDelim(frames[0]!.subarray(5));
    expect(client.fieldNo).toBe(6);
    expect(client.value[0]).toBe(0x08);
    expect(client.value[1]).toBe(11);
    const field9 = readLenDelim(client.value, 2);
    expect(field9.fieldNo).toBe(9);
    const rejected = readLenDelim(field9.value);
    expect(rejected.fieldNo).toBe(2);
    const reason = readLenDelim(rejected.value);
    expect(reason.fieldNo).toBe(1);
    expect(new TextDecoder().decode(reason.value)).toBe(
      "Not available through the Pi Cursor provider. Use Pi tools (web_search, fetch, bash, etc.) instead.",
    );
  });

  it("fails closed for unknown future interaction fields", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, { id: 13 });
    (
      query as unknown as { $unknown: Array<{ no: number; wireType: number; data: Uint8Array }> }
    ).$unknown = [{ no: 99, wireType: 2, data: new Uint8Array() }];
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result).toMatchObject({ handled: false, action: "unknown_field_99_rejected" });
    expect(frames).toHaveLength(0);
  });
});

describe("hosted web live path", () => {
  function dispatchExaFetch() {
    const frames: Uint8Array[] = [];
    const message = create(AgentServerMessageSchema, {
      message: {
        case: "interactionQuery",
        value: exaFetchQuery(21),
      },
    });
    const state: StreamState = {
      toolCallIndex: 0,
      pendingExecs: [],
      outputTokens: 0,
      totalTokens: 0,
      turnEnded: false,
    };
    const progress = processServerMessage(
      message,
      new Map(),
      [],
      (frame) => frames.push(frame),
      state,
      () => {},
      () => {},
    );
    return { frames, progress };
  }

  it("default-denies Exa fetch on the stream", () => {
    const { frames, progress } = dispatchExaFetch();
    expect(progress).toBe("work");
    expect(resultCase(frames)).toBe("rejected");
  });

  it("approves Exa fetch when PI_CURSOR_HOSTED_WEB=1", () => {
    process.env.PI_CURSOR_HOSTED_WEB = "1";
    const { frames, progress } = dispatchExaFetch();
    expect(progress).toBe("work");
    expect(resultCase(frames)).toBe("approved");
  });

  it("does not treat PI_CURSOR_NATIVE_EXEC=1 as hosted-web opt-in", () => {
    process.env.PI_CURSOR_NATIVE_EXEC = "1";
    expect(resultCase(dispatchExaFetch().frames)).toBe("rejected");
  });
});
