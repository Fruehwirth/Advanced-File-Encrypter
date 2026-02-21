# Investigation: Local Graph Closes During Encrypt/Decrypt Conversion

## The Problem
When converting a file between `.md` and `.locked` (encrypt/decrypt) while it's the active tab, the **local graph panel** closes. Other sidebar panels (backlinks, outgoing links, outline, all-properties) stay open — only the local graph is affected.

### Workaround that works (manual)
1. Close the tab manually
2. Right-click the file in the file explorer sidebar → Encrypt/Decrypt
3. Open the new file

The local graph stays open in this flow because no view transition happens — the tab was already closed, so Obsidian just does file operations on disk.

---

## Current Conversion Flow (note-converter.ts)

```
toEncrypted(.md file):
  1. findLeaves(file) → find the leaf showing the .md
  2. vault.read(file) → get plaintext
  3. vault.create(newPath, encrypted) → create .locked file on disk
  4. leaf.openFile(newFile) → open .locked in same leaf
  5. vault.delete(file) → delete old .md
```

The same pattern (reversed) applies to `toDecrypted`.

---

## What Has Been Tried

### Approach 1: Current code (create → openFile → delete)
**Result:** Local graph closes. Other sidebar panels survive.

### Approach 2: Close-tab-then-reopen
Close all leaves, convert on disk, open fresh in `getLeaf(false)`:
```
  1. closeAllLeavesForFile(file) → save + detach
  2. sleep(50) → let Obsidian process
  3. vault.create → create new file on disk
  4. vault.delete → delete old file
  5. getLeaf(false).openFile(newFile) → open fresh
```
**Result:** Local graph still closes. (Also had issue: `obsidian.sleep` not exported, needed inline setTimeout.)

### Approach 3: Diagnostic leaf dump
Added `iterateAllLeaves()` logging at 4 points during conversion:
- BEFORE anything
- AFTER vault.create
- AFTER leaf.openFile
- AFTER vault.delete

**Result (full output):**
```
[AFE-DIAG] BEFORE anything:
  markdown (Home.md)
  markdown (Notes/THIS IS THE TEST ENVIRONMENT.md)
  file-explorer, search, bookmarks, recent-files, calendar, tag
  backlink, outgoing-link, outline, all-properties

[AFE-DIAG] AFTER vault.create:
  (identical)

[AFE-DIAG] AFTER leaf.openFile:
  markdown (Home.md)
  markdown (Notes/THIS IS THE TEST ENVIRONMENT.locked)  ← view transitioned
  (all sidebar panels identical)

[AFE-DIAG] AFTER vault.delete:
  (identical)
```

### Key diagnostic findings:
1. **The local graph NEVER appears in `iterateAllLeaves()`** — not even BEFORE conversion when it should be visibly open
2. **All leaf types remain identical** through every step — no leaf is created or destroyed during conversion
3. **`getLeavesOfType("localgraph")` returns empty** even when the local graph is visually open (from earlier HANDOFF testing)
4. The EncryptedMarkdownView correctly reports as `"markdown"` type (confirmed: `markdown (....locked)` in logs)
5. `backlink`, `outgoing-link`, `outline`, `all-properties` all survive perfectly

---

## What This Means

