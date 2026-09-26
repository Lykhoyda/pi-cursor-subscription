import { expect, it, mock } from "bun:test";

let offered: { id: string }[] = [];
let events: { type: string; delta?: string; reason?: string }[] = [];

mock.module("../src/stream/model-discovery.ts", () => ({
  getCursorModels: async () => offered,
}));
mock.module("../src/stream/native-core.ts", () => ({
  createCursorNativeStream: () => async function* () {
    yield* events;
  },
}));

it("requires an offered model, reply text, and stop completion", async () => {
  const originalToken = process.env.CURSOR_ACCESS_TOKEN;
  const originalModel = process.env.CURSOR_SMOKE_MODEL;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  const output: string[] = [];
  process.env.CURSOR_ACCESS_TOKEN = "test-token";
  delete process.env.CURSOR_SMOKE_MODEL;
  process.exit = ((code: number) => { throw new Error(`exit:${code}`); }) as typeof process.exit;
  console.log = (...args) => { output.push(args.join(" ")); };
  console.error = (...args) => { output.push(args.join(" ")); };
  process.stdout.write = ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stdout.write;

  try {
    const run = async (name: string) => {
      output.length = 0;
      try {
        await import(`../scripts/smoke-stream.mjs?case=${name}`);
      } catch (error) {
        return { exit: (error as Error).message, output: output.join("\n") };
      }
      throw new Error("smoke script did not exit");
    };

    expect(await run("empty-catalog")).toEqual({
      exit: "exit:1",
      output: 'smoke-stream: FAILED — model "default" is not offered to this account (set CURSOR_SMOKE_MODEL)',
    });

    offered = [{ id: "default" }];
    events = [{ type: "done", reason: "stop" }];
    expect(await run("empty-reply")).toMatchObject({ exit: "exit:1" });
    expect(output.join("\n")).toContain("smoke-stream: FAILED — empty reply");

    events = [{ type: "text_delta", delta: "pong" }];
    expect(await run("missing-stop")).toMatchObject({ exit: "exit:1" });
    expect(output.join("\n")).toContain("smoke-stream: FAILED — stream did not stop");

    events = [{ type: "text_delta", delta: "pong" }, { type: "done", reason: "stop" }];
    expect(await run("success")).toMatchObject({ exit: "exit:0" });
    expect(output.join("\n")).toContain("smoke-stream: ok");
  } finally {
    if (originalToken === undefined) delete process.env.CURSOR_ACCESS_TOKEN;
    else process.env.CURSOR_ACCESS_TOKEN = originalToken;
    if (originalModel === undefined) delete process.env.CURSOR_SMOKE_MODEL;
    else process.env.CURSOR_SMOKE_MODEL = originalModel;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
});
