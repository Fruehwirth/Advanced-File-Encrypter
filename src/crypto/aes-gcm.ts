/**
 * AES-256-GCM encryption and decryption.
 * Uses Web Crypto API — no external dependencies.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encrypt plaintext using AES-GCM.
 *
 * @param plaintext - UTF-8 string to encrypt
 * @param key - AES-GCM CryptoKey (from key derivation)
 * @param iv - Initialization vector (must be unique per encryption)
 * @returns Encrypted ciphertext as Uint8Array
 */
export async function aesGcmEncrypt(
  plaintext: string,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const encoded = encoder.encode(plaintext);
  const encrypted = await (crypto.subtle.encrypt as any)(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  return new Uint8Array(encrypted);
}

/**
 * Decrypt ciphertext using AES-GCM.
 *
 * @param ciphertext - Encrypted data
 * @param key - AES-GCM CryptoKey (same key used for encryption)
 * @param iv - Initialization vector (same IV used for encryption)
 * @returns Decrypted UTF-8 string, or null if decryption fails (wrong key/data)
 */
export async function aesGcmDecrypt(
  ciphertext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<string | null> {
  try {
    const decrypted = await (crypto.subtle.decrypt as any)(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return decoder.decode(decrypted);
  } catch {
    return null;
  }
}
