/**
 * Note converter — convert between .md and .locked files.
 *
 * If the file being converted is currently open:
 *   - Active tab: reopen the converted file in the same tab, same mode
 *   - Background tab: silently swap without stealing focus
 * If the file is not open: just convert on disk, don't open anything.
 */

import { TFile, Notice, WorkspaceLeaf } from "obsidian";
import type AFEPlugin from "../../main";
import { encode, decode, LOCKED_EXTENSION, createPendingFile } from "../../services/file-data";
import { PasswordModal } from "../../ui/password-modal";

export class NoteConverter {
  private plugin: AFEPlugin;

  /** True while a conversion is in progress. Prevents the create handler
   *  from interfering (e.g. deleting a .md that toDecrypted just created). */
  isConverting = false;

  constructor(plugin: AFEPlugin) {
    this.plugin = plugin;
  }

  /**
   * Convert a .md file to an encrypted .locked file.
   *
   * If a session password is available, encrypts immediately.
   * Otherwise, creates a pending .locked file and stores the plaintext
   * temporarily so the view can show an inline "Set up encryption" card.
   */
  async toEncrypted(file: TFile): Promise<void> {
    if (file.extension !== "md") {
      new Notice("Can only encrypt markdown (.md) files.");
      return;
    }

    // Try session password first
    let password = this.plugin.sessionManager.getPassword(file.path);
    let hint = "";

    this.isConverting = true;
    try {
      // Find open leaves and remember state before making changes
      const { targetLeaf, viewMode, wasActive, otherLeaves } = this.findLeaves(file);

      // Close duplicate leaves (keep the primary one)
      for (const leaf of otherLeaves) {
        leaf.detach();
      }

      // Read plaintext before doing anything destructive
      const plaintext = await this.plugin.app.vault.read(file);

      // Compute new path
      const newPath = file.path.replace(/\.md$/, `.${LOCKED_EXTENSION}`);

      let newFile: TFile;

      if (password) {
        // Session password available — encrypt immediately
        const encryptedJson = await encode(plaintext, password, hint);
        newFile = await this.plugin.app.vault.create(newPath, encryptedJson);
        this.plugin.sessionManager.put(newPath, password, hint);
      } else {
        // No session password — create a pending file and cache the plaintext
        // so the view's inline encrypt card can use it after password entry.
        const pendingContent = createPendingFile();
        newFile = await this.plugin.app.vault.create(newPath, pendingContent);
        this.plugin.pendingPlaintext.set(newPath, plaintext);
      }

      // Preserve position in manual-sorting plugin
      await this.updateManualSortOrder(file.path, newPath);

      // Reopen in same tab BEFORE deleting the old file — vault.delete
      // causes Obsidian to close any tabs showing the deleted file.
      if (targetLeaf) {
        await this.reopenInLeaf(targetLeaf, newFile, viewMode, wasActive);
      }

      // Delete original .md file
      await this.plugin.app.vault.delete(file);

      if (password) {
        new Notice(`Encrypted: ${file.basename}.${LOCKED_EXTENSION}`);
      }
    } finally {
      this.isConverting = false;
    }
  }

  /**
   * Convert an encrypted .locked file to a decrypted .md file.
   */
  async toDecrypted(file: TFile): Promise<void> {
    if (file.extension !== LOCKED_EXTENSION) {
      new Notice(`Can only decrypt .${LOCKED_EXTENSION} files.`);
      return;
    }

    // Try session password first
    let password = this.plugin.sessionManager.getPassword(file.path);

    if (!password) {
      // Read file to get hint
      const raw = await this.plugin.app.vault.read(file);
      let hint = "";
      try {
        const { parse } = await import("../../services/file-data");
        const fileData = parse(raw);
        hint = fileData.hint ?? "";
      } catch { /* ignore */ }

      const result = await PasswordModal.prompt(this.plugin.app, "decrypt", hint, false, false, this.plugin.settings.showCleartextPassword);
      if (!result) return;
      password = result.password;
    }

    this.isConverting = true;
    try {
      // Find open leaves and remember state before making changes
      const { targetLeaf, viewMode, wasActive, otherLeaves } = this.findLeaves(file);

      for (const leaf of otherLeaves) {
        leaf.detach();
      }

      // Read and decrypt
      const raw = await this.plugin.app.vault.read(file);
      const plaintext = await decode(raw, password);

      if (plaintext === null) {
        new Notice("Wrong password. Could not decrypt.");
        return;
      }

      // Compute new path
      const newPath = file.path.replace(new RegExp(`\\.${LOCKED_EXTENSION}$`), ".md");

      // Create decrypted file
      const newFile = await this.plugin.app.vault.create(newPath, plaintext);

      // Clean up session entry
      this.plugin.sessionManager.clearFile(file.path);

      // Preserve position in manual-sorting plugin
      await this.updateManualSortOrder(file.path, newPath);

      // Reopen in same tab BEFORE deleting the old file — vault.delete
      // causes Obsidian to close any tabs showing the deleted file.
      if (targetLeaf) {
        await this.reopenInLeaf(targetLeaf, newFile, viewMode, wasActive);
      }

      // Delete encrypted file
      await this.plugin.app.vault.delete(file);

      new Notice(`Decrypted: ${file.basename}.md`);
    } finally {
      this.isConverting = false;
    }
  }

