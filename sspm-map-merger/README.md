# SSPM Map Merger

Static, browser-only tool that merges up to 50 SSPM v2 maps into one playable `.sspm`.
Open `index.html` (or host the folder anywhere, e.g. GitHub Pages at `/sspm-map-merger/`).

- `sspm.js` – SSPM v2 reader/writer + merge logic (UMD, no DOM; testable in Node)
- `app.js`, `style.css`, `index.html` – UI
- `vendor/lame.min.js` – lamejs MP3 encoder (LGPL, see `vendor/LAMEJS-LICENSE.txt`)

Audio from each map is decoded (Web Audio), joined with an optional gap and re-encoded as one MP3.
Notes are offset to each song's start, shifted +25 ms to cancel LAME's encoder delay, and sorted.
