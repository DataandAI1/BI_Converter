/**
 * Canonical fully-qualified name (spec §5.1): `catalog.schema.object`, lower-cased.
 * Null container levels are skipped; original case is preserved separately on the asset.
 */
export function buildFqn(
  catalog: string | null | undefined,
  schema: string | null | undefined,
  name: string,
): string {
  return [catalog, schema, name]
    .filter((part): part is string => part != null && part !== '')
    .map((part) => part.toLowerCase())
    .join('.');
}