  /**
   * Replace oldPath with newPath in the manual-sorting plugin's sort order
   * so the converted file keeps its position in the file explorer.
   *
   * Must run AFTER vault.create (which triggers manual-sorting's own create
   * handler that inserts newPath at top/bottom). We undo that insertion,
   * then swap oldPath → newPath in-place. The subsequent vault.delete won't
   * find oldPath anymore, so it's a no-op on the sort order.
   */
  async updateManualSortOrder(oldPath: string, newPath: string): Promise<void> {
    if (!this.plugin.settings.manualSortIntegration) return;

    const manualSorting = (this.plugin.app as any).plugins?.plugins?.["manual-sorting"];
    if (!manualSorting) return;

    const data = manualSorting.settings;
    if (!data?.customOrder) return;

    const lastSlash = oldPath.lastIndexOf("/");
    const folderKey = lastSlash === -1 ? "/" : oldPath.substring(0, lastSlash);

    const folderOrder = data.customOrder[folderKey];
    if (!folderOrder?.children) return;

    // The manual-sorting plugin's create handler already inserted newPath
    // at the top or bottom. Remove that duplicate before we do the swap.
    const dupeIndex = folderOrder.children.indexOf(newPath);
    if (dupeIndex !== -1) {
      folderOrder.children.splice(dupeIndex, 1);
    }

    // Replace oldPath with newPath at its original position
    const oldIndex = folderOrder.children.indexOf(oldPath);
    if (oldIndex !== -1) {
      folderOrder.children[oldIndex] = newPath;
    }

    await manualSorting.saveData(data);
  }

  /**
   * Find all leaves that have a file open.
   * Returns the primary leaf, its view mode, whether it was the active tab,
   * and any duplicate leaves.
   */
  private findLeaves(file: TFile): {
    targetLeaf: WorkspaceLeaf | null;
    viewMode: string;
    wasActive: boolean;
    otherLeaves: WorkspaceLeaf[];
  } {
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    let targetLeaf: WorkspaceLeaf | null = null;
    let viewMode = "source";
    const otherLeaves: WorkspaceLeaf[] = [];

    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if ((leaf.view as any).file?.path === file.path) {
        if (!targetLeaf) {
          targetLeaf = leaf;
          const state = leaf.getViewState();
          viewMode = (state?.state as any)?.mode ?? "source";
        } else {
          otherLeaves.push(leaf);
        }
      }
    });

    return {
      targetLeaf,
      viewMode,
      wasActive: targetLeaf === activeLeaf,
      otherLeaves,
    };
  }

  /**
   * Open a file in a specific leaf, preserving view mode.
   * If the leaf was a background tab, restore focus to the previously active leaf.
   */
  private async reopenInLeaf(
    leaf: WorkspaceLeaf,
    file: TFile,
    viewMode: string,
    wasActive: boolean
  ): Promise<void> {
    const activeLeaf = this.plugin.app.workspace.activeLeaf;

    await leaf.openFile(file, { state: { mode: viewMode } });

    // If this was a background tab, restore focus so we don't steal it
    if (!wasActive && activeLeaf) {
      this.plugin.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
    }
  }
}
