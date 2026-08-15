export function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

export function parseJsonEnvelope(text) {
  const value = String(text || "").trim();
  if (!value) return undefined;
  try { return JSON.parse(value); }
  catch {}

  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try { return JSON.parse(value.slice(start, end + 1)); }
  catch { return undefined; }
}
