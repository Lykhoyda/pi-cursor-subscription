import { describe, expect, it } from "bun:test";
import { selectOpusModel } from "../scripts/smoke-pi-opus.js";
import { processModels } from "../src/models/processing.js";

const catalog = processModels([
  { id: "grok-4.7-low", name: "Grok 4.7 Low", reasoning: true, contextWindow: 256000, maxTokens: 8192 },
  { id: "claude-opus-5-5-low", name: "Opus 5.5 Low", reasoning: true, contextWindow: 200000, maxTokens: 8192 },
  { id: "claude-opus-5-5-high", name: "Opus 5.5 High", reasoning: true, contextWindow: 200000, maxTokens: 8192 },
]);

describe("Opus Pi smoke selection", () => {
  it("selects Opus 5.5 independently of the shared Grok smoke override", () => {
    const previous = process.env.CURSOR_SMOKE_MODEL;
    process.env.CURSOR_SMOKE_MODEL = "grok-4.7";
    try {
      const selection = selectOpusModel(catalog, "low");
      expect(selection.model.id).toBe("claude-opus-5-5");
      expect(selection.thinking).toBe("low");
      expect(selection.model.rawModelByEffort?.low).toBe("claude-opus-5-5-low");
    } finally {
      if (previous === undefined) delete process.env.CURSOR_SMOKE_MODEL;
      else process.env.CURSOR_SMOKE_MODEL = previous;
    }
  });

  it("fails when no Opus 5.5 model is offered rather than selecting Grok", () => {
    expect(() => selectOpusModel(catalog.filter((m) => m.id === "grok-4.7"), "low"))
      .toThrow("no Opus 5.5 model");
  });

  it("fails when the selected thinking level is not supported", () => {
    expect(() => selectOpusModel(catalog, "max")).toThrow("not offered");
  });
});
