import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const driver = `
  import { mock } from "bun:test";
  mock.module("./src/stream/native-core.ts", () => ({
    getCursorModels: async () => JSON.parse(process.env.TEST_MODELS),
    getCursorParameterizedModels: async () => [],
  }));
  await import("./scripts/smoke-models.mjs");
`;

function run(models: { id: string }[]) {
  return spawnSync(process.execPath, ["-e", driver], {
    cwd: import.meta.dir + "/..",
    encoding: "utf8",
    env: { ...process.env, CURSOR_ACCESS_TOKEN: "invalid-test-token", TEST_MODELS: JSON.stringify(models) },
    timeout: 5_000,
  });
}

it("fails when an invalid token yields no usable models", () => {
  const result = run([]);
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain("smoke-models: ok");
  expect(result.stderr).toContain("smoke-models: FAILED");
});

it("passes when models are returned", () => {
  const result = run([{ id: "default" }]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("smoke-models: ok");
});
