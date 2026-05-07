export type ManagedToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type ManagedToolDefinition = {
  type: "custom";
  name: string;
  description: string;
  input_schema: ManagedToolInputSchema;
};

export type ManagedToolSchemaContext = {
  serverName?: string;
  toolName?: string;
};

const COMPATIBILITY_DROPPED_SCHEMA_KEYS = new Set(["$schema", "$id", "additionalProperties", "default"]);
const UNSUPPORTED_PROVIDER_SCHEMA_KEYS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "contains",
  "prefixItems",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaLocation(context: ManagedToolSchemaContext | undefined): string {
  const server = context?.serverName?.trim();
  const tool = context?.toolName?.trim();
  if (server && tool) return `${server}.${tool}`;
  return tool || server || "MCP tool";
}

function unsupportedProviderSchemaError(key: string, context: ManagedToolSchemaContext | undefined): Error {
  return new Error(
    `${schemaLocation(context)} input schema uses unsupported JSON Schema key "${key}". Fix the MCP server tool schema/description so it exposes a simple agent-facing root object schema.`,
  );
}

function sanitizeSchema(value: unknown, context: ManagedToolSchemaContext | undefined): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeSchema(item, context));
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (COMPATIBILITY_DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (UNSUPPORTED_PROVIDER_SCHEMA_KEYS.has(key)) throw unsupportedProviderSchemaError(key, context);
    if (key === "const") {
      sanitized.enum = [sanitizeSchema(nestedValue, context)];
      continue;
    }
    if (key === "items" && Array.isArray(nestedValue)) {
      throw unsupportedProviderSchemaError("items[]", context);
    }
    sanitized[key] = sanitizeSchema(nestedValue, context);
  }
  return sanitized;
}

function hasSchemaShape(value: Record<string, unknown>): boolean {
  return "type" in value || "enum" in value || "properties" in value || "items" in value || "description" in value;
}

function ensurePropertySchemas(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ensurePropertySchemas);
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = { ...value };
  if (isRecord(normalized.properties)) {
    normalized.properties = Object.fromEntries(
      Object.entries(normalized.properties).map(([propertyName, propertySchema]) => [propertyName, ensurePropertySchemas(propertySchema)]),
    );
  }
  if ("items" in normalized) normalized.items = ensurePropertySchemas(normalized.items);

  if (!hasSchemaShape(normalized)) return { type: "object", properties: {}, ...normalized };
  return normalized;
}

export function normalizeManagedInputSchema(schema: unknown, context?: ManagedToolSchemaContext): ManagedToolInputSchema {
  if (schema === undefined || schema === null) return { type: "object", properties: {} };
  if (!isRecord(schema)) {
    throw new Error(`${schemaLocation(context)} input schema must be a JSON object.`);
  }

  const sanitized = sanitizeSchema(schema, context);
  const sanitizedSchema = isRecord(sanitized) ? sanitized : {};
  const rootType = sanitizedSchema.type;
  if (rootType !== undefined && rootType !== "object") {
    throw new Error(`${schemaLocation(context)} input schema must have root type "object".`);
  }

  const properties = isRecord(sanitizedSchema.properties)
    ? Object.fromEntries(
        Object.entries(sanitizedSchema.properties).map(([propertyName, propertySchema]) => [propertyName, ensurePropertySchemas(propertySchema)]),
      )
    : {};
  const required = Array.isArray(sanitizedSchema.required)
    ? sanitizedSchema.required.filter((item): item is string => typeof item === "string")
    : undefined;

  return {
    type: "object",
    properties,
    ...(required?.length ? { required } : {}),
  };
}
