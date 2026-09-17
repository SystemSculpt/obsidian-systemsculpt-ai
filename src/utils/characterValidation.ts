function isControlCharacterCode(code: number, includeC1: boolean): boolean {
  return code <= 0x1f || code === 0x7f || (includeC1 && code >= 0x80 && code <= 0x9f);
}

export function containsControlCharacters(value: string, includeC1 = false): boolean {
  for (const character of value) {
    if (isControlCharacterCode(character.codePointAt(0) ?? 0, includeC1)) return true;
  }
  return false;
}

export function replaceControlCharacters(
  value: string,
  replacement: string,
  includeC1 = false,
): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += isControlCharacterCode(code, includeC1) ? replacement : character;
  }
  return result;
}

export function containsNonAscii(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
}
