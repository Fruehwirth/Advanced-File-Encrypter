/**
 * .flwct file format — encode, decode, parse.
 *
 * The file is fully self-describing: it contains all encryption parameters
 * needed to decrypt without the plugin (using any standard crypto library).
 *
 * Format:
 * {
 *   "format": "flowcrypt",
 *   "version": 1,
 *   "encryption": { algorithm, keySize, ivLength, keyDerivation: { function, hash, iterations, saltLength } },
 *   "keyType": "password",
 *   "hint": "optional password hint",
 *   "data": "base64([IV][Salt][Ciphertext])"
 * }
 */

import {
  encryptText,
  decryptText,
  DEFAULT_ENCRYPTION_PARAMS,
} from "../crypto/index";
import type { EncryptionParams } from "../crypto/index";

export const FLOWCRYPT_FORMAT = "flowcrypt";
export const FLOWCRYPT_VERSION = 1;
export const FLWCT_EXTENSION = "flwct";

export interface FlowcryptFileData {
  format: string;
  version: number;
  encryption: EncryptionParams;
  keyType: string;
  hint: string;
  data: string;
}

/**
 * Encrypt plaintext and produce a complete .flwct JSON string.
 */
export async function encode(
  plaintext: string,
  password: string,
  hint: string = ""
): Promise<string> {
  const result = await encryptText(plaintext, password, DEFAULT_ENCRYPTION_PARAMS);

  const fileData: FlowcryptFileData = {
    format: FLOWCRYPT_FORMAT,
    version: FLOWCRYPT_VERSION,
    encryption: result.params,
    keyType: "password",
    hint,
    data: result.data,
  };

  return JSON.stringify(fileData, null, 2);
}

/**
 * Parse a .flwct JSON string and decrypt the content.
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
 * Parse a .flwct JSON string into structured metadata WITHOUT decrypting.
 * Useful for reading the hint and encryption params before prompting for password.
 */
export function parse(raw: string): FlowcryptFileData {
  const data = JSON.parse(raw);

  if (data.format !== FLOWCRYPT_FORMAT) {
    throw new Error(`Not a Flowcrypt file: format is "${data.format}"`);
  }

  return data as FlowcryptFileData;
}

/**
 * Check if a raw string looks like a .flwct file.
 */
export function isFlowcryptFile(raw: string): boolean {
  try {
    const data = JSON.parse(raw);
    return data.format === FLOWCRYPT_FORMAT;
  } catch {
    return false;
  }
}
