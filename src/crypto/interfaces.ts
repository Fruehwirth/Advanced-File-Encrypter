/**
 * Advanced File Encryption Crypto Interfaces
 *
 * Designed to be extractable as a standalone @fruehwirth/afe-crypto package.
 * No Obsidian dependencies — pure Web Crypto API.
 */

/** Parameters describing how data was encrypted. Stored in .locked files for self-describing decryption. */
export interface EncryptionParams {
  algorithm: string;       // e.g. "AES-GCM"
  keySize: number;         // e.g. 256
  ivLength: number;        // e.g. 16
  keyDerivation: {
    function: string;      // e.g. "PBKDF2"
    hash: string;          // e.g. "SHA-512"
    iterations: number;    // e.g. 210000
    saltLength: number;    // e.g. 16
  };
}

/** Result of an encryption operation. */
export interface EncryptResult {
  /** base64-encoded data: [IV][Salt][Ciphertext] */
  data: string;
  /** The parameters used — to be stored alongside the data */
  params: EncryptionParams;
}

/**
 * Abstract key provider interface.
 * Implementations: PasswordKeyProvider, (future) HardwareSecurityKeyProvider
 */
export interface KeyProvider {
  readonly type: string;
  deriveKey(secret: string, salt: Uint8Array, params: EncryptionParams, extractable: boolean): Promise<CryptoKey>;
}
