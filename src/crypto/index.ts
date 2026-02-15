/**
 * Flowcrypt Crypto — Public API
 *
 * Standalone encryption/decryption using AES-256-GCM with PBKDF2 key derivation.
 * No Obsidian dependencies. Designed to be extracted as @fruehwirth/flowcrypt-crypto.
 *
 * Wire format of encrypted data (base64-encoded):
 *   [IV (ivLength bytes)][Salt (saltLength bytes)][AES-GCM Ciphertext]
 */

export type { EncryptionParams, EncryptResult, KeyProvider } from "./interfaces";
export { PasswordKeyProvider } from "./password-provider";
export { derivePbkdf2Key, generateSalt, generateIv } from "./key-derivation";
export { aesGcmEncrypt, aesGcmDecrypt } from "./aes-gcm";

import type { EncryptionParams, EncryptResult } from "./interfaces";
import { PasswordKeyProvider } from "./password-provider";
import { generateSalt, generateIv } from "./key-derivation";
import { aesGcmEncrypt, aesGcmDecrypt } from "./aes-gcm";

/** Default encryption parameters for new files. */
export const DEFAULT_ENCRYPTION_PARAMS: EncryptionParams = {
  algorithm: "AES-GCM",
  keySize: 256,
  ivLength: 16,
  keyDerivation: {
    function: "PBKDF2",
    hash: "SHA-512",
    iterations: 210000,
    saltLength: 16,
  },
};

const passwordProvider = new PasswordKeyProvider();

/**
 * Encrypt plaintext with a password.
 *
 * Generates random IV and salt, derives key via PBKDF2, encrypts with AES-GCM.
 * Returns base64-encoded [IV][Salt][Ciphertext] and the parameters used.
 */
export async function encryptText(
  plaintext: string,
  password: string,
  params: EncryptionParams = DEFAULT_ENCRYPTION_PARAMS
): Promise<EncryptResult> {
  const iv = generateIv(params.ivLength);
  const salt = generateSalt(params.keyDerivation.saltLength);
  const key = await passwordProvider.deriveKey(password, salt, params, false);
  const ciphertext = await aesGcmEncrypt(plaintext, key, iv);

  // Pack: [IV][Salt][Ciphertext]
  const packed = new Uint8Array(iv.length + salt.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(salt, iv.length);
  packed.set(ciphertext, iv.length + salt.length);

  const data = uint8ArrayToBase64(packed);
  return { data, params };
}

/**
 * Decrypt base64-encoded data with a password.
 *
 * Reads IV and salt from the data, derives key, decrypts.
 * Returns plaintext string or null if the password is wrong.
 */
export async function decryptText(
  base64Data: string,
  password: string,
  params: EncryptionParams
): Promise<string | null> {
  const packed = base64ToUint8Array(base64Data);
  const ivLen = params.ivLength;
  const saltLen = params.keyDerivation.saltLength;

  if (packed.length < ivLen + saltLen + 1) {
    return null;
  }

  const iv = packed.slice(0, ivLen);
  const salt = packed.slice(ivLen, ivLen + saltLen);
  const ciphertext = packed.slice(ivLen + saltLen);

  const key = await passwordProvider.deriveKey(password, salt, params, false);
  return aesGcmDecrypt(ciphertext, key, iv);
}

/**
 * Decrypt using a pre-derived CryptoKey (for "Keys Only" session mode).
 * The caller must provide the correct key for the file's salt.
 */
export async function decryptTextWithKey(
  base64Data: string,
  key: CryptoKey,
  params: EncryptionParams
): Promise<string | null> {
  const packed = base64ToUint8Array(base64Data);
  const ivLen = params.ivLength;
  const saltLen = params.keyDerivation.saltLength;

  if (packed.length < ivLen + saltLen + 1) {
    return null;
  }

  const iv = packed.slice(0, ivLen);
  const ciphertext = packed.slice(ivLen + saltLen);

  return aesGcmDecrypt(ciphertext, key, iv);
}

/**
 * Derive a CryptoKey from password and the salt embedded in encrypted data.
 * Useful for caching the key without caching the password.
 */
export async function deriveKeyFromData(
  base64Data: string,
  password: string,
  params: EncryptionParams,
  extractable: boolean = false
): Promise<CryptoKey | null> {
  const packed = base64ToUint8Array(base64Data);
  const ivLen = params.ivLength;
  const saltLen = params.keyDerivation.saltLength;

  if (packed.length < ivLen + saltLen + 1) {
    return null;
  }

  const salt = packed.slice(ivLen, ivLen + saltLen);
  return passwordProvider.deriveKey(password, salt, params, extractable);
}

// --- Base64 utilities ---

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
