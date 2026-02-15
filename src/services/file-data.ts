/**
 * .locked file format — encode, decode, parse.
 *
 * The file is fully self-describing: it contains all encryption parameters
 * needed to decrypt without the plugin (using any standard crypto library).
 *
 * Format (v2 - current):
 * {
 *   "format": "advanced-file-encryption",
 *   "version": 2,
 *   "encryption": { algorithm, keySize, ivLength, keyDerivation: { function, hash, iterations, saltLength } },
 *   "keyType": "password",
 *   "hint": "optional password hint",
 *   "data": "base64([IV][Salt][Ciphertext])"
 * }
 *
 * Legacy format (v1 - backward compatible):
 * {
 *   "format": "file-encrypt-plus",
 *   "version": 1,
 *   ... (same structure)
 * }
 */

import {
  encryptText,
  decryptText,
  DEFAULT_ENCRYPTION_PARAMS,
} from "../crypto/index";
import type { EncryptionParams } from "../crypto/index";

// Legacy format constants for backward compatibility
export const LEGACY_FEP_FORMAT = "file-encrypt-plus";
export const LEGACY_FEP_VERSION = 1;

// Current format constants
export const AFE_FORMAT = "advanced-file-encryption";
export const AFE_VERSION = 2;
export const LOCKED_EXTENSION = "locked";

/** Marker format for newly created notes that need initial password setup. */
export const AFE_PENDING_FORMAT = "advanced-file-encryption-pending";

/**
 * Create a placeholder .locked file content for a note that hasn't been
 * encrypted yet. The view detects this marker and shows the inline encrypt card.
 */
export function createPendingFile(): string {
  return JSON.stringify({
    format: AFE_PENDING_FORMAT,
    version: AFE_VERSION,
  });
}

/**
 * Check if raw file content is a pending (uninitialized) encrypted note.
 */
export function isPendingFile(raw: string): boolean {
  try {
    const data = JSON.parse(raw);
    return data.format === AFE_PENDING_FORMAT;
  } catch {
    return false;
  }
}

export interface AFEFileData {
  format: string;
  version: number;
  encryption: EncryptionParams;
  keyType: string;
  hint: string;
  data: string;
}

/**
 * Check if file data needs migration to the current format.
 * Returns true for legacy format or old version numbers.
 */
export function needsMigration(data: AFEFileData): boolean {
  return data.format === LEGACY_FEP_FORMAT || data.version < AFE_VERSION;
}

/**
 * Encrypt plaintext and produce a complete .locked JSON string.
 * Always writes the current format (v2).
 */
export async function encode(
  plaintext: string,
  password: string,
  hint: string = ""
): Promise<string> {
  const result = await encryptText(plaintext, password, DEFAULT_ENCRYPTION_PARAMS);

  const fileData: AFEFileData = {
    format: AFE_FORMAT,
    version: AFE_VERSION,
    encryption: result.params,
    keyType: "password",
    hint,
    data: result.data,
  };

  return JSON.stringify(fileData, null, 2);
}

/**
 * Parse a .locked JSON string and decrypt the content.
 * Returns null if the password is wrong or data is corrupted.
 */
export async function decode(
  jsonString: string,
  password: string
): Promise<string | null> {
  const fileData = parse(jsonString);
  return decryptText(fileData.data, password, fileData.encryption);
}

/**
 * Parse a .locked JSON string into structured metadata WITHOUT decrypting.
 * Useful for reading the hint and encryption params before prompting for password.
 * Accepts both current format (v2) and legacy format (v1) for backward compatibility.
 */
export function parse(raw: string): AFEFileData {
  const data = JSON.parse(raw);

  // Accept both current format and legacy format
  if (data.format !== AFE_FORMAT && data.format !== LEGACY_FEP_FORMAT) {
    throw new Error(`Not an Advanced File Encryption file: format is "${data.format}"`);
  }

  return data as AFEFileData;
}

/**
 * Check if a raw string looks like a .locked file.
 * Accepts both current format (v2) and legacy format (v1) for backward compatibility.
 */
export function isEncryptedFile(raw: string): boolean {
  try {
    const data = JSON.parse(raw);
    return data.format === AFE_FORMAT || data.format === LEGACY_FEP_FORMAT;
  } catch {
    return false;
  }
}
