/**
 * Note converter — convert between .md and .locked files.
 *
 * Uses vault.modify() + fileManager.renameFile() to keep the TFile alive.
 * No file is created or deleted — only modified and renamed.
 *
 * To protect the local graph panel during encryption, the active leaf is
 * navigated to an empty state BEFORE the file is modified. This detaches
 * the graph from the file so it isn't affected by the content/type change.
 * After the rename, the encrypted file is opened in the same leaf and the
 * graph reattaches naturally.
 */

import { TFile, Notice, WorkspaceLeaf, MarkdownView } from "obsidian";
import type AFEPlugin from "../../main";
import { encode, decode, LOCKED_EXTENSION, createPendingFile } from "../../services/file-data";

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

    let password = this.plugin.sessionManager.getPassword(file.path);
    let hint = "";

    this.isConverting = true;
    try {
      // Read plaintext before modifying
      const plaintext = await this.plugin.app.vault.read(file);
      const oldPath = file.path;
      const newPath = file.path.replace(/\.md$/, `.${LOCKED_EXTENSION}`);

      // Collect all leaves showing this file, then navigate them to a
      // blank "empty" state. This detaches the local graph from the file
      // so it isn't affected by the content change or view transition.
      const leaves = this.findLeavesForFile(file);
      for (const leaf of leaves) {
        await leaf.setViewState({ type: "empty", state: {} });
      }

      // Let sidebar panels (local graph, backlinks, etc.) settle
      if (leaves.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Now encrypt on disk — no view is displaying the file
      if (password) {
        const encryptedJson = await encode(plaintext, password, hint);
        await this.plugin.app.vault.modify(file, encryptedJson);
        this.plugin.sessionManager.put(newPath, password, hint);
      } else {
        const pendingContent = createPendingFile();
        await this.plugin.app.vault.modify(file, pendingContent);
        this.plugin.pendingPlaintext.set(newPath, plaintext);
      }

      // Rename .md → .locked
      await this.plugin.app.fileManager.renameFile(file, newPath);

      // Open the encrypted file in the same leaves.
      // EncryptedMarkdownView loads and auto-decrypts (password is cached).
      for (const leaf of leaves) {
        await leaf.openFile(file);
      }

      // Preserve position in manual-sorting plugin
      await this.updateManualSortOrder(oldPath, newPath);

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

    const password = this.plugin.sessionManager.getPassword(file.path);

    if (!password) {
      new Notice("Unlock the note first, then decrypt.");
      return;
    }

    this.isConverting = true;
    try {
      // Read and decrypt
      const raw = await this.plugin.app.vault.read(file);
      const plaintext = await decode(raw, password);

      if (plaintext === null) {
        new Notice("Wrong password. Could not decrypt.");
        return;
      }

      const oldPath = file.path;
      const newPath = file.path.replace(new RegExp(`\\.${LOCKED_EXTENSION}$`), ".md");

      // Same blank-tab approach: navigate away, convert, reopen
      const leaves = this.findLeavesForFile(file);
      for (const leaf of leaves) {
        await leaf.setViewState({ type: "empty", state: {} });
      }
      if (leaves.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Overwrite the .locked file with plaintext
      await this.plugin.app.vault.modify(file, plaintext);

      // Rename .locked → .md
      await this.plugin.app.fileManager.renameFile(file, newPath);

      // Open the decrypted .md file
      for (const leaf of leaves) {
        await leaf.openFile(file);
      }

      // Preserve position in manual-sorting plugin
      await this.updateManualSortOrder(oldPath, newPath);

      new Notice(`Decrypted: ${file.basename}.md`);
    } finally {
      this.isConverting = false;
    }
  }

  /** Find editor leaves (MarkdownView) showing a file — excludes sidebar panels. */
  private findLeavesForFile(file: TFile): WorkspaceLeaf[] {
    const result: WorkspaceLeaf[] = [];
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (
        leaf.view instanceof MarkdownView &&
        (leaf.view as any).file?.path === file.path
      ) {
        result.push(leaf);
      }
    });
    return result;
  }

  /**
   * Replace oldPath with newPath in the manual-sorting plugin's sort order
   * so the converted file keeps its position in the file explorer.
   *
   * Safe to call after either create+delete or rename workflows:
   * - If manual-sorting already handled the rename: oldPath won't be found,
   *   no changes are made.
   * - If manual-sorting didn't handle the rename: oldPath is replaced
   *   with newPath in-place.
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

    // Remove any duplicate entry for newPath (e.g. if a create handler
    // inserted it, or if manual-sorting's rename handler duplicated it)
    const dupeIndex = folderOrder.children.indexOf(newPath);
    if (dupeIndex !== -1) {
      // Only remove if oldPath also exists (true duplicate scenario)
      const oldIndex = folderOrder.children.indexOf(oldPath);
      if (oldIndex !== -1) {
        folderOrder.children.splice(dupeIndex, 1);
      }
    }

    // Replace oldPath with newPath at its original position
    const oldIndex = folderOrder.children.indexOf(oldPath);
    if (oldIndex !== -1) {
      folderOrder.children[oldIndex] = newPath;
    }

    await manualSorting.saveData(data);
  }
}
