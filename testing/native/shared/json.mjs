export function stripUtf8Bom(value) {
  const text = String(value ?? "");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseJsonText(value) {
  return JSON.parse(stripUtf8Bom(value));
}
