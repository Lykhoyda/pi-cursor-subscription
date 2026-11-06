import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import cursorExtension from "../src/index.js";

const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.PI_OFFLINE = "1";
  process.env.PI_CURSOR_SYSTEM_CREDENTIALS = "0";
  delete process.env.CURSOR_ACCESS_TOKEN;
});

afterEach(() => {
  process.env = { ...savedEnv };
  unregisterApiProviders("@rahularya01/pi-cursor");
});

async function loadCursor() {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  // Pi's extension API is the registration boundary. Auth resolution below uses
  // the installed Pi runtime and its actual provider composer, without mocks.
  await cursorExtension({
    on() {},
    registerCommand() {},
    registerProvider: (name: string, config: ProviderConfig) => runtime.registerProvider(name, config),
  } as unknown as ExtensionAPI);
  return { runtime, credentials };
}

describe("Cursor authentication in Pi", () => {
  it("makes env-authenticated Cursor models available with an empty Pi credential store", async () => {
    process.env.CURSOR_ACCESS_TOKEN = "synthetic-cursor-env-token";
    const { runtime, credentials } = await loadCursor();

    expect(await runtime.checkAuth("cursor")).toBeDefined();
    expect((await runtime.getAvailable("cursor")).length).toBeGreaterThan(0);
    const auth = await runtime.getAuth("cursor");
    expect(auth?.auth.apiKey).toBe("synthetic-cursor-env-token");
    expect(await credentials.list()).toEqual([]);
  });

  it("refuses missing credentials when system credential reuse is disabled", async () => {
    const { runtime, credentials } = await loadCursor();

    expect(await runtime.checkAuth("cursor")).toBeUndefined();
    expect(await runtime.getAvailable("cursor")).toEqual([]);
    expect(runtime.hasConfiguredAuth("cursor")).toBe(false);
    expect(await credentials.list()).toEqual([]);
  });

  it("resolves the current environment token without storing it", async () => {
    process.env.CURSOR_ACCESS_TOKEN = "synthetic-initial-token";
    const { runtime, credentials } = await loadCursor();
    process.env.CURSOR_ACCESS_TOKEN = "synthetic-replacement-token";

    expect((await runtime.getAuth("cursor"))?.auth.apiKey).toBe("synthetic-replacement-token");
    expect(await credentials.list()).toEqual([]);
  });

  it("keeps existing Pi OAuth authentication available without an environment token", async () => {
    const { runtime, credentials } = await loadCursor();
    await credentials.modify("cursor", async () => ({
      type: "oauth",
      access: "synthetic-oauth-access",
      refresh: "synthetic-oauth-refresh",
      expires: Date.now() + 60 * 60 * 1000,
    }));

    expect((await runtime.checkAuth("cursor"))?.type).toBe("oauth");
    expect(await runtime.getAuth("cursor")).toBeDefined();
    expect((await runtime.getAvailable("cursor")).length).toBeGreaterThan(0);
  });
});
