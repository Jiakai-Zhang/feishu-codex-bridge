export function nodeVersionSupported(value) {
  const match = String(value || "").match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const [, majorText, minorText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  return major > 22 || (major === 22 && minor >= 13);
}
