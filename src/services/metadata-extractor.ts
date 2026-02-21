/**
 * Extract metadata (links, tags, properties) from plaintext markdown.
 *
 * Used to populate stub files so Obsidian's graph view, backlinks, and
 * outgoing links work for encrypted notes — without decryption.
 */

export interface NoteMetadata {
  links: string[];
  tags: string[];
  properties: Record<string, any>;
}

/**
 * Parse plaintext markdown and extract links, tags, and frontmatter properties.
 */
export function extractMetadata(plaintext: string): NoteMetadata {
  const links: Set<string> = new Set();
  const tags: Set<string> = new Set();
  const properties: Record<string, any> = {};

  // Split frontmatter from body
  let body = plaintext;
  const fmMatch = plaintext.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    parseFrontmatter(fmMatch[1], tags, properties);
    body = plaintext.slice(fmMatch[0].length);
  }

  // Extract wikilinks: [[Page Name]] or [[Page Name|alias]] or [[Page Name#heading]]
  const wikiRe = /\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRe.exec(body)) !== null) {
    const page = m[1].trim();
    if (page) links.add(page);
  }

  // Extract markdown links: [text](path.md) — exclude http(s) URLs
  const mdLinkRe = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
  while ((m = mdLinkRe.exec(body)) !== null) {
    const href = m[1].trim();
    if (href && !href.match(/^https?:\/\//i)) {
      links.add(href.replace(/\.md$/, ""));
    }
  }

  // Extract inline tags: #tag-name (outside frontmatter)
  const tagRe = /(?:^|[\s,;])#([a-zA-Z0-9_/-]+)/gm;
  while ((m = tagRe.exec(body)) !== null) {
    tags.add(m[1]);
  }

  return {
    links: [...links].sort(),
    tags: [...tags].sort(),
    properties,
  };
}

/**
 * Parse YAML frontmatter key-value pairs.
 * Handles tags/tag arrays (both `[a, b]` and `- a` formats).
 */
function parseFrontmatter(
  yaml: string,
  tags: Set<string>,
  properties: Record<string, any>,
): void {
  const lines = yaml.split(/\r?\n/);
  let currentKey = "";
  let inArray = false;

  for (const line of lines) {
    // Array continuation: "  - value"
    const arrayItem = line.match(/^\s+-\s+(.+)/);
    if (arrayItem && inArray && currentKey) {
      const value = arrayItem[1].trim();
      if (currentKey === "tags" || currentKey === "tag") {
        tags.add(value.replace(/^#/, ""));
      } else {
        if (!Array.isArray(properties[currentKey])) {
          properties[currentKey] = [];
        }
        (properties[currentKey] as any[]).push(parseYamlValue(value));
      }
      continue;
    }

    // Key-value pair: "key: value"
    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)/);
    if (!kvMatch) {
      inArray = false;
      continue;
    }

    currentKey = kvMatch[1];
    const rawValue = kvMatch[2].trim();

    // Inline array: [a, b, c]
    const inlineArray = rawValue.match(/^\[([^\]]*)\]$/);
    if (inlineArray) {
      const items = inlineArray[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (currentKey === "tags" || currentKey === "tag") {
        for (const item of items) tags.add(item.replace(/^#/, ""));
      } else {
        properties[currentKey] = items.map(parseYamlValue);
      }
      inArray = false;
      continue;
    }

    // Empty value (start of block array)
    if (!rawValue) {
      inArray = true;
      continue;
    }

    // Scalar value
    inArray = false;
    if (currentKey === "tags" || currentKey === "tag") {
      tags.add(rawValue.replace(/^#/, ""));
    } else {
      properties[currentKey] = parseYamlValue(rawValue);
    }
  }
}

/** Convert a YAML string value to a typed JS value. */
function parseYamlValue(value: string): any {
  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;
  return value;
}
