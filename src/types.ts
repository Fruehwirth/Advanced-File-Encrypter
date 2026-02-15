/**
 * Shared types for Flowcrypt plugin.
 */

import type { SessionMode } from "./services/session-manager";

export interface FlowcryptSettings {
  /** Session security mode */
  sessionMode: SessionMode;

  /** Session password timeout in minutes (for "session-password" mode). 0 = until Obsidian closes. */
  sessionTimeout: number;

  /** Timed password window in seconds (for "timed-password" mode). */
  timedPasswordWindow: number;

  /** Require password confirmation when encrypting. */
  confirmPassword: boolean;

  /** Show the password hint field when encrypting. */
  showPasswordHint: boolean;

  /** Automatically encrypt new daily notes on creation. */
  autoEncryptDailyNotes: boolean;

  /** Preserve file position in manual-sorting plugin during conversion. */
  manualSortIntegration: boolean;

  /** Include encrypted notes in markdown leaf queries (for Daily Note Navbar etc.) */
  dailyNoteNavbarIntegration: boolean;

  /** Always show passwords as cleartext in the password modal. */
  showCleartextPassword: boolean;
}

export const DEFAULT_SETTINGS: FlowcryptSettings = {
  sessionMode: "session-password",
  sessionTimeout: 30,
  timedPasswordWindow: 60,
  confirmPassword: true,
  showPasswordHint: true,
  autoEncryptDailyNotes: true,
  manualSortIntegration: true,
  dailyNoteNavbarIntegration: true,
  showCleartextPassword: false,
};
