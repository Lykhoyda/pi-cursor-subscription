import { afterEach, describe, expect, it } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";

import { AgentClientMessageSchema, type ExecClientMessage } from "../src/proto/agent_pb.js";
import { __testInternals as serverMessageInternals } from "../src/stream/server-messages.js";

const NATIVE_EXEC_ENV = "PI_CURSOR_NATIVE_EXEC";

afterEach(() => {
  delete process.env[NATIVE_EXEC_ENV];
});

describe("privileged native exec policy", () => {
  it("default-denies shell/fetch/write/delete and allows read/ls/grep", () => {
    expect(serverMessageInternals.isNativeExecAllowed("readArgs")).toBe(true);
    expect(serverMessageInternals.isNativeExecAllowed("lsArgs")).toBe(true);
    expect(serverMessageInternals.isNativeExecAllowed("grepArgs")).toBe(true);
    expect(serverMessageInternals.isNativeExecAllowed("shellArgs")).toBe(false);
    expect(serverMessageInternals.isNativeExecAllowed("shellStreamArgs")).toBe(false);
    expect(serverMessageInternals.isNativeExecAllowed("fetchArgs")).toBe(false);
    expect(serverMessageInternals.isNativeExecAllowed("writeArgs")).toBe(false);
    expect(serverMessageInternals.isNativeExecAllowed("deleteArgs")).toBe(false);
    process.env[NATIVE_EXEC_ENV] = "1";
    expect(serverMessageInternals.isNativeExecAllowed("shellArgs")).toBe(true);
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
    expect(result.value.reason).toContain("PI_CURSOR_NATIVE_EXEC=1");
    expect(result.value.reason).toContain("no MCP fallback");
    expect(result.value.reason).not.toContain("Use Pi MCP tools");
  });

  it("names bash when that MCP tool is actually available", () => {
    const frames: Uint8Array[] = [];
    serverMessageInternals.handleExecMessageInner(
      {
        id: 8,
        execId: "exec-8",
        message: { case: "shellArgs", value: { command: "echo hi", workingDirectory: "." } },
      } as never,
      [{ name: "bash", toolName: "bash" }] as never,
      (frame: Uint8Array) => frames.push(frame),
      () => {
        throw new Error("should not execute MCP");
      },
    );
    const answer = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
    const exec = answer.message.value as ExecClientMessage;
    const result = (exec.message.value as { result: { value: { reason?: string } } }).result;
    expect(result.value.reason).toContain('MCP tool "bash"');
    expect(result.value.reason).not.toContain("no MCP fallback");
  });

  it("warns once when a real turn has neither tools nor native exec", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = ((message?: unknown) => {
      warnings.push(String(message));
    }) as typeof console.warn;
    try {
      serverMessageInternals.resetNoExecSurfaceWarning();
      serverMessageInternals.warnIfNoExecSurface(0, false);
      serverMessageInternals.warnIfNoExecSurface(0, false);
      serverMessageInternals.warnIfNoExecSurface(0, true);
      serverMessageInternals.warnIfNoExecSurface(2, false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("no MCP fallback");
      process.env[NATIVE_EXEC_ENV] = "1";
      serverMessageInternals.resetNoExecSurfaceWarning();
      serverMessageInternals.warnIfNoExecSurface(0, false);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = original;
      delete process.env[NATIVE_EXEC_ENV];
      serverMessageInternals.resetNoExecSurfaceWarning();
    }
  });
});
