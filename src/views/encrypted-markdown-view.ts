/**
 * EncryptedMarkdownView — The core of Flowcrypt.
 *
 * Extends Obsidian's MarkdownView so encrypted notes get the FULL editor:
 * syntax highlighting, preview mode, links, backlinks, tags, vim mode, etc.
 *
 * Save interception pattern (from Meld Encrypt):
 * - getViewData() returns plaintext normally, encrypted only during save
 * - save() sets isSavingInProgress, encrypts, calls super.save()
 * - setViewData() blocks during loading, decrypts vault sync data
 * - onLoadFile() hides view via setViewBusy, decrypts, calls
 *   super.onLoadFile() with isLoadingFile guard, sets plaintext
 *   via super.setViewData() AFTER initialization, then reveals view
 */

import {
  MarkdownView,
  WorkspaceLeaf,
  TFile,
  Notice,
  setIcon,
} from "obsidian";

import type FlowcryptPlugin from "../main";
import { parse, encode, decode, isFlowcryptFile } from "../services/file-data";
import type { FlowcryptFileData } from "../services/file-data";
import { deriveKeyFromData, decryptTextWithKey } from "../crypto/index";
import { PasswordModal } from "../ui/password-modal";

export const VIEW_TYPE_ENCRYPTED = "flowcrypt-encrypted-view";

export class EncryptedMarkdownView extends MarkdownView {
  plugin: FlowcryptPlugin;
  private fileData: FlowcryptFileData | null = null;
  private currentPassword: string | null = null;
  private cachedPlaintext: string = "";
  private encryptedJsonForSave: string = "";
  isSavingEnabled: boolean = false;
  private isLoadingFile: boolean = false;
  private isSavingInProgress: boolean = false;

  constructor(leaf: WorkspaceLeaf, plugin: FlowcryptPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
  }

  getViewType(): string {
    return VIEW_TYPE_ENCRYPTED;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Encrypted note";
  }

  getIcon(): string {
    return "file-lock";
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "flwct";
  }

  // ── Data interception ────────────────────────────────────────────

  /**
   * Called by Obsidian's save pipeline to get data for disk.
   * During save: returns encrypted JSON.
   * Otherwise: returns plaintext from the editor (for preview, search, etc.)
   */
  getViewData(): string {
    if (this.isSavingInProgress) {
      return this.encryptedJsonForSave;
    }
    return super.getViewData();
  }

  /**
   * Intercept data coming from Obsidian (vault sync, file re-read, etc.)
   * - During loading: block completely (we pre-set content before super.onLoadFile)
   * - If file is null: ignore
   * - If encrypted: update cache, decrypt, then pass plaintext to super
   * - If plaintext: pass through
   */
  setViewData(data: string, clear: boolean): void {
    if (this.file == null) return;
    if (this.isLoadingFile) return;

    if (isFlowcryptFile(data)) {
      // Always update the encrypted cache (vault sync, external edit)
      this.encryptedJsonForSave = data;
      if (!this.currentPassword) return;
      decode(data, this.currentPassword).then((plaintext) => {
        if (plaintext !== null) {
          this.cachedPlaintext = plaintext;
          try {
            this.fileData = parse(data);
          } catch {
            /* ignore */
          }
          super.setViewData(plaintext, false);
        }
      });
      return;
    }

    this.cachedPlaintext = data;
    super.setViewData(data, false);
  }

  clear(): void {
    this.currentPassword = null;
    this.fileData = null;
    this.cachedPlaintext = "";
    this.encryptedJsonForSave = "";
    this.isSavingEnabled = false;
    this.isSavingInProgress = false;
    this.isLoadingFile = false;
  }

  // ── Save ─────────────────────────────────────────────────────────

  async save(clear?: boolean): Promise<void> {
    if (this.isSavingInProgress) return;
    if (!this.file || !this.isSavingEnabled) return;

    const password =
      this.currentPassword ??
      this.plugin.sessionManager.getPassword(this.file.path);
    if (!password) return;

    this.isSavingInProgress = true;
    try {
      const plaintext = super.getViewData();

      // Safety: never double-encrypt
      if (isFlowcryptFile(plaintext)) return;

      // Skip if unchanged
      if (plaintext === this.cachedPlaintext) return;

      this.cachedPlaintext = plaintext;
      const hint = this.fileData?.hint ?? "";

      const encryptedJson = await encode(plaintext, password, hint);
      this.encryptedJsonForSave = encryptedJson;

      try {
        this.fileData = parse(encryptedJson);
      } catch {
        /* ignore */
      }

      // super.save() → getViewData() → isSavingInProgress → encrypted
      await super.save(clear);
    } finally {
      this.isSavingInProgress = false;
    }
  }

