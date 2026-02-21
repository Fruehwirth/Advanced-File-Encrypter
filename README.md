# Advanced File Encryption

Transparent whole-note encryption for Obsidian. Notes are encrypted on disk as `.locked` files but appear as normal markdown in the editor. Keys and plaintext exist only in memory and are cleared when Obsidian closes.

## How it works

When you encrypt a note, the plugin:

1. Reads the markdown content
2. Encrypts it with AES-256-GCM using a password-derived key (PBKDF2, 600k iterations)
3. Writes the ciphertext as a self-describing JSON file with a `.locked` extension
4. Registers a custom view that decrypts on open and re-encrypts on save

The `.locked` file contains everything needed to decrypt without the plugin: algorithm, key derivation parameters, salt, IV, and ciphertext. No data is stored outside the file itself.

## Features

- Full editor support: syntax highlighting, preview mode, vim mode, toolbar, etc.
- Inline password UI (no modal popups) for unlock, encrypt, and change password
- Session password caching with configurable timeout
- Four security modes: session password, timed password, keys-only, no storage
- Auto-encrypt daily notes on creation
- Right-click menu and view header actions for encrypt/decrypt
- Backward-compatible with legacy file format (v1)
- Integration with Manual Sorting, Daily Note Navbar, and Editing Toolbar plugins

## Metadata and linking

Obsidian's metadata cache only indexes `.md` files. Without intervention, encrypted notes lose all linking functionality: backlinks, outgoing links, graph view, and the Properties panel go blank.

When enabled (on by default), the plugin stores extracted metadata (links, embeds, tags, frontmatter) as an unencrypted field in the `.locked` file. On startup and whenever a note is opened or saved, this metadata is injected into Obsidian's internal cache so that graph connections, backlinks, and properties work even for locked notes.

**Privacy tradeoff:** Stored metadata is readable without the password. This is inherent to the feature -- you cannot have working graph/backlinks for locked files without exposing what they link to. Two settings let you control this:

- **Persist links and tags** -- links, embeds, and tags (for graph, backlinks, outgoing links)
- **Expose properties** -- frontmatter (for the Properties panel)

Turn both off if you want no metadata exposure.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Security mode | Session Password | How passwords/keys are handled in memory |
| Session timeout | 30 min | Auto-expire for session password mode |
| Password window | 60 sec | Keep window for timed password mode |
| Confirm password | On | Require confirmation when encrypting |
| Password hint | On | Show hint field when encrypting |
| Show cleartext | Off | Default to visible passwords |
| Persist links and tags | On | Store link metadata in encrypted files |
| Expose properties | On | Store frontmatter in encrypted files |
| Auto-encrypt daily notes | On | Encrypt new daily notes automatically |

## Security notes

- Encryption: AES-256-GCM with random IV and salt per save
- Key derivation: PBKDF2-SHA256 with 600,000 iterations
- Plaintext and keys exist only in memory while a note is open
- The `.locked` file format is self-describing and portable
- Password hints and metadata (if enabled) are stored unencrypted
- The plugin uses the Web Crypto API -- no bundled crypto libraries
