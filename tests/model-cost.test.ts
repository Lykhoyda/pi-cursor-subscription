import { describe, expect, it } from "bun:test";
import { estimateModelCost, MODEL_COST_TABLE } from "../src/models/cost.js";

describe("estimateModelCost", () => {
  it("prices Grok 4.7 variants at the 4.7 rate", () => {
    const grok47 = MODEL_COST_TABLE["grok-4.7"];
    expect(estimateModelCost("grok-4.7")).toEqual(grok47);
    expect(estimateModelCost("grok-4.7-fast")).toEqual(grok47);
    expect(estimateModelCost("grok-4.7-500k-max")).toEqual(grok47);
    expect(estimateModelCost("cursor-grok-4.7-high")).toEqual(grok47);
  });

  it("leaves older Grok ids on the previous fallback", () => {
    const previous = MODEL_COST_TABLE["grok-4.20"];
    expect(estimateModelCost("grok-4.20")).toEqual(previous);
    expect(estimateModelCost("grok-4-20")).toEqual(previous);
    expect(estimateModelCost("grok-4.6")).toEqual(previous);
    expect(estimateModelCost("cursor-grok-4.5-high")).toEqual(previous);
  });
});
