/**
 * Query strings are always text, so "false" must not become true the way Boolean("false") does.
 * Accepts true/false, "true"/"false", "1"/"0" and 1/0 (any letter case). An empty value counts as omitted.
 * Anything else is returned unchanged so @IsBoolean rejects it with a 400 instead of guessing.
 */
export function parseBool(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return value;
}
