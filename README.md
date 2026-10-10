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
  rotate, recolour, duplicate, copy, cut, paste or delete them.
- Import: a PDF becomes a notebook whose pages you write on (the original
  text stays selectable in the exported PDF); a picture becomes a one-page
  notebook. PDFs dropped into the OneDrive folder open the same way.
- Pictures: insert an image on the page, then move, resize, rotate, crop,
  duplicate or delete it like any selection; ink and highlighter go over it.
- Axes for graphs: graduated axes with an optional grid, inserted as strokes.
- Writing toolbar of its own, docked at the top, bottom, left or right of the
  page (drag its handle). Each tool keeps three colours and three widths at
  hand (three sizes for the eraser): one tap selects, a tap on the selected
  one changes it. They follow on every device, with the folder colours.
- Light and dark appearance, with optional dark pages while writing.
- New notebook dialog: name, optional cover page (ten templates, eight
  colours, subtitle), page background and orientation.
- Page management: add (same format as the page before, or another
  background and orientation), duplicate, move, delete, change the format.
- Page previews: a panel on the left shows a thumbnail of every page; tap one
  to go there, drag its handle to reorder, or open its menu to add, duplicate,
  delete or bookmark the page. Bookmarks are listed at the top of the panel
  and written as real PDF bookmarks.
- Library: search by name, favourites, recently opened notebooks. Folders
  have a colour and a symbol, as in OneDrive (yellow by default); notebooks
  have a logo with a colour and a symbol (Plume violet by default), and
  notebooks made from a PDF have a logo of their own. These choices are kept
  in `plume-library.json` in the `Plume` folder, so every device shows them.
- Palm rejection; scroll and zoom with fingers; mouse on a computer.
- Every stroke saved locally at once; works offline.
- Automatic PDF export to OneDrive, with a status indicator.
- When a notebook is modified in two places, both versions are kept.

Planned next: favourite pens, typed text boxes.

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
| `src/covers.ts`, `src/axes.ts` | Cover page templates; graduated axes |
| `src/looks.ts` | Folder and notebook icons, their colours and symbols |
| `src/presets.ts` | Colours and widths kept at hand in the writing toolbar |
| `src/shapes.ts` | Shape recognition (line, rectangle, ellipse, curve…) |
| `src/pdf/` | Building and reading PDFs (in a worker) |
| `src/ui/pdfview.ts` | Display of imported PDF pages (PDF.js) |
| `src/sync/` | Microsoft sign-in, OneDrive client, sync engine |
| `src/ui/` | Library, writing screen, drawing engine |
| `tests/` | Tests, including an in-memory fake OneDrive |

The editable data travels inside the PDF itself (`PieceInfo` dictionaries, the
mechanism the PDF format provides for an application's private data): a single
file per notebook, which can be moved or renamed freely.

To measure rendering times: `localStorage['plume.debug'] = '1'`, then the
browser's Performance tab (`plume-scene` and `plume-live` measures).
