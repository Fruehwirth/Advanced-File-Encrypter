/**
 * Stub lifecycle manager — creates/deletes .md stubs in .enc-index/
 * so Obsidian's graph view, backlinks, and outgoing links see
 * the encrypted note's connections without decryption.
 *
 * Stub files are real .md files that Obsidian indexes naturally.
 * They contain frontmatter (with enc-source and properties),
 * inline tags, and wikilinks extracted from the plaintext metadata
 * stored in the .locked file's JSON.
 */

import { App, TFile, TFolder, normalizePath } from "obsidian";
import { LOCKED_EXTENSION, parse } from "./file-data";
import type { NoteMetadata } from "./metadata-extractor";

export const STUB_FOLDER = ".enc-index";

export class StubManager {
  private app: App;
  private settingsGetter: () => boolean;

  constructor(app: App, settingsGetter: () => boolean) {
    this.app = app;
    this.settingsGetter = settingsGetter;
  }

  /** Convert a .locked path to its stub path: Notes/Secret.locked → .enc-index/Notes/Secret.md */
  getStubPath(lockedPath: string): string {
    const withoutExt = lockedPath.replace(new RegExp(`\\.${LOCKED_EXTENSION}$`), "");
    return normalizePath(`${STUB_FOLDER}/${withoutExt}.md`);
  }

  /** True if path starts with the stub folder. */
  isStubPath(path: string): boolean {
    return path.startsWith(STUB_FOLDER + "/") || path === STUB_FOLDER;
  }

  /** Create or update a stub file for a .locked file. */
  async writeStub(lockedPath: string, metadata: NoteMetadata | undefined): Promise<void> {
    if (!this.settingsGetter()) return;

    try {
      const stubPath = this.getStubPath(lockedPath);
      const content = this.buildStubContent(lockedPath, metadata);

      // Ensure parent folders exist
      await this.ensureFolder(stubPath);

      const existing = this.app.vault.getAbstractFileByPath(stubPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(stubPath, content);
      }
    } catch (err) {
      console.warn("Advanced File Encryption: failed to write stub for", lockedPath, err);
    }
  }

  /** Delete the stub file for a .locked file. */
  async deleteStub(lockedPath: string): Promise<void> {
    try {
      const stubPath = this.getStubPath(lockedPath);
      const existing = this.app.vault.getAbstractFileByPath(stubPath);
      if (existing instanceof TFile) {
        await this.app.vault.delete(existing);
      }
    } catch (err) {
      console.warn("Advanced File Encryption: failed to delete stub for", lockedPath, err);
    }
  }

  /** Read a .locked file's JSON and write its stub from the metadata field. */
  async writeStubFromFile(file: TFile): Promise<void> {
    if (!this.settingsGetter()) return;

    try {
      const raw = await this.app.vault.read(file);
      const data = parse(raw);
      await this.writeStub(file.path, data.metadata);
    } catch (err) {
      console.warn("Advanced File Encryption: failed to write stub from file", file.path, err);
    }
  }

  /**
   * Sync all stubs:
   * 1. Create missing stubs for .locked files that have metadata
   * 2. Delete orphaned stubs whose .locked source no longer exists
   * 3. Clean up empty folders under .enc-index
   */
  async syncAllStubs(): Promise<void> {
    if (!this.settingsGetter()) return;

    try {
      // Collect all .locked files
      const lockedFiles = this.app.vault.getFiles().filter(
        (f) => f.extension === LOCKED_EXTENSION
      );

      // Track which stub paths are valid
      const validStubPaths = new Set<string>();

      for (const file of lockedFiles) {
        const stubPath = this.getStubPath(file.path);
        validStubPaths.add(stubPath);

        // Only create missing stubs
        const existing = this.app.vault.getAbstractFileByPath(stubPath);
        if (!existing) {
          await this.writeStubFromFile(file);
        }
      }

      // Delete orphaned stubs
      const stubFolder = this.app.vault.getAbstractFileByPath(STUB_FOLDER);
      if (stubFolder instanceof TFolder) {
        const orphans = this.collectFiles(stubFolder).filter(
          (f) => !validStubPaths.has(f.path)
        );
        for (const orphan of orphans) {
          await this.app.vault.delete(orphan);
        }

        // Clean up empty folders
        await this.cleanEmptyFolders(stubFolder);
      }
    } catch (err) {
      console.warn("Advanced File Encryption: failed to sync stubs", err);
    }
  }

  /** Hide .enc-index/ from the file explorer using Obsidian's userIgnoreFilters. */
  excludeFromExplorer(): void {
    try {
      const vault = this.app.vault as any;
      const config = vault.getConfig?.("userIgnoreFilters");
      const filters: string[] = Array.isArray(config) ? config : [];
      const pattern = STUB_FOLDER + "/";
      if (!filters.includes(pattern)) {
        filters.push(pattern);
        vault.setConfig?.("userIgnoreFilters", filters);
      }
    } catch (err) {
      console.warn("Advanced File Encryption: failed to exclude stub folder from explorer", err);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private buildStubContent(lockedPath: string, metadata: NoteMetadata | undefined): string {
    const lines: string[] = [];

    // Frontmatter
    lines.push("---");
    lines.push(`enc-source: "${lockedPath}"`);

    if (metadata?.properties) {
      for (const [key, value] of Object.entries(metadata.properties)) {
        if (key === "enc-source") continue; // reserved
        if (Array.isArray(value)) {
          lines.push(`${key}:`);
          for (const item of value) {
            lines.push(`  - ${formatYamlValue(item)}`);
          }
        } else {
          lines.push(`${key}: ${formatYamlValue(value)}`);
        }
      }
    }

    lines.push("---");
    lines.push("");

    // Inline tags
    if (metadata?.tags && metadata.tags.length > 0) {
      lines.push(metadata.tags.map((t) => `#${t}`).join(" "));
      lines.push("");
    }

    // Wikilinks
    if (metadata?.links && metadata.links.length > 0) {
      for (const link of metadata.links) {
        lines.push(`[[${link}]]`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash === -1) return;
    const folderPath = filePath.substring(0, lastSlash);

    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing instanceof TFolder) return;

    await this.app.vault.createFolder(folderPath);
  }

  private collectFiles(folder: TFolder): TFile[] {
    const result: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) {
        result.push(child);
      } else if (child instanceof TFolder) {
        result.push(...this.collectFiles(child));
      }
    }
    return result;
  }

  private async cleanEmptyFolders(folder: TFolder): Promise<void> {
    for (const child of [...folder.children]) {
      if (child instanceof TFolder) {
        await this.cleanEmptyFolders(child);
        // Re-check after cleaning children
        const current = this.app.vault.getAbstractFileByPath(child.path);
        if (current instanceof TFolder && current.children.length === 0) {
          await this.app.vault.delete(current);
        }
      }
    }
  }
}

function formatYamlValue(value: any): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  return String(value);
}
