import { simpleHash } from "./cryptoUtils";

export function deterministicId(input: string, prefix: string): string {
  const hash = simpleHash(input);
  const extendedHash = simpleHash(hash + input) + simpleHash(input + hash);
  return `${prefix}_${extendedHash.slice(0, 24)}`;
}


