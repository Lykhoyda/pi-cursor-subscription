import { afterEach, describe, expect, it } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";

import { AgentClientMessageSchema, type ExecClientMessage } from "../src/proto/agent_pb.js";
import {
  isNativeExecAllowed,
  privilegedNativeExecEnabled,
  privilegedNativeExecRejectReason,
} from "../src/stream/native-exec-policy.js";
import { __testInternals as serverMessageInternals } from "../src/stream/server-messages.js";

const NATIVE_EXEC_ENV = "PI_CURSOR_NATIVE_EXEC";

afterEach(() => {
  delete process.env[NATIVE_EXEC_ENV];
});

describe("privileged native exec policy", () => {
  it("allows read/ls/grep without an opt-in", () => {
    expect(isNativeExecAllowed("readArgs")).toBe(true);
    expect(isNativeExecAllowed("lsArgs")).toBe(true);
    expect(isNativeExecAllowed("grepArgs")).toBe(true);
  });

  it("denies shell, fetch, write, and delete by default", () => {
    expect(privilegedNativeExecEnabled()).toBe(false);
    expect(isNativeExecAllowed("shellArgs")).toBe(false);
    expect(isNativeExecAllowed("shellStreamArgs")).toBe(false);
    expect(isNativeExecAllowed("fetchArgs")).toBe(false);
    expect(isNativeExecAllowed("writeArgs")).toBe(false);
    expect(isNativeExecAllowed("deleteArgs")).toBe(false);
  });

  it("allows privileged exec when PI_CURSOR_NATIVE_EXEC=1", () => {
    process.env[NATIVE_EXEC_ENV] = "1";
    expect(privilegedNativeExecEnabled()).toBe(true);
    expect(isNativeExecAllowed("shellArgs")).toBe(true);
  });
});

describe("privileged native exec dispatch", () => {
  it("rejects shellArgs on the stream without spawning", () => {
    const frames: Uint8Array[] = [];
    const handled = serverMessageInternals.handleExecMessageInner(
      {
        id: 7,
        execId: "exec-7",
        message: {
          case: "shellArgs",
          value: { command: "echo should-not-run", workingDirectory: "." },
        },
      } as never,
      [],
      (frame: Uint8Array) => frames.push(frame),
      () => {
        throw new Error("should not execute MCP");
      },
    );
    expect(handled).toBe(true);
    expect(frames).toHaveLength(1);
    const answer = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
    expect(answer.message.case).toBe("execClientMessage");
    const exec = answer.message.value as ExecClientMessage;
    expect(exec.message.case).toBe("shellResult");
    const result = (exec.message.value as { result: { case: string; value: { reason?: string } } })
      .result;
    expect(result.case).toBe("rejected");
    expect(result.value.reason).toContain(privilegedNativeExecRejectReason().slice(0, 40));
  });

  it("still throws for unknown exec shapes", () => {
    const frames: Uint8Array[] = [];
    const handled = serverMessageInternals.handleExecMessageInner(
      { id: 12, execId: "exec-12", message: { case: "futureDestructiveArgs", value: {} } } as never,
      [],
      (frame: Uint8Array) => frames.push(frame),
      () => {
        throw new Error("should not execute");
      },
    );
    expect(handled).toBe(false);
    expect(frames).toHaveLength(1);
  });
});
