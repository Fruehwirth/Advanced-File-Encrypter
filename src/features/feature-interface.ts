/**
 * Feature interface — all Advanced File Encryption features implement this.
 * Allows modular loading/unloading and settings UI composition.
 */

import type AFEPlugin from "../main";

export interface IAFEFeature {
  onload(plugin: AFEPlugin): Promise<void>;
  onunload(): void;
  buildSettingsUi(containerEl: HTMLElement, saveCallback: () => Promise<void>): void;
}
