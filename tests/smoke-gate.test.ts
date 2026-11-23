import { describe, expect, it } from "bun:test";

import { classifyLeg, premiumQuotaExhausted } from "../scripts/smoke-gate.js";

const leg = { code: 1, stdout: "", stderr: "", timedOut: false, deadlineMs: 60_000 };

describe("classifyLeg", () => {
  it("passes a leg that exited 0", () => {
    expect(classifyLeg({ ...leg, code: 0 })).toEqual({ status: "PASS" });
  });

  it("fails a leg the gate killed at its deadline", () => {
    expect(classifyLeg({ ...leg, code: null, timedOut: true, deadlineMs: 150_000 })).toEqual({
      status: "FAIL",
      reason: "no completion within 150s",
    });
  });

  it("reports a Cursor usage refusal as not run, never as passed", () => {
    expect(classifyLeg({ ...leg, stderr: "Connect error resource_exhausted: Error" })).toEqual({
      status: "NOT-RUN",
      reason: "Cursor usage refused: rate limit or resource_exhausted",
    });
  });

  it("fails any other non-zero exit with its last output line", () => {
    const stdout = "models: 241\nsmoke-wire: FAILED — response did not decode\n\n";
    expect(classifyLeg({ ...leg, stdout })).toEqual({
      status: "FAIL",
      reason: "smoke-wire: FAILED — response did not decode",
    });
  });

  it("requires exit 3 and the exact marker from the expected Pi leg", () => {
    const name = "pi-grok";
    const stdout = "[smoke-pi-grok] NOT RUN pi: Cursor usage refused (resource_exhausted)\n";
    expect(classifyLeg({ ...leg, name, code: 3, stdout })).toEqual({
      status: "NOT-RUN",
      reason: "Cursor usage refused (resource_exhausted)",
    });
    for (const code of [0, 1, null]) {
      expect(classifyLeg({ ...leg, name, code, stdout }).status).toBe("FAIL");
    }
    expect(classifyLeg({ ...leg, name: "pi-firstmate", code: 3, stdout }).status).toBe("FAIL");
    expect(classifyLeg({ ...leg, name, code: 3, stdout: `prefix ${stdout}` }).status).toBe("FAIL");
    expect(classifyLeg({ ...leg, name, code: 1, stderr: "failed while logging 429" }).status).toBe(
      "FAIL",
    );
    expect(classifyLeg({ ...leg, name, code: 3, stdout, timedOut: true }).reason).toBe(
      "no completion within 60s",
    );
  });
});

describe("premiumQuotaExhausted", () => {
  it("is exhausted when the plan has nothing left and no on-demand", () => {
    expect(premiumQuotaExhausted({ individualUsage: { plan: { remaining: 0 } } })).toBe(true);
  });

  it("is not exhausted when on-demand is enabled with budget left", () => {
    const summary = {
      individualUsage: { plan: { remaining: 0 }, onDemand: { enabled: true, remaining: 500 } },
    };
    expect(premiumQuotaExhausted(summary)).toBe(false);
  });

  it("is not exhausted while the plan has budget left", () => {
    expect(premiumQuotaExhausted({ individualUsage: { plan: { remaining: 1200 } } })).toBe(false);
  });

  it("is not exhausted when the summary has no usage data", () => {
    expect(premiumQuotaExhausted({})).toBe(false);
  });
});
