/**
 * AS-003. The schema as a strict structured output accepts it (OpenAI's
 * strict mode, Anthropic's `json_schema` format): every object closed with
 * `additionalProperties: false`, and `$schema` left out. Strict mode also
 * demands every property be `required`; a zod schema with an optional field
 * cannot say that, so then the schema goes non-strict and the zod parse is
 * the guarantee, as it always is.
 */
export function strictJsonSchema(input: unknown): {
  schema: unknown;
  strict: boolean;
} {
  let strict = true;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== 'object') return node;
    const entries = Object.entries(node).filter(([key]) => key !== '$schema');
    const out: Record<string, unknown> = Object.fromEntries(
      entries.map(([key, value]) => [
        key,
        key === 'properties' && value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(
                ([name, inner]) => [name, visit(inner)],
              ),
            )
          : visit(value),
      ]),
    );
    if (out.type === 'object') {
      out.additionalProperties = false;
      const names = Object.keys((out.properties as object | undefined) ?? {});
      const required = (out.required as string[] | undefined) ?? [];
      if (names.some((name) => !required.includes(name))) strict = false;
    }
    return out;
  };
  const schema = visit(input);
  return { schema, strict };
}
