# Plume

Handwritten note-taking, synced with OneDrive. Each notebook is a PDF stored
in the `Plume` folder of OneDrive, readable anywhere, and stays editable
stroke by stroke in the application.

Installable web application (PWA): Android tablet with a stylus, and any
recent browser on a computer.

**Setup (no programming needed): see [docs/GUIDE.md](docs/GUIDE.md).**

## What version 1 does

- Library of folders and notebooks, mirrored exactly in OneDrive (create,
  rename, move, delete, in both directions).
- A4 pages, portrait or landscape, with blank, lined, grid, dotted and Seyès
  backgrounds.
- Pressure-sensitive pen, pencil with a graphite grain, highlighter (under
  the ink), eraser (whole stroke or precise), straight line, undo / redo.
- Scribble to erase: scribbling over existing ink with the pen deletes it
  (can be switched off in the pen settings).
- Clean shapes: hold the pen still at the end of a stroke and it becomes a
  straight line, rectangle, square, triangle, circle, ellipse or smooth curve
  (can be switched off in the pen settings). While still holding, move the pen
  to enlarge or shrink a closed shape.
- Selection: circle strokes freehand with the lasso, then move, resize,
  recolour, duplicate, copy, cut, paste or delete them.
- Pictures: insert an image on the page, then move, resize, duplicate or
  delete it like any selection; ink and highlighter go over it.
- Page management: add, duplicate, move, delete, change the background.
- Palm rejection; scroll and zoom with fingers; mouse on a computer.
- Every stroke saved locally at once; works offline.
- Automatic PDF export to OneDrive, with a status indicator.
- When a notebook is modified in two places, both versions are kept.

Planned for version 2: PDF import, page thumbnails, favourite pens.

## Development

```
npm install
npm run dev        # application locally on http://localhost:5173
npm test           # automated tests (PDF export, sync, sign-in)
npm run test:e2e   # application driven in Chromium against a fake OneDrive
npm run build      # production build in dist/
```

`npm run test:e2e` needs Chromium: `npx playwright install chromium`.

## Code layout

| Folder | Role |
| --- | --- |
| `src/model.ts`, `src/db.ts` | Types and local storage (IndexedDB) |
| `src/geometry.ts`, `src/backgrounds.ts` | Stroke shapes and backgrounds, shared by screen and PDF |
| `src/shapes.ts` | Shape recognition (line, rectangle, ellipse, curve…) |
| `src/pdf/` | Building and reading PDFs (in a worker) |
| `src/sync/` | Microsoft sign-in, OneDrive client, sync engine |
| `src/ui/` | Library, writing screen, drawing engine |
| `tests/` | Tests, including an in-memory fake OneDrive |

The editable data travels inside the PDF itself (`PieceInfo` dictionaries, the
mechanism the PDF format provides for an application's private data): a single
file per notebook, which can be moved or renamed freely.

To measure rendering times: `localStorage['plume.debug'] = '1'`, then the
browser's Performance tab (`plume-scene` and `plume-live` measures).
