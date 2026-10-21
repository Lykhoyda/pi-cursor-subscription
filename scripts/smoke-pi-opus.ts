/**
 * Live Pi + Cursor Opus 5.5 smoke, using the same stream/lifecycle assertions as Grok.
 * Usage: bun run smoke:pi-opus
 *
 * Uses live provider catalog selection and CURSOR_SMOKE_THINKING (default low).
 * CURSOR_SMOKE_MODEL remains a Grok override and does not redirect this smoke.
 * PI_BIN, CURSOR_SMOKE_PROMPT and CURSOR_SMOKE_TIMEOUT_MS work as in smoke:pi-grok.
 */
import { augmentCursorModels } from "../src/models/parameterized.js";
import { processModels, type ProcessedModel } from "../src/models/processing.js";
import { discoverCursorCatalog } from "../src/stream/native-core.js";
import type { PiThinkingLevel } from "../src/types/enums.js";
import {
  buildDist,
  fail,
  log,
  resolveCredentialSource,
  runPi,
  setLogPrefix,
  type Selection,
} from "./smoke-pi-grok.js";

export function selectOpusModel(models: ProcessedModel[], thinking: PiThinkingLevel): Selection {
  const model = ["claude-opus-5-5", "cursor-claude-opus-5-5"]
    .map((id) => models.find((candidate) => candidate.id === id))
    .find((candidate) => candidate !== undefined);
  if (!model) throw new Error("no Opus 5.5 model id registered by this provider");
  if (model.supportsEffort && !model.effortMap?.[thinking]) {
    throw new Error(`thinking level "${thinking}" is not offered for ${model.id}`);
  }
  return { model, thinking };
}

if (import.meta.main) {
  setLogPrefix("smoke-pi-opus");
  try {
    const accessToken = await resolveCredentialSource();
    const catalog = await discoverCursorCatalog(accessToken);
    const models = processModels(augmentCursorModels(catalog.rawModels, catalog.parameterizedModels));
    const selection = selectOpusModel(
      models,
      (process.env.CURSOR_SMOKE_THINKING?.trim() || "low") as PiThinkingLevel,
    );
    const { model, thinking } = selection;
    const effort = model.effortMap?.[thinking];
    const raw = effort ? (model.rawModelByEffort?.[effort] ?? model.id) : model.id;
    log("model", `id=${model.id} thinking=${thinking} -> cursor=${raw}`);
    await buildDist();
    await runPi(selection);
    console.log("smoke-pi-opus: ok");
  } catch (error) {
    fail("opus", error instanceof Error ? error.message : String(error));
  }
}
