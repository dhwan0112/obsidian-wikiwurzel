# Wikiwurzel

Tags for every file in Obsidian, not only notes. PDFs, images, slides and data files can carry tags, and one search finds notes and files together.

Wikiwurzel is the root of the Wiki family: Wikibaum (theme, the tree), Wikiblatt (sidebar, the leaves) and Wikiwurzel (tags and search underneath). It works on its own; with Wikiblatt installed, Wikiblatt's sidebar shows a tag card for the file being viewed.

## How tags are stored

Each folder may hold a hidden `.tag` file in YAML:

```yaml
folder: [Chemistry, CM2112]        # applies to every file in this folder and below
files:
  "Lab manual.pdf": [lab, manual]  # applies to that file only
```

Obsidian does not index dot files, so these never appear as notes. A file's tags are its own, plus the folder tags of every folder above it, plus (for notes) the `#tags` written in the note. Tags that differ only in letter case count as one, as in Obsidian.

Renaming, moving or deleting a file or folder inside Obsidian keeps the tags in step. Files moved outside Obsidian lose their own tags; folder tags travel with the folder.

## Use

- **Edit tags**: right-click a file or folder in the file explorer and choose "Edit tags", or run "Edit tags of the current file".
- **Search**: the tag ribbon icon or "Search files by tag". `#Chemistry #CM2112` finds files with both tags, `-#Lab` leaves a tag out, and plain words match file paths. Typing `#` suggests tags. Nested tags match too: `#Chemistry` finds `Chemistry/organic`.
- **Tag graph**: "Open tag graph" adds a panel to the right sidebar. It follows the file being viewed: the file in the middle, its tags around it, and for each tag the files that share the most tags with it (notes as grey dots, other files as yellow dots, tags as green squares; linked notes joined by dashed lines). Click a tag to put it in the middle, Ctrl/Cmd-click it to search for it, click a file to open it; scroll to zoom, drag to pan. Settings: files per tag, upper limit, linked notes on or off, and tags to hide (for example very broad ones).
- **Reload tag files** re-reads every `.tag` file after editing them outside Obsidian.

## For other plugins

Wikiwurzel hands out a small API through workspace events (`wikiwurzel:request`, `wikiwurzel:ready`, `wikiwurzel:changed`, `wikiwurzel:unload`). See `src/api.ts`.

## Build

```
npm install
npm run build
```

## 한국어 안내

노트뿐 아니라 PDF·이미지·슬라이드 등 모든 파일에 태그를 붙이고, 노트와 파일을 한 번에 태그로 찾습니다. 태그는 폴더마다 숨김 파일 `.tag`에 저장되고, 폴더 태그는 하위 파일 전체에 적용됩니다. 파일 탐색기에서 오른쪽 클릭 → "태그 편집", 리본의 태그 아이콘 → 태그 검색(`#Chemistry -#Lab 보고서`).

## License

MIT
