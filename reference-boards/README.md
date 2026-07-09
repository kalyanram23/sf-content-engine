# Dhaba reference boards

Canonical menu-board reference for the Dhaba theme, extracted from the design
canvas so it can be referenced directly from Claude Code.

## Files

- **`3a-departures-rice-boards.dc.html`** — DEPARTURES board · 1920×1080 landscape.
  Station-timetable style: amber mono (`#ffb000`) on near-black (`#0c0d10`),
  `Space Mono` throughout, a Biryani/Pulav price matrix + Mandi list, photo
  captions underneath. *(Alternate/dark board — not the Dhaba theme.)*
- **`3b-dhaba-poster-street-sweets.dc.html`** — DHABA POSTER board · 1080×1920
  portrait. The canonical Dhaba theme: truck-art stripe frame, cream paper,
  chilli-red `Shrikhand` display type, teal numbered section chips, dotted price
  leaders, polaroid photo cards with captions underneath.
- **`dhaba-theme.dc.html`** — the Dhaba theme spec + live specimens (palette,
  type, frame, section headers, price rows, polaroid card, do/don't).
- **`../themes/dhaba.theme.json`** — machine-readable theme tokens, components,
  layouts and motion used by the content engine.

## Dhaba theme cheat-sheet

- **Colors** — Paper `#F8ECD4` · Ink `#2A1A0E` · Chilli `#C22415` ·
  Turmeric `#F2B53A` (frame stripe only) · Teal `#0F7C68` · Polaroid white `#FFFFFF`.
- **Fonts** — `Shrikhand` (display only) + `Archivo` 500–800. No other families.
- **Frame** — `repeating-linear-gradient(45deg,#C22415 0 16px,#F2B53A 16px 32px)`,
  16px reveal on every board edge.
- **Sections** — teal numbered chip + Shrikhand chilli title + 2px ink rule.
- **Rows** — Archivo 600 name → 2px dotted `rgba(42,26,14,0.35)` leader →
  Chilli 800 tabular-nums price. MP = bordered chilli chip; sold out = 55%
  opacity + red strike + rotated `KHATAM!` stamp.
- **Photos** — white polaroid cards, caption underneath naming a real menu item,
  alternating −2° / +1.5° / −1° tilt.

## Dependencies

`support.js` (DC runtime) and `image-slot.js` (logo/photo drop slots) are copied
in alongside the boards so each `.dc.html` opens standalone in a browser. The
photo `<img src>`s point at hosted URLs.
