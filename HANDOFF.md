# Handoff: Local Graph Closes During Encrypt/Decrypt Conversion

## Project
Obsidian plugin "Advanced File Encryption" — transparent whole-note encryption. Notes are `.locked` files on disk, plaintext in the editor. The plugin registers a custom `EncryptedMarkdownView` (extends `MarkdownView`) for `.locked` files.

## The Bug
When a user converts a file between `.md` and `.locked` (encrypt/decrypt) while it's the active tab, the **local graph panel** closes. Other sidebar panels (backlinks, outgoing links, outline, all-properties) do NOT close — only the local graph.

### User-discovered workaround
Manually close the tab → right-click file in sidebar → encrypt/decrypt → open the new file. The local graph stays open this way. This proves the graph panel CAN survive file changes; something in the programmatic conversion kills it.

---

## Architecture Context

### View type masquerading
- `registerView(VIEW_TYPE_ENCRYPTED, ...)` registers factory type `"advanced-file-encryption-encrypted-view"`
- `registerExtensions(["locked"], VIEW_TYPE_ENCRYPTED)` maps `.locked` → factory type
- BUT `EncryptedMarkdownView.getViewType()` returns `"markdown"` at runtime
- This is intentional: sidebar panels (backlinks, outline, etc.) only attach to views reporting `"markdown"`
- Creates a split: factory type ≠ runtime type

### Current conversion flow (note-converter.ts)
```
toEncrypted(.md → .locked):
1. findLeaves(file) — find the leaf showing the .md
2. vault.read(file) — get plaintext
3. vault.create(newPath, encryptedJson) — create .locked on disk
4. leaf.openFile(newFile) — open .locked in same leaf (view type transition!)
5. vault.delete(file) — delete original .md

toDecrypted(.locked → .md):
1. findLeaves(file) — find the leaf showing the .locked
2. vault.read(file) + decode() — read and decrypt
3. vault.create(newPath, plaintext) — create .md on disk
4. leaf.openFile(newFile) — open .md in same leaf (view type transition!)
5. vault.delete(file) — delete original .locked
```

### The view type transition problem
When `leaf.openFile(.locked)` is called on a leaf showing a .md file:
- Obsidian looks up `.locked` extension → factory type `"advanced-file-encryption-encrypted-view"`
- Current view on leaf is MarkdownView (factory type `"markdown"`)
- `"advanced-file-encryption-encrypted-view" ≠ "markdown"` → **Obsidian destroys the old view instance and creates a new one**
- This view destruction/creation may be what kills the local graph

Same in reverse: `.locked` → `.md` transitions from EncryptedMarkdownView to MarkdownView.

---

## What Has Been Tried

### Approach 1: Current code (create + openFile + delete)
**Status:** Original approach. Local graph closes.
- Creates new file, opens it in the same leaf, deletes old file
- The `reopenInLeaf()` call happens BEFORE `vault.delete()` to prevent tab closure
- File: `src/features/whole-note/note-converter.ts`

### Approach 2: Close-tab-then-reopen
**Status:** Tried and FAILED. Local graph still closes.
- Close all leaves showing the file (`leaf.detach()`)
- Convert on disk (create new, delete old)
- Open the new file fresh with `getLeaf(false).openFile(newFile)`
- Also tried adding `await sleep(50)` between close and file operations
- The `sleep` import from `"obsidian"` doesn't exist at runtime (`(0, I.sleep) is not a function`) — had to use inline `setTimeout` wrapper
- Local graph STILL closed with this approach

### Approach 3: Diagnostic logging (iterateAllLeaves)
**Status:** Run twice. Surprising results.
- Added `dumpLeafTypes()` that calls `iterateAllLeaves()` and logs all view types at 4 points: BEFORE, AFTER create, AFTER openFile, AFTER delete
- **Critical finding: the local graph does NOT appear in iterateAllLeaves() output** — not even BEFORE the conversion starts, when it should be visible
- All other sidebar panels (backlink, outgoing-link, outline, all-properties) DO appear
- All leaf types remain **identical** through all 4 steps — nothing disappears
- This means either: (a) the local graph uses a mechanism that `iterateAllLeaves()` can't capture, or (b) the local graph wasn't actually open during the test

### Diagnostic output (with local graph supposedly open)
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
  markdown (Notes/THIS IS THE TEST ENVIRONMENT.locked)   ← view transitioned
  (all sidebar leaves identical)

