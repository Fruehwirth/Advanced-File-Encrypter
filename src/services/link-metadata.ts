/**
 * Link Metadata Service — persists link/embed information from encrypted notes.
 *
 * When an encrypted note is decrypted and edited, this service extracts
 * [[links]], [[links|aliases]], ![[embeds]], #tags, and frontmatter from
 * the plaintext and stores them in plugin data.
 *
 * When a locked note is opened (before decryption), the cached metadata
 * is used to generate a "link skeleton" — a minimal markdown string
 * containing just the links/tags/frontmatter. This skeleton is fed into
 * the MarkdownView so Obsidian's metadata resolver still sees the links,
 * keeping backlinks, outbound links, and the local graph functional.
 *
 * The skeleton is invisible to the user because the locked-state overlay
 * covers the view content.
 */

import { TFile } from "obsidian";
import type AFEPlugin from "../main";

/** Persisted metadata for one encrypted file. */
export interface FileLinkMetadata {
  /** Internal links: "NoteName", "Folder/NoteName", "NoteName|alias" */
  links: string[];
  /** Embed links: "Image.png", "Note#heading" */
  embeds: string[];
  /** Tags without the # prefix: "tag", "nested/tag" */
  tags: string[];
  /** Raw frontmatter YAML string (if any). */
  frontmatter: string;
  /** Timestamp of last extraction. */
  updatedAt: number;
}

/** Map of file path -> metadata, stored in plugin data. */
export type LinkMetadataStore = Record<string, FileLinkMetadata>;

