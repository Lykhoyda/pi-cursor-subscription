import { create, fromBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  ShellArgsSchema,
} from "../../src/proto/agent_pb.js";
import { shellEnv } from "../../src/stream/exec-native.js";
import { processServerMessage } from "../../src/stream/server-messages.js";

for (const mode of ["deny", "extended"] as const) {
  const shellEnvExtra =
    mode === "extended"
      ? ["DEMO_COLOR", "DEMO_EMPTY", "DEMO_MISSING", "DEMO_TOKEN", "PI_CURSOR_SHELL_ENV_EXTRA"]
      : undefined;
  const env = shellEnv(process.env, shellEnvExtra);
  if (Object.hasOwn(env, "USERDOMAIN") || Object.hasOwn(env, "DEMO_UNUSED")) {
    throw new Error("Unexpected entry in native shell spawn map");
  }

  for (const kind of ["shellArgs", "shellStreamArgs"] as const) {
    const args = Object.assign(
      create(ShellArgsSchema, {
        command: `bun --no-env-file ./shell-probe.ts ${mode}`,
        workingDirectory: ".",
      }),
      { env: { DEMO_COLOR: "green", DEMO_UNUSED: "green", DEMO_MISSING: "green" } },
    );
    const msg = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: 1,
          execId: "fixture",
          message: { case: kind, value: args },
        }),
      },
    });
    const work: Promise<void>[] = [];
    const frames: Uint8Array[] = [];
    processServerMessage(
      msg,
      new Map(),
      [],
      (frame) => frames.push(frame),
      { toolCallIndex: 0, pendingExecs: [], outputTokens: 0, totalTokens: 0, turnEnded: false },
      () => {},
      () => {},
      undefined,
      undefined,
      (pending) => work.push(pending),
      undefined,
      undefined,
      shellEnvExtra,
    );
    if (work.length !== 1) throw new Error("Native shell dispatch did not start");
    await work[0];
    const replies = frames.map((frame) => fromBinary(AgentClientMessageSchema, frame.subarray(5)));
    const execs = replies.flatMap((reply) =>
      reply.message.case === "execClientMessage" ? [reply.message.value.message] : [],
    );
    if (kind === "shellArgs") {
      const result = execs[0];
      if (
        execs.length !== 1 ||
        result?.case !== "shellResult" ||
        result.value.result.case !== "success" ||
        result.value.result.value.stdout.trim() !== "SHELL_ENV_PASS"
      ) {
        throw new Error("Native shell result fixture failed");
      }
    } else {
      const events = execs.flatMap((reply) =>
        reply.case === "shellStream" ? [reply.value.event] : [],
      );
      const output = events[1];
      const terminal = events[2];
      if (
        events.length !== 3 ||
        events[0]?.case !== "start" ||
        output?.case !== "stdout" ||
        output.value.data.trim() !== "SHELL_ENV_PASS" ||
        terminal?.case !== "exit" ||
        terminal.value.code !== 0
      ) {
        throw new Error("Native shell stream fixture failed");
      }
    }
  }
}

console.log("NATIVE_SHELL_DISPATCH_PASS");