[AFE-DIAG] AFTER vault.delete:
  (identical)
```

No leaf disappears at any step. The local graph type never appears in the list.

### Previous investigation (from earlier sessions)
- `getLeavesOfType("localgraph")` returns empty even when local graph is visually open
- The leaf object's properties were enumerated — no `viewState` property exists (leaf has: `_, containerEl, dimension, component, app, workspace, id, resizeHandleEl, type, activeTime, history, hoverPopover, group, pinned, width, height, resizeObserver, working, tabHeaderEl, ...`)
- `leaf.getViewState().type` already returns `"markdown"` for EncryptedMarkdownView

---

## Unsolved Questions

1. **What view type does the local graph use?** It's not `"localgraph"`, and `iterateAllLeaves()` doesn't find it. Is it a different kind of UI element? A hover/popover? Part of the leaf DOM rather than a separate leaf?

2. **Is the local graph even a workspace leaf?** The diagnostic logging suggests it might NOT be. If it's not a leaf, it's rendered differently — possibly as an embedded panel within the active leaf, or via a different workspace API.

3. **Exactly which step kills it?** The diagnostic logging shows no leaf changes at any step. But the graph visually closes. This means the graph panel might be responding to an EVENT (like `active-leaf-change` or `file-open`) rather than being a leaf that gets detached.

4. **Would `vault.modify()` + `fileManager.renameFile()` work?** Instead of create+delete, modify the file content in-place then rename the extension. This keeps the TFile alive and fires "rename" instead of "create"+"delete" events. Never tested. Potential issue: intermediate state where the .md file contains encrypted JSON (or .locked contains plaintext) before the rename completes.

---

## Approaches NOT Yet Tried

### A. Isolate via manual Obsidian testing
Have the user test WITHOUT the plugin:
1. Open file A.md, open local graph
2. Via dev console: `app.workspace.activeLeaf.openFile(app.vault.getAbstractFileByPath("some.locked"))`
3. Does the local graph survive a view type transition?
4. If yes → something specific in our code kills it
5. If no → it's a fundamental Obsidian behavior when the view type changes

### B. Rename-based conversion (`vault.modify` + `fileManager.renameFile`)
- Modify content in-place, then rename the extension
- No create/delete events, TFile stays alive
- Fires "modify" + "rename" events instead
- May handle view transitions more gracefully
- Risk: intermediate state where file has wrong content for its extension

### C. Discover the local graph's true nature
- Use `document.querySelectorAll('.graph-view-container')` or similar to find the graph DOM
- Walk up from the DOM element to find what workspace component owns it
- Check `app.workspace.rightSplit` or `app.workspace.leftSplit` for non-leaf panels
- Try `app.workspace.getLeavesOfType("graph")` (not "localgraph")

### D. Intercept and restore
- Before conversion: snapshot something about the local graph's state
- After conversion: programmatically reopen local graph
- Command: `app.commands.executeCommandById("graph:open-local")`
- Problem: can't detect if graph was open (iterateAllLeaves doesn't see it)
- Could always reopen it, but that's bad UX if user didn't have it open

### E. Avoid view type transition entirely
- What if EncryptedMarkdownView could handle BOTH .md and .locked without Obsidian needing to swap views?
- The view already has `_isPlaintextMode` and `canAcceptExtension("md")`
- But we can't control which view Obsidian creates for .md files — it uses the native MarkdownView
- Would require registering .md extension too (breaks everything)

---

## Key Files
- `src/views/encrypted-markdown-view.ts` — Core view, `getViewType()` returns "markdown"
- `src/features/whole-note/note-converter.ts` — Conversion logic + diagnostic logging (currently active)
- `src/features/whole-note/feature.ts` — Commands, ribbon, file menu, auto-encrypt
- `src/main.ts` — Plugin entry point, registerView + registerExtensions
- `src/services/file-data.ts` — `.locked` file format

## Build
`npm run build` (esbuild). No TypeScript errors tolerated.

## Secondary Issue: Omnisearch Errors
After conversion, Omnisearch throws `Invalid file path` errors for deleted files. Omnisearch's stale cache, not our bug. Low priority.

## Nuked Code
A previous "link metadata persistence" system was completely removed. Do NOT re-introduce.
