import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";

import { GetUsableModelsResponseSchema } from "../src/proto/agent_pb.js";
import { decodeUsableModelsResponse } from "../src/stream/model-discovery.js";

const plain = toBinary(
  GetUsableModelsResponseSchema,
  create(GetUsableModelsResponseSchema, {
    models: [{ modelId: "default" }, { modelId: "gpt-5" }],
  }),
);

function connectFrame(message: Uint8Array): Uint8Array {
  const framed = new Uint8Array(5 + message.length);
  new DataView(framed.buffer).setUint32(1, message.length, false);
  framed.set(message, 5);
  return framed;
}

describe("decodeUsableModelsResponse", () => {
  it("decodes a plain protobuf body", () => {
    expect(decodeUsableModelsResponse(plain)?.models.map((m) => m.modelId)).toEqual([
      "default",
      "gpt-5",
    ]);
  });

  it("decodes a Connect-framed body", () => {
    expect(
      decodeUsableModelsResponse(connectFrame(plain))?.models.map((m) => m.modelId),
    ).toEqual(["default", "gpt-5"]);
  });

  it("returns null for a body that is neither", () => {
    expect(decodeUsableModelsResponse(new Uint8Array([0xff, 0xff, 0xff]))).toBeNull();
  });
});
