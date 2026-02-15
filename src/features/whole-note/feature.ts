/**
 * Whole-note encryption feature.
 *
 * Registers commands, ribbon icons, and file menu items for:
 * - Creating new encrypted notes
 * - Locking/closing all encrypted notes
 * - Changing passwords
 * - Converting notes between .md and .flwct
 * - Clearing the session cache
 * - Auto-encrypting new daily notes
 */

import { TFile, TFolder, Notice, Menu, WorkspaceLeaf, MarkdownView } from "obsidian";
import type { IFlowcryptFeature } from "../feature-interface";
import type FlowcryptPlugin from "../../main";
import { NoteConverter } from "./note-converter";
import { PasswordModal } from "../../ui/password-modal";
import { encode, FLWCT_EXTENSION } from "../../services/file-data";
import {
  EncryptedMarkdownView,
} from "../../views/encrypted-markdown-view";

export class WholeNoteFeature implements IFlowcryptFeature {
  private plugin!: FlowcryptPlugin;
  private converter!: NoteConverter;
  private originalGetLeavesOfType: ((type: string) => WorkspaceLeaf[]) | null = null;

  async onload(plugin: FlowcryptPlugin): Promise<void> {
    this.plugin = plugin;
    this.converter = new NoteConverter(plugin);

    // --- Commands ---

    plugin.addCommand({
      id: "create-encrypted-note",
      name: "Create new encrypted note",
      callback: () => this.createEncryptedNote(),
    });

    plugin.addCommand({
      id: "lock-all",
      name: "Lock and close all encrypted notes",
      callback: () => this.lockAll(),
    });

    plugin.addCommand({
      id: "change-password",
      name: "Change password of current note",
      checkCallback: (checking) => {
        const view = plugin.app.workspace.getActiveViewOfType(EncryptedMarkdownView);
        if (!view) return false;
        if (!checking) view.changePassword();
        return true;
      },
    });

    plugin.addCommand({
      id: "clear-session",
      name: "Clear session cache",
      callback: () => {
        plugin.sessionManager.clear();
        new Notice("Flowcrypt: Session cache cleared.");
      },
    });

    plugin.addCommand({
      id: "convert-to-encrypted",
      name: "Encrypt current note",
      checkCallback: (checking) => {
        const file = plugin.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.converter.toEncrypted(file);
        return true;
      },
    });

    plugin.addCommand({
      id: "convert-to-decrypted",
      name: "Decrypt current note",
      checkCallback: (checking) => {
        const file = plugin.app.workspace.getActiveFile();
        if (!file || file.extension !== FLWCT_EXTENSION) return false;
        if (!checking) this.converter.toDecrypted(file);
        return true;
      },
    });

    // --- Ribbon icon ---

    plugin.addRibbonIcon("book-lock", "Lock all encrypted notes", () => {
      this.lockAll();
    });

    // --- File menu (right-click) ---

    plugin.registerEvent(
      (plugin.app.workspace as any).on("file-menu", (menu: Menu, file: TFile | TFolder) => {
        if (file instanceof TFile) {
          if (file.extension === "md") {
            menu.addItem((item) => {
              item.setTitle("Encrypt note")
                .setIcon("lock")
                .onClick(() => this.converter.toEncrypted(file));
            });
          } else if (file.extension === FLWCT_EXTENSION) {
            menu.addItem((item) => {
              item.setTitle("Decrypt note")
                .setIcon("unlock")
                .onClick(() => this.converter.toDecrypted(file));
            });
            menu.addItem((item) => {
              item.setTitle("Lock and close")
                .setIcon("lock")
                .onClick(() => this.lockFile(file));
            });
          }
        } else if (file instanceof TFolder) {
          menu.addItem((item) => {
            item.setTitle("New encrypted note")
              .setIcon("file-lock")
              .onClick(() => this.createEncryptedNote(file));
          });
        }
      })
    );

    // --- View header encrypt/decrypt icons ---

    plugin.registerEvent(
      plugin.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf) return;
        const view = leaf.view;

        // .md files: add "Lock" icon to encrypt
        if (
          view instanceof MarkdownView &&
          !(view instanceof EncryptedMarkdownView) &&
          view.file?.extension === "md"
        ) {
          const actions = (view as any).actionsEl as HTMLElement | undefined;
          if (actions && !actions.querySelector(".flowcrypt-encrypt-action")) {
            const action = view.addAction("lock", "Encrypt note", () => {
              if (view.file) this.converter.toEncrypted(view.file);
            });
            action.addClass("flowcrypt-encrypt-action");
          }
        }

        // .flwct files: add "Unlock" icon to decrypt
        if (view instanceof EncryptedMarkdownView) {
          const actions = (view as any).actionsEl as HTMLElement | undefined;
          if (actions && !actions.querySelector(".flowcrypt-decrypt-action")) {
            const action = view.addAction("unlock", "Decrypt note", () => {
              if (view.file) this.converter.toDecrypted(view.file);
            });
            action.addClass("flowcrypt-decrypt-action");
          }
        }
      })
    );

    // --- Auto-encrypt daily notes & duplicate prevention ---

    plugin.registerEvent(
      plugin.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== "md") return;
        if (this.converter.isConverting) return;
        if (!this.isDailyNote(file)) return;

        // If an encrypted version already exists, the daily notes plugin
        // (or calendar, navbar, etc.) created a duplicate .md. Delete it
        // and open the .flwct instead.
        const flwctPath = file.path.replace(/\.md$/, `.${FLWCT_EXTENSION}`);
        const flwctFile = this.plugin.app.vault.getAbstractFileByPath(flwctPath);
        if (flwctFile instanceof TFile) {
          setTimeout(async () => {
            // Delete the duplicate .md
            const current = this.plugin.app.vault.getAbstractFileByPath(file.path);
            if (current instanceof TFile) {
              await this.plugin.app.vault.delete(current);
            }
            // Open the encrypted version
            const leaf = this.plugin.app.workspace.getLeaf(false);
            await leaf.openFile(flwctFile);
          }, 100);
          return;
        }

        // Auto-encrypt if enabled
        if (this.plugin.settings.autoEncryptDailyNotes) {
          setTimeout(() => this.autoEncryptFile(file), 500);
        }
      })
    );

    // --- Patch daily notes command to find .flwct files ---

    plugin.app.workspace.onLayoutReady(() => {
      this.patchDailyNotesCommand();
      this.patchGetLeavesOfType();
    });
  }

  onunload(): void {
    // Restore original getLeavesOfType if we patched it
    if (this.originalGetLeavesOfType) {
      this.plugin.app.workspace.getLeavesOfType = this.originalGetLeavesOfType;
      this.originalGetLeavesOfType = null;
    }
  }

  buildSettingsUi(_containerEl: HTMLElement, _saveCallback: () => Promise<void>): void {
    // No feature-specific settings beyond the global ones
  }

  // --- Actions ---

  private async createEncryptedNote(folder?: TFolder): Promise<void> {
    // Determine target folder
    const targetFolder = folder
      ?? this.plugin.app.fileManager.getNewFileParent("")
      ?? this.plugin.app.vault.getRoot();

    // Prompt for password
    const result = await PasswordModal.prompt(
      this.plugin.app,
      "encrypt",
      "",
      this.plugin.settings.confirmPassword,
      this.plugin.settings.showPasswordHint,
      this.plugin.settings.showCleartextPassword
    );
    if (!result) return;

    // Generate unique filename
    let baseName = "Encrypted note";
    let counter = 0;
    let filePath = `${targetFolder.path}/${baseName}.${FLWCT_EXTENSION}`;
    while (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
      counter++;
      filePath = `${targetFolder.path}/${baseName} ${counter}.${FLWCT_EXTENSION}`;
    }

    // Create encrypted empty note
    const encryptedJson = await encode("", result.password, result.hint);
    const file = await this.plugin.app.vault.create(filePath, encryptedJson);

    // Cache password
    this.plugin.sessionManager.put(file.path, result.password, result.hint);

    // Open the new note in edit mode
    const leaf = this.plugin.app.workspace.getLeaf(false);
    await leaf.openFile(file, { state: { mode: "source" } });

    new Notice(`Created: ${file.basename}`);
  }

  private lockAll(): void {
    for (const leaf of this.getEncryptedLeaves()) {
      (leaf.view as EncryptedMarkdownView).lockAndClose();
    }
    this.plugin.sessionManager.clear();
    new Notice("All encrypted notes locked.");
  }

  private async lockFile(file: TFile): Promise<void> {
    for (const leaf of this.getEncryptedLeaves()) {
      if ((leaf.view as any).file?.path === file.path) {
        (leaf.view as EncryptedMarkdownView).lockAndClose();
      }
    }
  }

  /**
   * Patch the core daily-notes "Open today's daily note" command to check
   * for an encrypted .flwct version before falling through to the default.
   * This makes the daily notes button, hotkey, and calendar plugin all
   * open the encrypted daily note if one exists.
   */
  private patchDailyNotesCommand(): void {
    const dailyNotes = (this.plugin.app as any).internalPlugins?.getPluginById?.("daily-notes");
    if (!dailyNotes?.enabled) return;

    const options = dailyNotes.instance?.options;
    const folder = (options?.folder ?? "").replace(/^\/|\/$/g, "");
    const format = options?.format ?? "YYYY-MM-DD";

    const allCommands = (this.plugin.app as any).commands?.commands;
    if (!allCommands) return;

    // The core daily notes command ID is "daily-notes"
    for (const [id, cmd] of Object.entries(allCommands)) {
      if (id !== "daily-notes") continue;
      const command = cmd as any;
      if (!command.callback) continue;

      const original = command.callback;
      command.callback = async () => {
        const today = (window as any).moment().format(format);
        const flwctPath = folder
          ? `${folder}/${today}.${FLWCT_EXTENSION}`
          : `${today}.${FLWCT_EXTENSION}`;

        const flwctFile = this.plugin.app.vault.getAbstractFileByPath(flwctPath);
        if (flwctFile instanceof TFile) {
          const leaf = this.plugin.app.workspace.getLeaf(false);
          await leaf.openFile(flwctFile);
          return;
        }

        // No encrypted version — fall through to original
        original();
      };
      break;
    }
  }

  /**
   * Patch workspace.getLeavesOfType so that querying "markdown" also
   * returns leaves with an EncryptedMarkdownView. This makes encrypted
   * notes visible to plugins like Daily Note Navbar that enumerate
   * markdown leaves.
   */
  private patchGetLeavesOfType(): void {
    if (!this.plugin.settings.dailyNoteNavbarIntegration) return;

    const navbar = (this.plugin.app as any).plugins?.plugins?.["daily-note-navbar"];
    if (!navbar) return;

    const workspace = this.plugin.app.workspace;
    this.originalGetLeavesOfType = workspace.getLeavesOfType.bind(workspace);
    const original = this.originalGetLeavesOfType;

    workspace.getLeavesOfType = (type: string): WorkspaceLeaf[] => {
      const leaves = original(type);
      if (type === "markdown") {
        workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
          if (leaf.view instanceof EncryptedMarkdownView) {
            leaves.push(leaf);
          }
        });
      }
      return leaves;
    };
  }

  /**
   * Check if a file is in the daily notes folder.
   * Reads the core daily-notes plugin settings for the configured folder.
   */
  private isDailyNote(file: TFile): boolean {
    const dailyNotes = (this.plugin.app as any).internalPlugins?.getPluginById?.("daily-notes");
    if (!dailyNotes?.enabled) return false;
    const folder = (dailyNotes.instance?.options?.folder ?? "").replace(/^\/|\/$/g, "");
    if (!folder) return false;
    const fileFolder = file.parent?.path ?? "";
    return fileFolder === folder;
  }

  /**
   * Auto-encrypt a file using the session password. Silent — never prompts.
   * If no password is cached, the file stays as .md until the user encrypts
   * it manually or a session password becomes available.
   */
  private async autoEncryptFile(file: TFile): Promise<void> {
    // Verify the file still exists and is still .md (might have been encrypted already)
    const current = this.plugin.app.vault.getAbstractFileByPath(file.path);
    if (!(current instanceof TFile) || current.extension !== "md") return;

    // Only encrypt when a session password is available — never prompt
    const password = this.plugin.sessionManager.getPassword(file.path);
    if (!password) return;
    const hint = "";

    // Find the leaf that has this file open and remember its mode
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

    for (const leaf of otherLeaves) {
      leaf.detach();
    }

    // Read, encrypt, create .flwct
    const plaintext = await this.plugin.app.vault.read(current);
    const encryptedJson = await encode(plaintext, password, hint);
    const newPath = file.path.replace(/\.md$/, `.${FLWCT_EXTENSION}`);
    const newFile = await this.plugin.app.vault.create(newPath, encryptedJson);

    this.plugin.sessionManager.put(newPath, password, hint);

    // Preserve position in manual-sorting plugin
    await this.converter.updateManualSortOrder(file.path, newPath);

    // Reopen in same leaf BEFORE deleting — vault.delete closes tabs
    const leaf = targetLeaf ?? this.plugin.app.workspace.getLeaf(false);
    await leaf.openFile(newFile, { state: { mode: viewMode } });

    // Delete original
    await this.plugin.app.vault.delete(current);

    new Notice(`Daily note encrypted: ${newFile.basename}`);
  }

  /** Find all leaves with an EncryptedMarkdownView (by instanceof, not view type). */
  private getEncryptedLeaves(): WorkspaceLeaf[] {
    const result: WorkspaceLeaf[] = [];
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof EncryptedMarkdownView) {
        result.push(leaf);
      }
    });
    return result;
  }
}
