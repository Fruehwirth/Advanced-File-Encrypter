/**
 * Password-based KeyProvider implementation.
 * Derives AES-GCM keys from passwords using PBKDF2.
 */

import type { EncryptionParams, KeyProvider } from "./interfaces";
import { derivePbkdf2Key } from "./key-derivation";

export class PasswordKeyProvider implements KeyProvider {
  readonly type = "password";

  async deriveKey(
    password: string,
    salt: Uint8Array,
    params: EncryptionParams,
    extractable: boolean
  ): Promise<CryptoKey> {
    return derivePbkdf2Key(
      password,
      salt,
      params.keyDerivation.iterations,
      params.keyDerivation.hash,
      params.keySize,
      extractable
    );
  }
}
