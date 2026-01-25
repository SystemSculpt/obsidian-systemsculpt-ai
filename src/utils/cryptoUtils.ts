/**
 * Converts an ArrayBuffer to a hexadecimal string.
 * @param buffer The ArrayBuffer to convert.
 * @returns The hexadecimal string representation.
 */
function bufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Simple hash function for creating deterministic IDs.
 * Uses a basic hash algorithm that works synchronously without crypto dependencies.
 * @param str The input string to hash.
 * @returns A hexadecimal hash string.
 */
export function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    // Convert to positive number and to hex
    return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Generates a SHA-1 hash for the given text using the Web Crypto API.
 * @param text The input string to hash.
 * @returns A Promise that resolves with the SHA-1 hash as a hexadecimal string.
 * @throws An error if the Web Crypto API (subtle) is unavailable or if hashing fails.
 */
export async function generateSha1Hash(text: string): Promise<string> {
    if (!crypto || !crypto.subtle) {
        throw new Error("Web Crypto API (crypto.subtle) is not available in this environment.");
    }

    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-1', data);
        return bufferToHex(hashBuffer);
    } catch (error) {
        throw new Error(`Failed to generate SHA-1 hash: ${error.message}`);
    }
}

/**
 * Generates a SHA-256 hash for the given text using the Web Crypto API.
 * @param text The input string to hash.
 * @returns A Promise that resolves with the SHA-256 hash as a hexadecimal string.
 * @throws An error if the Web Crypto API (subtle) is unavailable or if hashing fails.
 */
export async function generateSha256Hash(text: string): Promise<string> {
    if (!crypto || !crypto.subtle) {
        throw new Error("Web Crypto API (crypto.subtle) is not available in this environment.");
    }

    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return bufferToHex(hashBuffer);
    } catch (error) {
        throw new Error(`Failed to generate SHA-256 hash: ${error.message}`);
    }
} 