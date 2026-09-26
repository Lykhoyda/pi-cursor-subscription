import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const driver = `
  import { mock } from "bun:test";
  mock.module("./src/stream/model-discovery.ts", () => ({
    getCursorModels: async () => JSON.parse(process.env.TEST_OFFERED),
  }));
  mock.module("./src/stream/native-core.ts", () => ({
    createCursorNativeStream: () => async function* () {
      yield* JSON.parse(process.env.TEST_EVENTS);
    },
  }));
  await import("./scripts/smoke-stream.mjs");
`;

function run(offered: { id: string }[], events: object[]) {
  return spawnSync(process.execPath, ["-e", driver], {
    cwd: import.meta.dir + "/..",
    encoding: "utf8",
    env: {
      ...process.env,
      CURSOR_ACCESS_TOKEN: "test-token",
      CURSOR_SMOKE_MODEL: "",
      TEST_OFFERED: JSON.stringify(offered),
      TEST_EVENTS: JSON.stringify(events),
    },
    timeout: 5_000,
  });
}

it("requires an offered model, reply text, and stop completion", () => {
  const absent = run([], []);
  expect(absent.status).toBe(1);
  expect(absent.stderr).toContain('model "default" is not offered to this account (set CURSOR_SMOKE_MODEL)');

  const empty = run([{ id: "default" }], [{ type: "done", reason: "stop" }]);
  expect(empty.status).toBe(1);
  expect(empty.stderr).toContain("smoke-stream: FAILED — empty reply");

  const unfinished = run([{ id: "default" }], [{ type: "text_delta", delta: "pong" }]);
  expect(unfinished.status).toBe(1);
  expect(unfinished.stderr).toContain("smoke-stream: FAILED — stream did not stop");

  const complete = run([{ id: "default" }], [
    { type: "text_delta", delta: "pong" },
    { type: "done", reason: "stop" },
  ]);
  expect(complete.status).toBe(0);
  expect(complete.stdout).toContain("pong");
  expect(complete.stdout).toContain("stop: stop");
  expect(complete.stdout).toContain("smoke-stream: ok");
});