  // ── File lifecycle ───────────────────────────────────────────────

  async onLoadFile(file: TFile): Promise<void> {
    this.isSavingEnabled = false;
    this.isSavingInProgress = false;
    this.currentPassword = null;

    // Hide the view during initialization to prevent encrypted JSON from
    // flashing. Uses Obsidian's internal setViewBusy (same as Meld Encrypt)
    // plus a CSS fallback for robustness.
    (this as any).setViewBusy?.(true);
    this.contentEl.style.visibility = "hidden";

    try {
      // Read file directly from vault
      const rawContent = await this.app.vault.read(file);
      if (!rawContent || !rawContent.trim()) {
        await this.initViewEmpty(file);
        this.showLockedState("Empty encrypted file.");
        return;
      }

      // Parse metadata
      let fileData: FlowcryptFileData;
      try {
        fileData = parse(rawContent);
      } catch {
        await this.initViewEmpty(file);
        this.showLockedState("Invalid Flowcrypt file format.");
        return;
      }
      this.fileData = fileData;
      this.encryptedJsonForSave = rawContent;

      // Try cached password
      const sessionMgr = this.plugin.sessionManager;
      let password = sessionMgr.getPassword(file.path);
      let plaintext: string | null = null;

      if (password) {
        plaintext = await decode(rawContent, password);
        if (plaintext === null) password = null;
      }

      // Try cached key (keys-only mode)
      if (plaintext === null && sessionMgr.getMode() === "keys-only") {
        const key = sessionMgr.getKey(file.path);
        if (key) {
          plaintext = await decryptTextWithKey(
            fileData.data,
            key,
            fileData.encryption
          );
        }
      }

      // During workspace restoration or for background tabs, show locked
      // state instead of prompting — avoids modal storms on startup.
      if (plaintext === null &&
          (!this.app.workspace.layoutReady || this.app.workspace.activeLeaf !== this.leaf)) {
        await this.initViewEmpty(file);
        this.showLockedState("Encrypted note.");
        return;
      }

      // Prompt for password (only after workspace is ready, only for active leaf)
      while (plaintext === null) {
        const result = await PasswordModal.prompt(
          this.app,
          "decrypt",
          fileData.hint ?? "",
          false,
          false,
          this.plugin.settings.showCleartextPassword
        );
        if (!result) {
          await this.initViewEmpty(file);
          this.showLockedState("Decryption cancelled.");
          return;
        }

        plaintext = await decode(rawContent, result.password);
        if (plaintext !== null) {
          password = result.password;
          if (sessionMgr.getMode() === "keys-only") {
            const key = await deriveKeyFromData(
              fileData.data,
              result.password,
              fileData.encryption,
              false
            );
            if (key) {
              sessionMgr.put(
                file.path,
                result.password,
                fileData.hint ?? "",
                key
              );
            }
          } else {
            sessionMgr.put(file.path, result.password, fileData.hint ?? "");
          }
        } else {
          new Notice("Wrong password.");
        }
      }

      // Decryption successful
      this.currentPassword = password;
      this.cachedPlaintext = plaintext;
      this.encryptedJsonForSave = rawContent;

      // Let MarkdownView fully initialize (sets this.file, creates toolbar, etc.)
      // Our setViewData override blocks the encrypted content it reads from disk.
      this.isLoadingFile = true;
      try {
        await super.onLoadFile(file);
      } finally {
        this.isLoadingFile = false;
      }

      // Set decrypted plaintext into the now-initialized editor.
      // Must be AFTER super.onLoadFile so the CM6 editor and toolbar
      // are fully created. Uses super.setViewData to properly update
      // MarkdownView's internal state pipeline.
      super.setViewData(plaintext, false);
      this.isSavingEnabled = true;
    } catch (err) {
      // Defensive: if anything fails, show locked state instead of crashing.
      // This prevents the "plugin has gone away" error on workspace restore.
      console.error("Flowcrypt: failed to load encrypted file", file.path, err);
      try {
        await this.initViewEmpty(file);
        this.showLockedState("Failed to load. Click to retry.");
      } catch {
        // Last resort — at least don't crash the plugin
      }
    } finally {
      // Reveal the view — editor now has plaintext (or locked state overlay)
      this.contentEl.style.visibility = "";
      (this as any).setViewBusy?.(false);
    }
  }

