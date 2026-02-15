/**
 * Feature interface — all Flowcrypt features implement this.
 * Allows modular loading/unloading and settings UI composition.
 */

import type FlowcryptPlugin from "../main";

export interface IFlowcryptFeature {
  onload(plugin: FlowcryptPlugin): Promise<void>;
  onunload(): void;
  buildSettingsUi(containerEl: HTMLElement, saveCallback: () => Promise<void>): void;
}
