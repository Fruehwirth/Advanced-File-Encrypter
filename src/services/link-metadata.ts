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
    data.linkMetadata = this.store;
    await this.plugin.saveData(data);
    this.dirty = false;
  }

  /**
   * Extract and persist link metadata from plaintext.
   * Call this after successful decryption and on every save.
   */
  update(filePath: string, plaintext: string): void {
    if (!this.plugin.settings.persistLinkMetadata) return;

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

    const parts: string[] = [];

    // Frontmatter
    if (meta.frontmatter) {
      parts.push(meta.frontmatter);
    }

    // Links (rendered as a hidden comment-like block)
    for (const link of meta.links) {
      parts.push(`[[${link}]]`);
    }

    // Embeds
    for (const embed of meta.embeds) {
      parts.push(`![[${embed}]]`);
    }

    // Tags
    for (const tag of meta.tags) {
      parts.push(`#${tag}`);
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
