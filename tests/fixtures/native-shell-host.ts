import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Api, Model, Provider, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { frameConnectMessage, type BridgeHandle } from "../../src/client/bridge.js";
import activate from "../../src/index.js";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  ShellArgsSchema,
  type AgentServerMessage,
} from "../../src/proto/agent_pb.js";
import { setBridgeFactoryForTests } from "../../src/stream/bridge-session.js";

function shellBridge(command: string, recordReply: (passed: boolean) => void): BridgeHandle {
  let alive = true;
  let data: (frame: Buffer) => void;
  let close: (code: number) => void;
  const send = (message: AgentServerMessage["message"]) =>
    data(
      frameConnectMessage(
        toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message })),
      ),
    );
  const end = () => {
    if (!alive) return;
    alive = false;
    close(0);
  };
  return {
    get alive() {
      return alive;
    },
    proc: {
      kill: () => {
        end();
        return true;
      },
    },
    lastStderr: () => "",
    end,
    onClose: (callback) => {
      close = callback;
    },
    onData: (callback) => {
      data = callback;
      queueMicrotask(() =>
        send({
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, {
            id: 1,
            execId: "fixture",
            message: {
              case: "shellArgs",
              value: create(ShellArgsSchema, { command, workingDirectory: "." }),
            },
          }),
        }),
      );
    },
    write: (frame) => {
      const { message } = fromBinary(AgentClientMessageSchema, frame.subarray(5));
      if (message.case !== "execClientMessage") return;
      const reply = message.value.message;
      recordReply(
        reply.case === "shellResult" &&
          reply.value.result.case === "success" &&
          reply.value.result.value.stdout.trim() === "SHELL_ENV_PASS",
      );
      queueMicrotask(() => {
        send({
          case: "interactionUpdate",
          value: create(InteractionUpdateSchema, {
            message: { case: "textDelta", value: { text: "ok" } },
          }),
        });
        send({
          case: "interactionUpdate",
          value: create(InteractionUpdateSchema, { message: { case: "turnEnded", value: {} } }),
        });
        end();
      });
    },
  };
}

// The real extension uses the real Pi API. Capture its registered stream so
// these local probes can inject messages at the existing in-memory bridge seam.
export default async function (pi: ExtensionAPI): Promise<void> {
  const proof = "host-shell-proof.txt";
  const grant = process.env.HOST_PROBE_GRANT === "1";
  let registered: ProviderConfig | undefined;
  await activate({
    ...pi,
    registerProvider(...args: [Provider<Api>] | [string, ProviderConfig]) {
      if (args.length === 1) {
        pi.registerProvider(args[0]);
        return;
      }
      if (args[0] === "cursor") registered = args[1];
      pi.registerProvider(...args);
    },
  });

  async function probe(phase: string, mode: "allow" | "deny") {
    const stream = registered?.streamSimple;
    const model = registered?.models?.[0];
    if (!stream || !model) throw new Error("Cursor provider missing from host fixture");
    let passed = false;
    setBridgeFactoryForTests(() =>
      shellBridge(`bun --no-env-file ./shell-probe.ts ${mode}`, (result) => {
        passed = result;
      }),
    );
    try {
      const result = await stream(
        { ...model, provider: "cursor", baseUrl: registered?.baseUrl } as Model<Api>,
        {
          messages: [{ role: "user", content: "local shell probe", timestamp: Date.now() }],
        } as TranscriptContext,
        { sessionId: crypto.randomUUID() },
      ).result();
      if (!passed || result.stopReason !== "stop") {
        appendFileSync(proof, "failed\n");
        throw new Error("Host shell probe failed");
      }
      appendFileSync(proof, `${phase}\n`);
    } finally {
      setBridgeFactoryForTests();
    }
  }

  if (
    process.env.HOST_PROBE_AMBIENT === "1" &&
    process.env.PI_CURSOR_SHELL_ENV_EXTRA !== "DEMO_COLOR"
  ) {
    throw new Error("Ambient name list missing from host fixture");
  }
  await probe("before", "deny");
  pi.on("session_start", () => probe("started", grant ? "allow" : "deny"));
  pi.registerCommand("reload-shell-probe", {
    description: "Reload the offline shell probe",
    handler: (_args, ctx) => ctx.reload(),
  });
}