The local graph in Obsidian is **NOT a regular workspace leaf**. It uses a different rendering mechanism that `iterateAllLeaves()` and `getLeavesOfType()` cannot see. This explains why:
- We can't detect whether it's open before conversion
- We can't snapshot/restore it
- Previous attempts to "reopen missing sidebar panels" after conversion failed (couldn't detect what was missing)

The local graph might be:
- An embedded component within the leaf's DOM (not a separate leaf)
- A hover/popover panel
- Part of a different workspace container that `iterateAllLeaves` doesn't traverse
- A "linked view" attached to the leaf internally via a mechanism we can't access

---

## Architecture Context

- `registerExtensions([LOCKED_EXTENSION], VIEW_TYPE_ENCRYPTED)` maps `.locked` → factory type `"advanced-file-encryption-encrypted-view"`
- `EncryptedMarkdownView.getViewType()` returns `"markdown"` at runtime (so sidebar panels recognize it)
- When `leaf.openFile(.locked)` is called, Obsidian matches the extension to the factory type `"advanced-file-encryption-encrypted-view"`, sees it differs from current `"markdown"`, and **destroys the old MarkdownView to create an EncryptedMarkdownView**
- This view instance destruction/recreation on the leaf is the likely trigger
- The local graph may be internally linked to the view instance or the leaf's internal state, and the destruction breaks that link

---

## Untried Approaches

### A. `vault.modify()` + `fileManager.renameFile()` (instead of create+delete)
**Idea:** Modify file content in-place, then rename the extension. The TFile object stays alive (no create/delete events). Obsidian handles the extension change via rename, which may handle the view transition more gracefully.

**Concern:** Intermediate state — after `vault.modify()` but before `renameFile()`, the file has wrong content for its extension (e.g., encrypted JSON in a .md file). The current view would briefly display garbage. Needs careful ordering or suppression.

### B. DOM inspection of the local graph
**Idea:** Instead of using `iterateAllLeaves()`, inspect the DOM tree around the active leaf to find the local graph element. Obsidian might render it as a child of the leaf's container rather than a separate leaf. If we can find it in the DOM, we can understand how it's attached and how to preserve it.

**How to test:** In dev console, run:
```javascript
// Find all elements with "graph" in their class name
document.querySelectorAll('[class*="graph"]')

// Or inspect the right sidebar container
document.querySelector('.workspace-split.mod-right-split')?.innerHTML
```

### C. Monkey-patch `leaf.openFile` to suppress view recreation
**Idea:** Before conversion, temporarily patch the leaf's `openFile` to prevent view destruction. Since EncryptedMarkdownView extends MarkdownView and accepts both `.md` and `.locked` files (via `canAcceptExtension`), we might be able to reuse the same view instance.

**How:** Intercept the view state check that decides whether to recreate the view. If the current view can handle the new file type, skip the recreation.

### D. Use `leaf.setViewState()` with explicit type
**Idea:** Instead of `leaf.openFile(newFile)`, manually set the view state to keep the same view type:
```typescript
await leaf.setViewState({
  type: "markdown",  // force "markdown" type, not the factory type
  state: { file: newPath, mode: viewMode }
});
```
This might trick Obsidian into reusing the current view rather than looking up the extension's registered type.

### E. Register EncryptedMarkdownView as "markdown" type
**Idea:** Instead of a custom factory type, register the encrypted view directly as "markdown" and intercept file loading based on extension. This eliminates the factory type mismatch entirely.

**Concern:** Would conflict with Obsidian's built-in markdown view factory. Might cause all .md files to use EncryptedMarkdownView (which the plaintext mode already handles, but could have side effects).

### F. Execute the "Open local graph" command after conversion
**Idea:** After conversion, run `app.commands.executeCommandById("graph:open-local")`. Accept the flash and just reopen it.

**Concern:** Would open the graph even when the user didn't have it open. Can't detect if it was open (iterateAllLeaves doesn't see it). Could work if we always execute it and it's a no-op when already open (needs testing).

### G. Investigate Obsidian's internal workspace structure
**Idea:** The workspace might have sub-containers or "sidebar splits" that `iterateAllLeaves` doesn't traverse. Check:
```javascript
app.workspace.rightSplit   // right sidebar container
app.workspace.leftSplit    // left sidebar container
app.workspace.floatingSplit // floating panels?
```
Each might have their own leaf iteration that includes the local graph.

---

## Files Involved
- `src/features/whole-note/note-converter.ts` — conversion logic
- `src/features/whole-note/feature.ts` — commands, ribbon, file menu, auto-encrypt
- `src/views/encrypted-markdown-view.ts` — view for .locked files
- `src/main.ts` — plugin registration

## Build
`npm run build` (esbuild). No TypeScript errors tolerated.
