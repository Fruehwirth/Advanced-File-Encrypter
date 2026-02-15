/**
 * Key derivation utilities using Web Crypto API.
 * PBKDF2 with configurable parameters.
 */

const encoder = new TextEncoder();

/**
 * Derive an AES-GCM CryptoKey from a password using PBKDF2.
 *
 * @param password - User password
 * @param salt - Random salt (must be unique per encryption)
 * @param iterations - PBKDF2 iteration count
 * @param hash - Hash algorithm for PBKDF2 (e.g. "SHA-512")
 * @param keyBits - AES key size in bits (e.g. 256)
 * @param extractable - If false, the key material cannot be read back from JS.
 *                      Always use false in production for security.
 */
export async function derivePbkdf2Key(
  password: string,
  salt: Uint8Array,
  iterations: number,
  hash: string,
  keyBits: number,
  extractable: boolean
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return (crypto.subtle.deriveKey as any)(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash,
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: keyBits,
    },
    extractable,
    ["encrypt", "decrypt"]
  );
}

/** Generate cryptographically random bytes for salt. */
export function generateSalt(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Generate cryptographically random bytes for IV. */
export function generateIv(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
