import { afterEach, describe, expect, it } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerAbortSchema,
  ExecServerControlMessageSchema,
  ExecServerMessageSchema,
  ShellArgsSchema,
  type ExecClientMessage,
} from "../src/proto/agent_pb.js";
import { runShellCommand } from "../src/stream/exec-native.js";
import { processServerMessage, type NativeExecAbort } from "../src/stream/server-messages.js";
import type { StreamState } from "../src/stream/types.js";

const NATIVE_EXEC_KEYS = [
  "PI_CURSOR_NATIVE_EXEC",
  "CURSOR_NATIVE_EXEC",
  "PI_CURSOR_PROVIDER_NATIVE_EXEC",
] as const;

function createAbortHandle(): NativeExecAbort {
  let controller = new AbortController();
  return {
    signal: () => controller.signal,
    abort: () => {
      controller.abort();
      controller = new AbortController();
    },
  };
}

function emptyState(): StreamState {
  return {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    turnEnded: false,
  };
}

function shellMessage(command: string) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 1,
        execId: "exec-1",
        message: {
          case: "shellArgs",
          value: create(ShellArgsSchema, { command, workingDirectory: "." }),
        },
      }),
    },
  });
}

function abortMessage() {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerControlMessage",
      value: create(ExecServerControlMessageSchema, {
        message: { case: "abort", value: create(ExecServerAbortSchema, { id: 1 }) },
      }),
    },
  });
}

function shellStdout(frame: Uint8Array): string {
  const answer = fromBinary(AgentClientMessageSchema, frame.subarray(5));
  const exec = answer.message.value as ExecClientMessage;
  const result = (
    exec.message.value as { result: { value: { stdout?: string; stderr?: string } } }
  ).result;
  return `${result.value.stdout ?? ""}${result.value.stderr ?? ""}`;
}

describe("native shell cancellation", () => {
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  function allowNativeExec(): void {
    for (const key of NATIVE_EXEC_KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await runShellCommand("sleep 30", process.cwd(), 30_000, controller.signal);
    expect(result.aborted).toBe(true);
    expect(result.stderr).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it.skipIf(process.platform === "win32")("kills an in-flight shell when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runShellCommand("sleep 30", process.cwd(), 30_000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.skipIf(process.platform === "win32")(
    "an abort control cancels the in-flight shell and the next shell still runs",
    async () => {
      allowNativeExec();
      const handle = createAbortHandle();
      const frames: Uint8Array[] = [];
      let sleepWork: Promise<void> | undefined;
      const started = Date.now();
      const progress = processServerMessage(
        shellMessage("sleep 30"),
        new Map(),
        [],
        (frame) => frames.push(frame),
        emptyState(),
        () => {},
        () => {},
        undefined,
        undefined,
        (work) => {
          sleepWork = work;
        },
        undefined,
        handle,
      );
      expect(progress).toBe("work");
      expect(
        processServerMessage(
          abortMessage(),
          new Map(),
          [],
          () => {},
          emptyState(),
          () => {},
          () => {},
          undefined,
          undefined,
          undefined,
          undefined,
          handle,
        ),
      ).toBe("work");
      await sleepWork;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(frames).toHaveLength(1);
      expect(shellStdout(frames[0]!)).toContain("aborted");

      let echoWork: Promise<void> | undefined;
      processServerMessage(
        shellMessage("echo still-alive"),
        new Map(),
        [],
        (frame) => frames.push(frame),
        emptyState(),
        () => {},
        () => {},
        undefined,
        undefined,
        (work) => {
          echoWork = work;
        },
        undefined,
        handle,
      );
      await echoWork;
      expect(shellStdout(frames[1]!)).toContain("still-alive");
    },
  );
});
