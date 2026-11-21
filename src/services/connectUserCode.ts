import { sha256HexFromBytes } from "../utils/sha256";

/**
 * The short code the website's /plugin/connect page asks for before it
 * approves a sign-in. Only the device that started the sign-in can show it, so
 * a connect link someone else sent can't finish with one click (RFC 8628
 * §5.4). Derived from the PKCE challenge, so nothing extra is stored or sent.
 * Keep the context, alphabet and length byte-for-byte equal to the website's
 * src/lib/plugin/connect/userCode.ts.
 */
export const USER_CODE_CONTEXT = "systemsculpt-connect-user-code-v1\n";
/** Crockford base32: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const USER_CODE_LENGTH = 8;

export async function deriveConnectUserCode(challenge: string): Promise<string> {
  const hex = await sha256HexFromBytes(new TextEncoder().encode(USER_CODE_CONTEXT + challenge));
  let code = "";
  let buffer = 0;
  let bits = 0;
  let index = 0;
  while (code.length < USER_CODE_LENGTH) {
    buffer = ((buffer << 8) | Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)) & 0xffff;
    index += 1;
    bits += 8;
    while (bits >= 5 && code.length < USER_CODE_LENGTH) {
      bits -= 5;
      code += ALPHABET[(buffer >> bits) & 31];
    }
  }
  return code;
}

/** `ABCD-EFGH`, as the website shows it. */
export function formatConnectUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
