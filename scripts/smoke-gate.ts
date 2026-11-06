/**
 * Pre-PR smoke gate: runs every smoke that can run unattended, each killed from outside at its
 * deadline, and prints one verdict per leg plus `smoke-gate: PASS|FAIL|NOT-RUN`.
 *
 * Usage: bun run smoke:gate   (exit 0 = all passed, 1 = a leg failed, 3 = a leg could not run)
 */
import { getStartupCursorAccessToken } from "../src/extension/auth.js";
import { TransportFailureKind, classifyBridgeExit } from "../src/stream/transport-errors.js";
import { type CursorUsageSummary, getCursorUsageSummary } from "../src/usage.js";
import { redactSecrets } from "../src/utils/security.js";
import { run } from "./smoke-pi-grok.js";

export type LegStatus = "PASS" | "FAIL" | "NOT-RUN";

export interface Verdict {
  status: LegStatus;
  reason?: string;
}

interface Leg {
  name: string;
  script: string;
  deadlineMs: number;
  premium?: boolean;
}

const LEGS: Leg[] = [
  { name: "models", script: "scripts/smoke-models.mjs", deadlineMs: 60_000 },
  { name: "wire", script: "scripts/smoke-wire.mjs", deadlineMs: 60_000 },
  { name: "stream", script: "scripts/smoke-stream.mjs", deadlineMs: 150_000 },
  { name: "pi-grok", script: "scripts/smoke-pi-grok.ts", deadlineMs: 240_000, premium: true },
  {
    name: "pi-firstmate",
    script: "scripts/smoke-pi-firstmate.ts",
    deadlineMs: 300_000,
    premium: true,
  },
];

const TAIL_LINES = 20;

export function premiumQuotaExhausted(summary: CursorUsageSummary): boolean {
  const { plan, onDemand } = summary.individualUsage ?? {};
  const onDemandUsable = onDemand?.enabled === true && onDemand.remaining !== 0;
  return plan?.remaining === 0 && !onDemandUsable;
}

export function classifyLeg(result: {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  deadlineMs: number;
}): Verdict {
  if (result.timedOut) {
    return { status: "FAIL", reason: `no completion within ${result.deadlineMs / 1000}s` };
  }
  if (result.code === 0) return { status: "PASS" };
  const output = `${result.stdout}\n${result.stderr}`;
  const failure = classifyBridgeExit({ exitCode: result.code ?? 1, stderr: output });
  if (failure.kind === TransportFailureKind.RateLimit) {
    return { status: "NOT-RUN", reason: "Cursor usage refused: rate limit or resource_exhausted" };
  }
  const lastLine = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return { status: "FAIL", reason: redactSecrets(lastLine ?? `exit code ${result.code}`) };
}

function formatVerdict(verdict: Verdict): string {
  return verdict.reason ? `${verdict.status} (${verdict.reason})` : verdict.status;
}

async function premiumSkipReason(token: string): Promise<string | undefined> {
  try {
    const summary = await getCursorUsageSummary(async () => token);
    if (premiumQuotaExhausted(summary)) {
      return `Cursor plan usage exhausted until ${summary.billingCycleEnd ?? "the next billing cycle"}`;
    }
  } catch {
    // Usage unknown: run the premium legs and let classification decide.
  }
  return undefined;
}

async function main(): Promise<never> {
  console.log("auth: excluded (interactive sign-in)");
  const verdicts = new Map<string, Verdict>();

  const token = (await getStartupCursorAccessToken())?.accessToken;
  const redact = (text: string) => {
    const redacted = redactSecrets(text);
    return token ? redacted.replaceAll(token, "[redacted]") : redacted;
  };

  if (!token) {
    for (const leg of LEGS) verdicts.set(leg.name, { status: "NOT-RUN", reason: "no Cursor credentials" });
  } else {
    const premiumSkip = await premiumSkipReason(token);
    for (const leg of LEGS) {
      if (leg.premium && premiumSkip) {
        verdicts.set(leg.name, { status: "NOT-RUN", reason: premiumSkip });
        continue;
      }
      if (leg.name === "pi-firstmate" && !process.env.CURSOR_SMOKE_FIRSTMATE?.trim()) {
        verdicts.set(leg.name, { status: "NOT-RUN", reason: "CURSOR_SMOKE_FIRSTMATE not set" });
        continue;
      }
      console.log(`\n── ${leg.name} (deadline ${leg.deadlineMs / 1000}s)`);
      const result = await run(process.execPath, [leg.script], leg.deadlineMs, {
        env: { ...process.env, CURSOR_ACCESS_TOKEN: token },
      });
      const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-TAIL_LINES);
      console.log(redact(tail.join("\n")));
      verdicts.set(leg.name, classifyLeg({ ...result, deadlineMs: leg.deadlineMs }));
    }
  }

  console.log("");
  for (const [name, verdict] of verdicts) console.log(`${name}: ${redact(formatVerdict(verdict))}`);
  const statuses = [...verdicts.values()].map((v) => v.status);
  const overall: LegStatus = statuses.includes("FAIL")
    ? "FAIL"
    : statuses.includes("NOT-RUN")
      ? "NOT-RUN"
      : "PASS";
  console.log(`smoke-gate: ${overall}`);
  process.exit(overall === "PASS" ? 0 : overall === "FAIL" ? 1 : 3);
}

if (import.meta.main) {
  await main();
}
