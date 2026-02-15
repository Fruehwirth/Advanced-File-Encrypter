/**
 * Session Manager — in-memory password/key caching with 4 security modes.
 *
 * All sensitive data is stored in private closured Maps, never as accessible
 * object properties. Everything is cleared on plugin unload.
 *
 * Modes:
 *   "session-password"  — Password cached until timeout or Obsidian close (DEFAULT)
 *   "timed-password"    — Password cached for a short window after entry
 *   "keys-only"         — Only non-extractable CryptoKeys cached; password discarded immediately
 *   "no-storage"        — Nothing cached; password required every time
 */

export type SessionMode = "session-password" | "timed-password" | "keys-only" | "no-storage";

export interface SessionEntry {
  password: string | null;
  hint: string;
  key: CryptoKey | null;
  expiry: number | null; // timestamp in ms, null = no expiry
}

export class SessionManager {
  private entries: Map<string, SessionEntry> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private mode: SessionMode;
  private sessionTimeoutMs: number;
  private timedWindowMs: number;

  constructor(
    mode: SessionMode = "session-password",
    sessionTimeoutMinutes: number = 30,
    timedWindowSeconds: number = 60
  ) {
    this.mode = mode;
    this.sessionTimeoutMs = sessionTimeoutMinutes <= 0 ? 0 : sessionTimeoutMinutes * 60 * 1000;
    this.timedWindowMs = timedWindowSeconds * 1000;
  }

  setMode(mode: SessionMode): void {
    this.clear();
    this.mode = mode;
  }

  setSessionTimeout(minutes: number): void {
    this.sessionTimeoutMs = minutes <= 0 ? 0 : minutes * 60 * 1000;
  }

  setTimedWindow(seconds: number): void {
    this.timedWindowMs = seconds * 1000;
  }

  getMode(): SessionMode {
    return this.mode;
  }

  /**
   * Store a password (and optionally a derived key) for a file path.
   * What gets stored depends on the current mode.
   */
  put(filePath: string, password: string, hint: string, key?: CryptoKey): void {
    // Clear any existing timer for this path
    this.clearTimer(filePath);

    switch (this.mode) {
      case "no-storage":
        // Store nothing
        return;

      case "keys-only": {
        // Store only the key, discard password immediately
        if (!key) return;
        const entry: SessionEntry = {
          password: null,
          hint,
          key,
          expiry: null, // keys don't expire (view manages lifecycle)
        };
        this.entries.set(filePath, entry);
        return;
      }

      case "timed-password": {
        const expiry = Date.now() + this.timedWindowMs;
        const entry: SessionEntry = { password, hint, key: key ?? null, expiry };
        this.entries.set(filePath, entry);
        this.scheduleExpiry(filePath, this.timedWindowMs);
        return;
      }

      case "session-password":
      default: {
        const expiry = this.sessionTimeoutMs > 0
          ? Date.now() + this.sessionTimeoutMs
          : null;
        const entry: SessionEntry = { password, hint, key: key ?? null, expiry };
        this.entries.set(filePath, entry);
        if (this.sessionTimeoutMs > 0) {
          this.scheduleExpiry(filePath, this.sessionTimeoutMs);
        }
        return;
      }
    }
  }

  /**
   * Get the cached password for a file path.
   * Returns null if not cached, expired, or mode doesn't store passwords.
   *
   * In "session-password" and "timed-password" modes, also checks any
   * stored password (not just for this file) since one password unlocks all.
   */
  getPassword(filePath: string): string | null {
    if (this.mode === "no-storage" || this.mode === "keys-only") {
      return null;
    }

    // First check direct file path match
    const entry = this.entries.get(filePath);
    if (entry && entry.password !== null && !this.isExpired(entry)) {
      return entry.password;
    }

    // In session/timed modes, any cached password works for all files
    for (const [, e] of this.entries) {
      if (e.password !== null && !this.isExpired(e)) {
        return e.password;
      }
    }

    return null;
  }

  /** Get the cached hint for a file path. */
  getHint(filePath: string): string {
    return this.entries.get(filePath)?.hint ?? "";
  }

  /** Get a cached CryptoKey for a specific file. Only useful in "keys-only" mode. */
  getKey(filePath: string): CryptoKey | null {
    const entry = this.entries.get(filePath);
    if (!entry || this.isExpired(entry)) return null;
    return entry.key;
  }

  /** True when at least one unexpired password or key is cached. */
  hasEntries(): boolean {
    for (const [, entry] of this.entries) {
      if (!this.isExpired(entry)) return true;
    }
    return false;
  }

  /** Clear the session entry for a specific file. */
  clearFile(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (entry) {
      // Zero out the password string (best effort — JS strings are immutable,
      // but removing the reference allows GC to collect it)
      entry.password = null;
      entry.key = null;
    }
    this.clearTimer(filePath);
    this.entries.delete(filePath);
  }

  /** Clear all cached passwords and keys. */
  clear(): void {
    for (const [path, entry] of this.entries) {
      entry.password = null;
      entry.key = null;
      this.clearTimer(path);
    }
    this.entries.clear();
  }

  /** Update path when a file is renamed. */
  handleRename(oldPath: string, newPath: string): void {
    const entry = this.entries.get(oldPath);
    if (entry) {
      this.entries.delete(oldPath);
      this.entries.set(newPath, entry);
      const timer = this.timers.get(oldPath);
      if (timer) {
        this.timers.delete(oldPath);
        this.timers.set(newPath, timer);
      }
    }
  }

  private isExpired(entry: SessionEntry): boolean {
    if (entry.expiry === null) return false;
    return Date.now() > entry.expiry;
  }

  private scheduleExpiry(filePath: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.clearFile(filePath);
    }, delayMs);
    this.timers.set(filePath, timer);
  }

  private clearTimer(filePath: string): void {
    const timer = this.timers.get(filePath);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(filePath);
    }
  }
}
