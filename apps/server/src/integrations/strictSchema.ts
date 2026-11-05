// `codex exec --output-schema` sends the schema as an OpenAI strict response format: every object must say
// `additionalProperties: false` and list all its properties as required (checked on codex-cli 0.166.0, which refuses
// anything else with a 400). The board's schemas leave fields out instead, so they are converted on the way in, with
// an optional field made nullable, and the nulls the model then writes for them are dropped on the way out.

type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isObjectSchema = (schema: Schema): boolean =>
  schema.type === "object" || (schema.type === undefined && isSchema(schema.properties));

const required = (schema: Schema): Set<string> =>
  new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);

/** A field that may now be null: its type or enum takes null, or it becomes one of itself and null. */
function nullable(schema: Schema): Schema {
  if (typeof schema.type === "string") {
    const out: Schema = { ...schema, type: [schema.type, "null"] };
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) out.enum = [...schema.enum, null];
    return out;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

const SUBSCHEMA_LISTS = ["anyOf", "oneOf", "allOf"] as const;
const SUBSCHEMA_MAPS = ["$defs", "definitions"] as const;

/** The schema as strict mode takes it. Anything it doesn't know is left as written, for the API to judge. */
export function strictSchema(schema: unknown): unknown {
  if (!isSchema(schema)) return schema;
  const out: Schema = { ...schema };
  if (isObjectSchema(schema) && isSchema(schema.properties)) {
    const req = required(schema);
    const properties: Schema = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const strict = strictSchema(value);
      properties[key] = req.has(key) || !isSchema(strict) ? strict : nullable(strict);
    }
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  } else if (isObjectSchema(schema)) {
    out.additionalProperties = false;
  }
  if (schema.items !== undefined) out.items = strictSchema(schema.items);
  for (const key of SUBSCHEMA_LISTS) {
    const list = schema[key];
    if (Array.isArray(list)) out[key] = list.map(strictSchema);
  }
  for (const key of SUBSCHEMA_MAPS) {
    const map = schema[key];
    if (isSchema(map)) out[key] = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, strictSchema(v)]));
  }
  return out;
}

/**
 * A value written to strictSchema(schema), as the original schema would have it: a null in a field the original
 * left optional is dropped, so the caller's own parser sees the field left out. Nulls the original allows stay.
 */
export function fromStrict(schema: unknown, value: unknown): unknown {
  if (!isSchema(schema)) return value;
  if (Array.isArray(value)) return schema.items === undefined ? value : value.map((v) => fromStrict(schema.items, v));
  if (!isSchema(value) || !isSchema(schema.properties)) return value;
  const req = required(schema);
  const out: Schema = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === null && !req.has(key)) continue;
    out[key] = fromStrict(schema.properties[key], field);
  }
  return out;
}
