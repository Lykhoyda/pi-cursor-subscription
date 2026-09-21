import { describe, expect, it } from "bun:test";
import type { CursorParameterizedModel } from "../src/client/cursor-wire.js";
import { augmentCursorModels } from "../src/models/parameterized.js";
import { processModels } from "../src/models/processing.js";
import type { CursorModel } from "../src/stream/model-discovery.js";

function raw(id: string, name: string, contextWindow = 200_000): CursorModel {
  return { id, name, reasoning: false, contextWindow, maxTokens: 64_000 };
}

const grok46: CursorParameterizedModel = {
  name: "grok-4.6",
  clientDisplayName: "Cursor Grok 4.6",
  supportsMaxMode: true,
  supportsNonMaxMode: true,
  contextTokenLimit: 256_000,
  contextTokenLimitForMaxMode: 256_000,
  variants: [
    {
      parameters: [
        { id: "effort", value: "low" },
        { id: "fast", value: "false" },
      ],
      isMaxMode: false,
    },
    {
      parameters: [
        { id: "effort", value: "medium" },
        { id: "fast", value: "false" },
      ],
      isMaxMode: false,
    },
    {
      parameters: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
      isMaxMode: false,
    },
  ],
};

describe("augmentCursorModels context overlay", () => {
  it("copies parameterized contextTokenLimit onto cursor-prefixed GetUsableModels rows", () => {
    const augmented = augmentCursorModels(
      [
        raw("cursor-grok-4.6-high", "Cursor Grok 4.6"),
        raw("cursor-grok-4.6-medium", "Cursor Grok 4.6 Medium"),
        raw("cursor-grok-4.6-low", "Cursor Grok 4.6 Low"),
      ],
      [grok46],
    );

    const prefixed = augmented.filter((model) => model.id.startsWith("cursor-grok-4.6"));
    expect(prefixed).toHaveLength(3);
    for (const model of prefixed) expect(model.contextWindow).toBe(256_000);

    const collapsed = processModels(augmented).find((model) => model.id === "cursor-grok-4.6");
    expect(collapsed?.contextWindow).toBe(256_000);
  });

  it("does not invent cursor-prefixed rows when GetUsableModels omitted them", () => {
    const augmented = augmentCursorModels([], [grok46]);
    expect(augmented.some((model) => model.id.startsWith("cursor-"))).toBe(false);
    expect(augmented.some((model) => model.id.startsWith("grok-4.6"))).toBe(true);
  });
});

describe("Grok 4.7 parameterized catalog", () => {
  const efforts = ["low", "medium", "high", "xhigh"] as const;
  const grok47: CursorParameterizedModel = {
    name: "grok-4.7",
    clientDisplayName: "Grok 4.7",
    supportsImages: false,
    supportsMaxMode: true,
    supportsNonMaxMode: true,
    contextTokenLimit: 500_000,
    variants: [
      ...efforts.flatMap((effort) => [
        {
          isMaxMode: false,
          parameters: [
            { id: "context", value: "256k" },
            { id: "reasoning_effort", value: effort },
            { id: "fast", value: "false" },
          ],
        },
        {
          isMaxMode: true,
          parameters: [
            { id: "context", value: "500k" },
            { id: "reasoning_effort", value: effort },
            { id: "fast", value: "false" },
          ],
        },
      ]),
    ],
  };

  const rawGrok47 = efforts.map((effort) =>
    raw(`grok-4.7-${effort}`, `Grok 4.7  ${effort === "xhigh" ? "Extra High" : effort}`),
  );

  it("registers the 256K default and the 500K Max Mode row with reasoning_effort", () => {
    const processed = processModels(augmentCursorModels(rawGrok47, [grok47]));
    const standard = processed.find((model) => model.id === "grok-4.7");
    const extended = processed.find((model) => model.id === "grok-4.7-500k-max");

    expect(standard?.contextWindow).toBe(256_000);
    expect(standard?.supportsImages).toBe(false);
    expect(standard?.effortMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
    expect(standard?.rawRoutingByEffort?.high).toMatchObject({
      modelId: "grok-4.7",
      requestedMaxMode: false,
      parameters: [
        { id: "context", value: "256k" },
        { id: "reasoning_effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    });

    expect(extended?.contextWindow).toBe(500_000);
    expect(extended?.rawRoutingByEffort?.xhigh).toMatchObject({
      modelId: "grok-4.7",
      requestedMaxMode: true,
      parameters: [
        { id: "context", value: "500k" },
        { id: "reasoning_effort", value: "xhigh" },
        { id: "fast", value: "false" },
      ],
    });
    expect(
      processed.some((model) => model.id.startsWith("grok-4.7") && model.contextWindow === 200_000),
    ).toBe(false);
  });
});