  async onUnloadFile(file: TFile): Promise<void> {
    // If a save is already in progress, reset the flag so the final
    // save triggered by super.onUnloadFile can go through.
    if (this.isSavingInProgress) {
      this.isSavingInProgress = false;
    }

    if (this.plugin.sessionManager.getMode() === "no-storage") {
      this.plugin.sessionManager.clearFile(file.path);
    }

    // Don't clear password/saving state BEFORE super.onUnloadFile —
    // it may trigger a final save that needs them.
    await super.onUnloadFile(file);

    this.currentPassword = null;
    this.fileData = null;
    this.isSavingEnabled = false;
  }

  async setState(state: any, result: any): Promise<void> {
    if (state.mode === "preview" && this.isSavingEnabled) {
      await this.save();
    }

    this.isSavingEnabled = false;
    try {
      await super.setState(state, result);
      if (this.cachedPlaintext) {
        super.setViewData(this.cachedPlaintext, false);
      }
    } finally {
      if (this.currentPassword) {
        this.isSavingEnabled = true;
      }
    }
  }

  // ── Actions ──────────────────────────────────────────────────────

  async lockAndClose(): Promise<void> {
    if (this.isSavingEnabled && this.file) {
      await this.save();
      this.plugin.sessionManager.clearFile(this.file.path);
    }
    this.currentPassword = null;
    this.isSavingEnabled = false;
    this.leaf.detach();
  }

  async changePassword(): Promise<void> {
    if (!this.file || !this.isSavingEnabled) return;

    const result = await PasswordModal.prompt(
      this.app,
      "encrypt",
      this.fileData?.hint ?? "",
      this.plugin.settings.confirmPassword,
      this.plugin.settings.showPasswordHint,
      this.plugin.settings.showCleartextPassword
    );

    if (!result) return;

    this.currentPassword = result.password;
    if (this.fileData) {
      this.fileData.hint = result.hint;
    }

    this.plugin.sessionManager.put(
      this.file.path,
      result.password,
      result.hint
    );

    this.cachedPlaintext = "";
    await this.save();
    new Notice("Password changed successfully.");
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async initViewEmpty(file: TFile): Promise<void> {
    this.isLoadingFile = true;
    try {
      await super.onLoadFile(file);
    } finally {
      this.isLoadingFile = false;
    }
    super.setViewData("", false);
  }

  private showLockedState(message: string): void {
    const container = this.contentEl;
    const overlay = container.createDiv("flowcrypt-locked-state");
    const iconEl = overlay.createDiv("flowcrypt-lock-icon");
    setIcon(iconEl, "lock");
    overlay.createEl("p", { text: message });

    if (this.fileData) {
      const btn = overlay.createEl("button", {
        text: "Unlock",
        cls: "mod-cta",
      });
      btn.addEventListener("click", async () => {
        if (!this.file) return;
        overlay.remove();

        const raw = await this.app.vault.read(this.file);
        let fileData: FlowcryptFileData;
        try {
          fileData = parse(raw);
        } catch {
          new Notice("Invalid Flowcrypt file format.");
          return;
        }
        this.fileData = fileData;

        const sessionMgr = this.plugin.sessionManager;
        let password: string | null = null;
        let plaintext: string | null = null;

        // Try session cache first (auto-unlock if password is cached)
        password = sessionMgr.getPassword(this.file.path);
        if (password) {
          plaintext = await decode(raw, password);
          if (plaintext === null) password = null;
        }

        // Try cached key (keys-only mode)
        if (plaintext === null && sessionMgr.getMode() === "keys-only") {
          const key = sessionMgr.getKey(this.file.path);
          if (key) {
            plaintext = await decryptTextWithKey(
              fileData.data,
              key,
              fileData.encryption
            );
          }
        }

        // Prompt only if no cached password/key worked
        if (plaintext === null) {
          const result = await PasswordModal.prompt(
            this.app,
            "decrypt",
            fileData.hint ?? "",
            false
          );
          if (!result) {
            this.showLockedState("Decryption cancelled.");
            return;
          }

          plaintext = await decode(raw, result.password);
          if (plaintext === null) {
            new Notice("Wrong password.");
            this.showLockedState("Wrong password.");
            return;
          }
          password = result.password;
        }

        // Cache in session
        if (password) {
          if (sessionMgr.getMode() === "keys-only") {
            const key = await deriveKeyFromData(
              fileData.data,
              password,
              fileData.encryption,
              false
            );
            if (key) {
              sessionMgr.put(
                this.file.path,
                password,
                fileData.hint ?? "",
                key
              );
            }
          } else {
            sessionMgr.put(
              this.file.path,
              password,
              fileData.hint ?? ""
            );
          }
        }

        this.currentPassword = password;
        this.cachedPlaintext = plaintext;
        this.encryptedJsonForSave = raw;
        super.setViewData(plaintext, false);
        this.isSavingEnabled = true;
      });
    }
  }
}
