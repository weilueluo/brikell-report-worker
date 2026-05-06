import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeManagedInputSchema } from "../../src/agent/managed/managed-tool-schema";

function assertNoDroppedCompatibilityKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoDroppedCompatibilityKeys(item);
    return;
  }

  if (typeof value !== "object" || value === null) return;

  for (const [key, nestedValue] of Object.entries(value)) {
    assert.notEqual(key, "$schema");
    assert.notEqual(key, "$id");
    assert.notEqual(key, "additionalProperties");
    assert.notEqual(key, "default");
    assertNoDroppedCompatibilityKeys(nestedValue);
  }
}

test("passes through a simple provider-owned object schema with descriptions intact", () => {
  const normalized = normalizeManagedInputSchema(
    {
      type: "object",
      properties: {
        serviceId: {
          type: "string",
          description: "Checked-in service identifier.",
          minLength: 1,
        },
        limit: {
          type: "integer",
          description: "Maximum records to return.",
          minimum: 1,
          maximum: 100,
          default: 5,
        },
        status: {
          enum: ["active", "cancelled"],
          description: "Public record status.",
        },
      },
      required: ["serviceId", 42],
      additionalProperties: false,
      $schema: "https://json-schema.org/draft/2020-12/schema",
    },
    { serverName: "provider", toolName: "search" },
  );

  assert.deepEqual(normalized, {
    type: "object",
    properties: {
      serviceId: {
        type: "string",
        description: "Checked-in service identifier.",
        minLength: 1,
      },
      limit: {
        type: "integer",
        description: "Maximum records to return.",
        minimum: 1,
        maximum: 100,
      },
      status: {
        enum: ["active", "cancelled"],
        description: "Public record status.",
      },
    },
    required: ["serviceId"],
  });
  assertNoDroppedCompatibilityKeys(normalized);
});

test("converts const to enum for managed-runtime compatibility", () => {
  const normalized = normalizeManagedInputSchema({
    type: "object",
    properties: {
      type: {
        const: "bbox",
        description: "Geometry selector.",
      },
    },
    required: ["type"],
  });

  assert.deepEqual(normalized.properties.type, {
    enum: ["bbox"],
    description: "Geometry selector.",
  });
});

test("returns an empty object schema when MCP omits an input schema", () => {
  assert.deepEqual(normalizeManagedInputSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(normalizeManagedInputSchema(null), { type: "object", properties: {} });
});

test("rejects malformed or non-object root schemas with tool context", () => {
  assert.throws(
    () => normalizeManagedInputSchema("not a schema", { serverName: "plandata", toolName: "bad_tool" }),
    /plandata\.bad_tool input schema must be a JSON object/,
  );
  assert.throws(
    () => normalizeManagedInputSchema({ type: "string" }, { serverName: "plandata", toolName: "bad_tool" }),
    /plandata\.bad_tool input schema must have root type "object"/,
  );
});

test("rejects provider schemas that need upstream simplification", () => {
  for (const schema of [
    {
      type: "object",
      properties: {
        geometry: { $ref: "#/$defs/Geometry" },
      },
      $defs: {
        Geometry: { type: "object", properties: {} },
      },
    },
    {
      type: "object",
      properties: {
        cursor: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
    },
    {
      type: "object",
      properties: {
        bbox: {
          type: "array",
          items: [{ type: "number" }, { type: "number" }],
        },
      },
    },
  ]) {
    assert.throws(
      () => normalizeManagedInputSchema(schema, { serverName: "provider", toolName: "complex" }),
      /provider\.complex input schema uses unsupported JSON Schema key/,
    );
  }
});