// Regex patterns for extraction
const WIKILINK_RE = /(?<!!)\[\[([^\]]+?)\]\]/g;
const EMBED_RE = /!\[\[([^\]]+?)\]\]/g;
const TAG_RE = /(?:^|\s)#([a-zA-Z_/][\w/]*)/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export class LinkMetadataService {
  private plugin: AFEPlugin;
  private store: LinkMetadataStore = {};
  private dirty = false;

  constructor(plugin: AFEPlugin) {
    this.plugin = plugin;
  }

  /** Load persisted metadata from plugin data. */
  async load(): Promise<void> {
    const data = await this.plugin.loadData();
    this.store = data?.linkMetadata ?? {};
  }

  /** Save metadata to plugin data (merged with existing settings). */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const data = (await this.plugin.loadData()) ?? {};
    const s = this.plugin.settings;
    // Only persist to disk when at least one caching setting is enabled.
    // When both are off, clear any previously stored data.
    data.linkMetadata = (s.persistLinks || s.exposeProperties) ? this.store : {};
    await this.plugin.saveData(data);
    this.dirty = false;
  }

  /**
   * Extract and persist link metadata from plaintext.
   * Call this after successful decryption and on every save.
   */
  update(filePath: string, plaintext: string): void {
    // Always extract metadata — needed for runtime link resolution even
    // when persistence settings are off. Whether data is written to disk
    // is controlled by save().
    const links: string[] = [];
    const embeds: string[] = [];
    const tags: string[] = [];
    let frontmatter = "";

    // Extract frontmatter
    const fmMatch = plaintext.match(FRONTMATTER_RE);
    if (fmMatch) {
      frontmatter = fmMatch[0]; // Include the --- delimiters
    }

    // Extract wikilinks: [[target]] or [[target|alias]]
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(plaintext)) !== null) {
      links.push(match[1]);
    }

    // Extract embeds: ![[target]]
    EMBED_RE.lastIndex = 0;
    while ((match = EMBED_RE.exec(plaintext)) !== null) {
      embeds.push(match[1]);
    }

    // Extract tags: #tag, #nested/tag
    TAG_RE.lastIndex = 0;
    while ((match = TAG_RE.exec(plaintext)) !== null) {
      tags.push(match[1]);
    }

    this.store[filePath] = {
      links,
      embeds,
      tags,
      frontmatter,
      updatedAt: Date.now(),
    };
    this.dirty = true;
  }

  /**
   * Get cached metadata for a file path.
   * Returns null if no metadata is stored.
   */
  get(filePath: string): FileLinkMetadata | null {
    return this.store[filePath] ?? null;
  }

  /**
   * Build a "link skeleton" string from cached metadata.
   * This is a minimal markdown string that contains just enough content
   * for Obsidian's metadata resolver to see the links, embeds, and tags.
   *
   * The skeleton is invisible to the user because the locked overlay covers it.
   */
  buildSkeleton(filePath: string): string {
    const meta = this.store[filePath];
    if (!meta) return "";

    const settings = this.plugin.settings;
    const parts: string[] = [];

    // Frontmatter (only if exposeProperties is enabled)
    if (settings.exposeProperties && meta.frontmatter) {
      parts.push(meta.frontmatter);
    }

    // Links, embeds, tags (only if persistLinks is enabled)
    if (settings.persistLinks) {
      for (const link of meta.links) {
        parts.push(`[[${link}]]`);
      }
      for (const embed of meta.embeds) {
        parts.push(`![[${embed}]]`);
      }
      for (const tag of meta.tags) {
        parts.push(`#${tag}`);
      }
    }

    return parts.join("\n");
  }

  /**
   * Remove metadata for a file path (e.g. when file is deleted or decrypted).
   */
  remove(filePath: string): void {
    if (this.store[filePath]) {
      delete this.store[filePath];
      this.dirty = true;
    }
  }

  /**
   * Update path when a file is renamed.
   */
  handleRename(oldPath: string, newPath: string): void {
    const meta = this.store[oldPath];
    if (meta) {
      delete this.store[oldPath];
      this.store[newPath] = meta;
      this.dirty = true;
    }
  }

  // ── Obsidian metadataCache injection ─────────────────────────────
  //
  // Obsidian's metadataCache only indexes .md files. Since .locked files
  // contain encrypted JSON on disk, the cache sees no links/tags. We
  // directly inject our extracted metadata into the internal cache so
  // that graph, backlinks, and outgoing links work for encrypted notes.

  /**
   * Inject metadata for a single file into Obsidian's metadataCache.
   * Call after setting view data (skeleton or plaintext).
   */
  inject(filePath: string): void {
    if (this._injectOne(filePath)) {
      (this.plugin.app.metadataCache as any).trigger("resolved");
    }
  }

  /**
   * Inject metadata for ALL stored files into Obsidian's metadataCache.
   * Call once after workspace layout is ready so that graph/backlinks
   * work for locked files that aren't currently open.
   */
  injectAll(): void {
    let injected = false;
    for (const filePath of Object.keys(this.store)) {
      if (this._injectOne(filePath)) injected = true;
    }
    if (injected) {
      (this.plugin.app.metadataCache as any).trigger("resolved");
    }
  }

  /**
   * Internal: inject metadata for a single file. Returns true if
   * something was injected.
   */
  private _injectOne(filePath: string): boolean {
    const meta = this.store[filePath];
    if (!meta) return false;
    if (!meta.links.length && !meta.embeds.length && !meta.tags.length) return false;

    const app = this.plugin.app;
    const mc = app.metadataCache as any;

    // Build a CachedMetadata-compatible object
    const dummyPos = { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } };
    const cache: any = {};

    if (meta.links.length) {
      cache.links = meta.links.map((raw) => {
        const pipeIdx = raw.indexOf("|");
        return {
          link: pipeIdx >= 0 ? raw.substring(0, pipeIdx) : raw,
          original: `[[${raw}]]`,
          displayText: pipeIdx >= 0 ? raw.substring(pipeIdx + 1) : raw,
          position: dummyPos,
        };
      });
    }

    if (meta.embeds.length) {
      cache.embeds = meta.embeds.map((raw) => ({
        link: raw,
        original: `![[${raw}]]`,
        displayText: raw,
        position: dummyPos,
      }));
    }

    if (meta.tags.length) {
      cache.tags = meta.tags.map((tag) => ({
        tag: "#" + tag,
        position: dummyPos,
      }));
    }

    // Inject CachedMetadata into the internal store.
    // The property name varies across Obsidian versions.
    const internalCache = mc.metadataCache ?? mc.cache;
    if (internalCache && typeof internalCache === "object") {
      internalCache[filePath] = cache;
    }

    // Resolve links: map each link target to existing vault files
    const resolved: Record<string, number> = {};
    const unresolved: Record<string, number> = {};

    for (const raw of [...meta.links, ...meta.embeds]) {
      const pipeIdx = raw.indexOf("|");
      let linkPath = pipeIdx >= 0 ? raw.substring(0, pipeIdx) : raw;
      // Strip heading/block references for resolution
      const hashIdx = linkPath.indexOf("#");
      if (hashIdx >= 0) linkPath = linkPath.substring(0, hashIdx);
      if (!linkPath) continue; // Same-file reference like #heading

      const targetFile = app.metadataCache.getFirstLinkpathDest(linkPath, filePath);
      if (targetFile) {
        resolved[targetFile.path] = (resolved[targetFile.path] || 0) + 1;
      } else {
        unresolved[linkPath] = (unresolved[linkPath] || 0) + 1;
      }
    }

    mc.resolvedLinks[filePath] = resolved;
    mc.unresolvedLinks[filePath] = unresolved;

    // Notify per-file so backlinks pane updates
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      mc.trigger("changed", file, "", cache);
    }

    return true;
  }

  /** Clean up entries for files that no longer exist. */
  async cleanup(existingPaths: Set<string>): Promise<void> {
    let changed = false;
    for (const path of Object.keys(this.store)) {
      if (!existingPaths.has(path)) {
        delete this.store[path];
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      await this.save();
    }
  }
}
