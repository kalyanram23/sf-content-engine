import type OpenAI from "openai";

import type { ReasoningSetting } from "../../config/models";
import { PaintError } from "../../domain/errors";
import type { BrandInput, CanonicalItem, ResolvedTheme } from "../../domain/types";
import {
  describeLayoutStrategy,
  renderBlueprintStrategy,
  renderMatrixSummary,
} from "../../planning/layout-strategy";
import type { Painter, PaintRequest } from "../../ports/painter";
import type { Logger, UsageSink } from "../../ports/services";
import { ICON_GLYPH_NAMES } from "../../theme/icon-glyphs";
import { serializeFindingsForPrompt } from "../../qa/finding";
import { buildUsageReporter, requestText, resilienceFields, type RoleResilience } from "./client";
import { buildBroadcast } from "./correlation";

/** Reminder that each serialized finding's ref is a resolvable anchor — steer the model to patch
 * those exact elements instead of rebuilding the board. Shared by the re-paint block and repairer. */
export const REF_INSTRUCTION =
  'Each ref above is a CSS selector (e.g. [data-item-id="..."] [data-bind="price"]) or a data-ref value resolvable in the provided HTML — fix those exact elements; do not rebuild unrelated parts.';

// Layout strategy is core logic shared with the vision critic; re-exported so existing
// consumers/tests importing it from the painter keep working.
export { describeLayoutStrategy, isMatrixBoard } from "../../planning/layout-strategy";

/** The painter's role line. Canvas size is deliberately not hardcoded here (9:16 boards exist);
 * the exact pixels arrive in the user prompt as "Target canvas". */
const PAINTER_ROLE = `You are an expert digital-signage screen designer creating ONE self-contained screen for a TV that guests read across a room. The screen is a FIXED, non-scrolling POSTER canvas — not a web page: no scrolling, no fold, no responsive reflow; you compose one exact-pixel frame (the canvas size is given under "Target canvas" below).`;

/**
 * Fallback visual identity when a theme declares none of its own. A theme's identity
 * (creative direction + decoration voice) lives in its externalized file (`themes/<id>.theme.json`).
 */
const DEFAULT_IDENTITY = `Visual identity: clean, modern, appetising — design intentionally around the provided theme tokens, not as a generic template.`;

/**
 * Engine-invariant DESIGN GOALS, shared by every theme. This is the boilerplate that used to be
 * copy-pasted into each theme's prompt; keeping it here means a theme file only authors what makes
 * it unique (identity + decoration), and these goals stay consistent as the engine evolves.
 */
const ENGINE_DESIGN_GOALS = `DESIGN GOALS (always apply, in addition to the theme identity above):
- FILL THE SCREEN: structure the root as a full-height column (min-h-screen flex flex-col) whose content area is flex-1; never leave the bottom half or any large band empty. Fill that height with LARGE TYPE, generously sized content-hugging cards, spacing BETWEEN sections, and the section's image slot — rows and cells are sized to their content, never 1fr-stretched or flex-grown to reach the bottom edge. The layout reads as full because the content is BIG (with even, modest margins), never because gaps were inflated (see VERTICAL RHYTHM below).
- HIERARCHY: strong title-led hierarchy — the screen title dominates (confident, not oversized); section headers are clearly distinct from item names (larger and/or accent-coloured, with a divider); item names are large and high-contrast. Long multi-word dish names wrap to two or three lines rather than shrink or truncate.
- Make the screen appetising and instantly scannable, intentionally designed for THIS theme rather than a generic grid — a guest should glance and immediately want to order.`;

/**
 * The tail FINAL SELF-CHECK bullet of the engine contract. On a FIRST paint the model composes
 * from scratch, so it re-audits the whole board against the contract. On a RE-PAINT (C1) that
 * whole-board re-audit contradicts the minimal-change instruction (REF_INSTRUCTION + the re-paint
 * tail), so the line is swapped for a scoped one — fix EACH listed finding, introduce no new
 * violation, don't restyle what the findings don't name. Both keep the D34 item-preservation
 * safeguard. Kept at the contract TAIL so the whole prompt PREFIX is byte-identical between a
 * board's paint and re-paints (OpenRouter prompt-cache prefix, ARCHITECTURE.md:537-539).
 */
const FINAL_SELF_CHECK_PAINT = `- FINAL SELF-CHECK: before returning, silently re-check your HTML against this contract and the board's planned sections, and fix any violation in place — but NEVER drop, summarise, or shorten a planned item to make things fit; reclaim wasted space and stay within the type-size minimums instead.`;

const FINAL_SELF_CHECK_REPAINT = `- FINAL SELF-CHECK (re-paint): confirm your edit resolves EACH listed finding and introduces NO new contract violation; do NOT re-audit or restyle parts the findings do not name. As always, NEVER drop, summarise, or shorten a planned item to make an edit fit — reclaim wasted space and stay within the type-size minimums instead.`;

/**
 * The NON-NEGOTIABLE technical contract appended to EVERY theme's base prompt. These are engine
 * mechanics — bindings, offline-safety, the photo-placeholder scheme, motion vocab, contrast
 * tokens, the carousel structure — the painter must always honour so QA/packaging succeed
 * regardless of theme. Themes own the creative prompt; the engine owns these rails. `isRepaint`
 * swaps only the tail FINAL SELF-CHECK bullet (see above); everything before it is invariant.
 */
function engineContract(isRepaint: boolean): string {
  const finalSelfCheck = isRepaint ? FINAL_SELF_CHECK_REPAINT : FINAL_SELF_CHECK_PAINT;
  return `NON-NEGOTIABLE TECHNICAL CONTRACT (always applies, in addition to the theme direction above):
- Use Tailwind utility classes only; colours/spacing/radius MUST come from the theme tokens (e.g. text-text, bg-surface, text-price). NEVER use raw hex or px arbitrary values (no text-[#fff], no p-[7px], never hardcode the canvas size in a class). For full-bleed sizing use w-full / h-full / min-h-screen and flex/grid. EXCEPTION: box-shadow has no token utility — a hard offset shadow may use a rem-based arbitrary value with a theme var (e.g. shadow-[0.5rem_0.5rem_0_var(--color-text)]), still never px or hex inside the brackets.
- Every menu item element MUST have data-item-id="<id>" and data-available, and every dynamic price MUST be in a <span data-bind="price">.
- Use motion ONLY via data-motion="<name>" from the provided motion vocabulary. No hand-rolled requestAnimationFrame.
- Fully self-contained: no external URLs, no <script> navigation (no location/history/window.open/meta refresh).
- NO WINDOW CHROME: this is a TV sign, not an app window — NEVER render a close button or "X" close glyph, window/title-bar controls, a scrollbar, a cursor, or any UI-chrome glyph; signage has no controls to click.
- MASTHEAD — exactly one slim masthead band at the very top: the board title (the plan's \`title\`) on the LEFT; the brand (logo + name) on the RIGHT when brand content is provided. Content-hugging height (≤ roughly 6% of the canvas — the TYPE SCALE budget below already reserves this band, so do NOT add extra height for it), identical treatment on every screen of a set. No other copy lives in the masthead. If no brand is provided, render the title only — NEVER invent a restaurant name, logo, or tagline.
- COPY WHITELIST — every string on the screen must trace to the menu data (item/category names, descriptions, prices, variants), the plan (board title, section titles), the provided brand block, or a legend for a marker actually used. Do NOT invent badge chips or labels ('PRICE LIST', 'USD', 'MADE TO ORDER', 'DINE IN · TAKEOUT', 'FRESH · HOT · DAILY', 'EST. …'), operational claims, taglines, or restaurant names. The theme's name must never appear as on-screen copy.
- PHOTOS: render an item's photo as an <img> with NO src attribute. Instead carry data-img-item="<itemId>" data-img-index="0" and a unique data-ref="<something>"; the engine inlines the real image (as a data-URI) at package time. NEVER put a URL in src. Only reference photos for item ids listed as having a photo.
- PHOTO TRUTH (per-item cards): an item WITHOUT a photo gets a TEXT-ONLY treatment — NEVER an image-shaped region, placeholder box, icon, or hand-drawn graphic (e.g. an SVG star) standing in where its photo would go. A section mixing photo and no-photo items composes real photo cards and deliberately compact text cards side by side; the text cards are honestly smaller, not padded out to fake a missing image. This governs per-ITEM cards ONLY — a whole-CATEGORY image slot is separate (see IMAGE SLOT ANCHORING): a category whose items carry no photos legitimately shows a deliberate themed food-icon panel.
- TEXT OVER PHOTOS: NEVER place text (names, prices, descriptions, labels, badges) directly on top of a photo — photos are busy/mid-toned and text over them fails the 4.5:1 contrast gate. Put text on a SOLID theme surface beside/below the photo; if a caption must overlay a photo, give it its own solid or strong-gradient scrim panel. The price must always be on a solid surface.
- TEXT COLOUR CONTRAST (every text element must clear 4.5:1): primary text is text-text; secondary/description text is text-muted; prices are text-price. For ANY accent-coloured text (tags, labels, small headings, "POPULAR"/"CHEF'S SPECIAL" pills) use text-accent-strong, NEVER text-accent (text-accent is a dim decoration/border colour that fails as text). Badge pills must use a solid bg with high-contrast text. Text must contrast with the surface it sits ON: on a dark surface never use black, near-black, or any dark text colour; on a light surface never use white, near-white, or any pale text colour. The theme's text/muted/price/accent-strong tokens are tuned to pass 4.5:1 on the theme's own surfaces — stay on them.
- CAROUSEL (gallery-fade): the one way to cross-fade photos — used both for a plan imageSlot and for any section photo hero. Build a relative, overflow-hidden container carrying data-motion="gallery-fade" and data-motion-params from that preset's params in the motion vocabulary above (format "interval:<ms>;fade:<ms>"). Inside it stack 2 or more <img> (each absolutely positioned, class "absolute inset-0 w-full h-full object-cover"), the FIRST with opacity-100 and the REST with opacity-0, all using the data-img-item/data-img-index/data-ref scheme above. Build a carousel only where the plan calls for it: an imageSlot, or a hero the LAYOUT STRATEGY asks for.
- IMAGE SLOT / PHOTO HERO ANCHORING: every image slot and photo hero MUST read as PART OF a specific menu section — never a free-floating image that belongs to no category. Put it INSIDE that section, or flush against it sharing the section's frame/header treatment, and CAPTION it with that section's category name (e.g. a "MANDI — from our kitchen" label bar on a solid scrim beside or above the photo) so a guest instantly reads which category it is selling. Every image-slot CONTAINER — a per-category photo panel/carousel, a per-category food-icon panel, or the ONE board-level shared slot — MUST carry a data-image-slot attribute: data-image-slot="<category name>" for a per-category slot, data-image-slot="shared" for the board-level shared slot. NEVER float a lone decorative hero in empty canvas with no section tie. Slot PLACEMENT — whether the photo sits BESIDE or ABOVE its category title, and where the category-description subtitle sits — follows the PER-REQUEST orientation rules (portrait vs. landscape category heroes) in the board details below.
- SECTIONS: the screen has one or more sections, each with a title, a representation, an item list, and an optional layoutHint. Render EVERY section — show its title as a clear header and include EVERY planned item with its data-item-id; never drop, summarise, or "..." items to save space. How items, photos and heroes are arranged for THIS board is set by the LAYOUT STRATEGY in the board details below; build any rotating photo hero as the CAROUSEL above, and a hero must be a clearly-visible block (a real fraction of its area, never a tiny corner thumbnail/icon/chip).
- ITEM ROWS (name + price): keep each item's name and its price together as one tight unit — the price sits immediately after the name (small gap), or fill the gap between them with a dotted leader. NEVER push the price to the far edge with ml-auto / justify-between leaving a wide hollow gap, and do NOT spread rows vertically with justify-between; pack rows top-aligned with a consistent small gap. Give every price span the tabular-nums class so digits align down a column.
- CARD & ROW DISCIPLINE (every density register): every card HUGS its actual content — NEVER a tall box with an empty interior reserving space for a description or photo that isn't there; match each card's height to what it really holds. Within a row, a name and its price must read as ONE connected unit (dotted leader, hairline rule, or direct adjacency) — never a bare justify-between gap stretching a chasm across a wide card or column. Apply that connection UNIFORMLY down one list — every row gets the SAME name↔price treatment, INCLUDING rows whose name WRAPS to two lines (the leader aligns on the last line); never let a wrapped-name row drop its leader while single-line neighbours keep theirs.
- CARD INTERIOR (vertical stacking inside a card): inside a card, the name, description and price stack as ONE TIGHT CLUSTER — the price sits directly under or beside the description, NEVER pushed to the card's far bottom/edge by justify-between, flex-grow, or a spacer. A TALL card absorbs its extra height OUTSIDE that cluster — in the photo/icon zone, or as padding AROUND the whole block — NEVER as a void BETWEEN the text elements. No awkward empty vertical gap between a card's description and the price beneath it, and never a name pinned top-left with its price marooned bottom-right on opposite card edges.
- VERTICAL RHYTHM: the vertical gap between consecutive item rows never exceeds ~1.5× the row's own text height, and grid/matrix cells never stretch taller than their content needs — a name and price floating in a tall empty cell is a defect. Absorb any surplus vertical space with LARGER TYPE, more spacing BETWEEN sections, or the section's image slot — NEVER by inflating the gaps inside a section, its rows, cards, or cells (no flex-grow / justify-between / 1fr stretching of an item list to fill height).
- COLUMN BALANCE: when a section flows into multiple columns, BALANCE the rows so sibling columns end within about one row of each other — NEVER let one column run long and CLIP its last items at the screen edge while a sibling column sits on empty space below its last row. Content clipped inside an overflow-hidden container is invisible to a guest and is a hard failure. If the rows don't all fit, drop the whole section's type one rung or redistribute rows across the columns until every column ends fully on-screen — never clip, never truncate, never let a column overrun the bottom edge.
- MARKER LEGENDS: never attach a marker glyph (asterisk, star, dagger) to an item name without a small on-board LEGEND explaining it — and never invent a marker the menu data doesn't imply. No unexplained * or ★ floating beside a dish.
- IMAGE SIZING: an item photo must fill a generous, well-proportioned area (e.g. aspect-video / aspect-square / aspect-[4/3] / aspect-[3/2]) with object-cover so it never distorts — photo on top of the card, or a large square beside the text. NEVER cram a photo into a thin fixed-width full-height vertical strip (e.g. a w-16/w-20 column that stretches to row height) or a short full-width sliver; both squeeze the image to the wrong aspect ratio.
- TYPE SIZE (read across a room, ~10-20 ft): use large type. Item names and prices are at LEAST text-lg (text-xl+ when space allows), section/category headers clearly larger still; never render item text below text-base. Prefer fewer, larger rows that fill the available height over many tiny rows separated by empty space; reclaim wasted space (kill large empty gaps and oversized margins) BEFORE shrinking text, and never shrink below these minimums.
- Everything must fit INSIDE the target canvas given below (Target canvas) — never overflow or require scrolling.
- DECORATION (optional, only when the theme direction asks for it): you MAY enrich the screen with your own inline decorative SVG/CSS — an ambient backdrop and/or small accents. It MUST be inline (no external URLs, no src) and self-contained. Colour it with theme tokens ONLY: fill="var(--color-accent)" / stroke="var(--color-accent)" (any token name), or fill="currentColor" with a token text class — NEVER a raw hex or rgb() in fill/stroke/style. Decoration is secondary: place it BEHIND the content (e.g. low opacity, negative or low z-index, or in the margins) so it never lowers text contrast — names, prices and descriptions stay on solid theme surfaces. Mark purely decorative SVG aria-hidden="true", and never let it overflow the target canvas or push content out of frame.
${finalSelfCheck}
- Return ONLY the HTML for the screen body (a single root element). No markdown fences.`;
}

/**
 * Render the theme's gold exemplar board (D66) as a high-attention STRUCTURE reference block, placed
 * immediately after the identity/DO/DON'T block so the painter reads "this is what great looks like"
 * before the generic engine goals. The guard is load-bearing: the exemplar teaches LAYOUT + CRAFT
 * (frame, masthead, section/row anatomy, photo strip, full-height balance), never its placeholder
 * copy — real item/section names and prices come EXCLUSIVELY from the plan — and its proportions are
 * adapted when the target aspect differs from the exemplar's own. `undefined` when the theme carries
 * no exemplar, so the prompt is byte-identical to before for every other theme (no drift).
 */
function exemplarBlock(design: ResolvedTheme["design"]): string | undefined {
  const exemplar = design?.exemplar;
  if (exemplar === undefined) return undefined;
  const noteLine = exemplar.note !== undefined ? `\n(${exemplar.note})` : "";
  return (
    `EXEMPLAR — a finished board in this theme (structure reference, aspect ${exemplar.aspect}):${noteLine}\n` +
    "This shows the theme's STRUCTURE and CRAFT — the frame, the masthead band, section anatomy " +
    "(numbered chip + title + rule), row anatomy (name → leader → price), the photo strip, and the " +
    "full-height balance that leaves no dead bands. TAKE these layout and craft moves. Colours here " +
    "are theme tokens as var(--color-*) and sizes are rem — match the token ROLES (you may equally " +
    "use the theme's Tailwind token classes such as text-accent / bg-surface); it is the STRUCTURE " +
    "that matters. NEVER copy its placeholder item names, prices, or section names — those are dummy " +
    "text; real content comes exclusively from the planned items and section titles below. If the " +
    "target canvas aspect differs from this exemplar's, adapt the proportions (column count, hero " +
    "size, row counts) to the target while keeping every signature move. The exemplar's absolute " +
    "rem sizes suit a DENSE board (~45 rows); they are a floor, not a template — when your board " +
    "carries fewer rows, scale row type, section titles, and photo cards UP proportionally " +
    "(e.g. ~30 rows → roughly 1.5× the exemplar's row type and photo sizes) until the canvas is " +
    "full. Copying the exemplar's sizes onto a sparse board leaves dead cream bands, which fail QA.\n\n" +
    exemplar.html
  );
}

/**
 * Compose the painter system prompt: role + the theme's identity (+ its DO/DON'T lists) +
 * the theme's gold exemplar (D66, when present) + the shared engine design goals + the engine
 * contract. Themes own the look/voice; the engine owns the rails. Structured `design` wins over the
 * legacy `prompt` blob. `isRepaint` only swaps the contract's tail FINAL SELF-CHECK bullet (C1) — the
 * prompt prefix (including the exemplar) is invariant, preserving the OpenRouter prompt-cache prefix.
 */
export function buildSystem(theme: ResolvedTheme, isRepaint = false): string {
  const design = theme.design;
  const identity =
    design?.identity.trim() ??
    (theme.prompt && theme.prompt.trim() !== "" ? theme.prompt.trim() : DEFAULT_IDENTITY);
  const doList =
    design !== undefined && design.do.length > 0
      ? `DO (this theme):\n${design.do.map((d) => `- ${d}`).join("\n")}`
      : undefined;
  const dontList =
    design !== undefined && design.dont.length > 0
      ? `DON'T (this theme):\n${design.dont.map((d) => `- ${d}`).join("\n")}`
      : undefined;
  return [
    PAINTER_ROLE,
    identity,
    doList,
    dontList,
    exemplarBlock(design),
    ENGINE_DESIGN_GOALS,
    engineContract(isRepaint),
  ]
    .filter((s): s is string => s !== undefined)
    .join("\n\n");
}

/**
 * Conventional colour-token roles, so the painter reasons about token RELATIONSHIPS ("accent is
 * decoration, accent-strong is accent text") instead of guessing from a bare name list. Themes
 * using other token names simply get the name without a role annotation.
 */
const TOKEN_ROLES: Record<string, string> = {
  bg: "page background",
  surface: "card/panel background",
  "surface-strong": "stronger panel — header bands, emphasized cards, badge/pill fills",
  text: "primary text (item names, titles)",
  muted: "secondary text (descriptions, meta)",
  accent: "decoration ONLY — borders, dividers, backdrop art; never text",
  "accent-strong": "accent-coloured TEXT (tags, labels, small headings) and pill fills",
  price: "price text",
  sold: "marking sold-out / unavailable items only",
};

/** Render each colour token with its role, e.g. `accent (decoration ONLY — …)`. */
function describeTokenRoles(colors: Record<string, string>): string {
  return Object.keys(colors)
    .map((name) => {
      const role = TOKEN_ROLES[name];
      return role ? `${name} — ${role}` : name;
    })
    .join("; ");
}

/**
 * Render the theme's component recipes for the painter: role + each bound slot mapped to its
 * Tailwind token class (e.g. `bg→bg-surface-strong`) + the scarcity rule. Binds are already
 * validated to resolve at load, so this is a plain lookup.
 */
function describeComponents(
  components: readonly { role: string; binds: Record<string, string>; rule: string }[],
): string {
  const lines = components.map((c) => {
    const binds = Object.entries(c.binds)
      .map(([slot, token]) => `${slot}→${token}`)
      .join(", ");
    return `- ${c.role}${binds ? ` (${binds})` : ""}: ${c.rule}`;
  });
  return `Component recipes — reuse these consistently across the board:\n${lines.join("\n")}`;
}

/** The brand instruction block appended to the painter's user prompt when a run has brand content.
 * The brand lives on the RIGHT side of the masthead band (the board title stays on the left — see
 * the MASTHEAD contract). Uses the item-photo placeholder scheme so the large data-URI never passes
 * through the model (an LLM can't reproduce a long base64 blob reliably). */
export function brandUserLines(brand: BrandInput): string[] {
  const lines: string[] = [
    "BRAND — this run has brand content; render it on the RIGHT side of the masthead band (board title stays on the left):",
  ];
  if (brand.logo !== undefined) {
    lines.push(
      "- Place the logo as <img data-brand-logo> with NO src attribute — the engine inlines the real image at package time. NEVER put a URL in src.",
    );
    lines.push(
      "- Size the logo as a real masthead element (not a tiny thumbnail, not overpowering the menu), on a theme surface that suits it (transparent logos need an appropriate backing).",
    );
    if (brand.logo.alt !== undefined)
      lines.push(`- Logo alt text: ${JSON.stringify(brand.logo.alt)}`);
  }
  if (brand.name !== undefined)
    lines.push(`- Brand name (render as text in the masthead): ${JSON.stringify(brand.name)}`);
  if (brand.tagline !== undefined)
    lines.push(`- Tagline (smaller text near the name): ${JSON.stringify(brand.tagline)}`);
  return lines;
}

/**
 * The explicit matrix directive lines (§ Phase 2): the computed pairing summary, and — when the
 * selected blueprint ships a skeleton — the FIXED DOM shape to fill. Replaces reliance on the prose
 * layoutHint for pairing 34 items by name. Empty when the board has no matrix section.
 */
function matrixDirectiveLines(request: PaintRequest): string[] {
  const summary = renderMatrixSummary(request.planScreen, request.items);
  if (summary === undefined) return [];
  const lines = [summary];
  const skeleton = request.blueprint?.skeleton;
  if (skeleton !== undefined) {
    lines.push(
      "MATRIX DOM SKELETON — the element/attribute SHAPE below is FIXED: keep every data-* attribute " +
        "(data-matrix, data-matrix-row, data-matrix-cell, data-item-id, data-available, data-bind) " +
        "exactly as shown. Styling is yours (add Tailwind theme-token classes, sizing, colour). Emit " +
        "ONE data-matrix-row per MATRIX DATA row above, one data-matrix-cell per column, the item's real " +
        "price in its <span data-bind=\"price\">, and an em-dash with NO price span for a '—' cell:\n" +
        skeleton,
    );
  }
  return lines;
}

/**
 * The DENSITY IDIOM directive (D30) for a `dense`/`packed` board. A board carrying far more than the
 * comfortable per-canvas budget cannot be a boutique hero layout — it must switch to a compact,
 * information-dense price-list register (a diner/dhaba menu wall), or it either overflows or ships a
 * cramped version of the wrong idiom. Theme-AGNOSTIC: it constrains STRUCTURE + register only —
 * colours/type tokens still come from the theme. `comfortable` (or an absent tier) returns [] so the
 * board keeps its normal blueprint. Complements the TYPE SCALE directive (which fixes exact sizes).
 */
function densityDirectiveLines(request: PaintRequest): string[] {
  const tier = request.densityTier;
  if (tier === undefined || tier === "comfortable") return [];
  if (tier === "packed") {
    return [
      "DENSITY — PACKED BOARD (maximum-density register): this board is intentionally packed far " +
        "beyond a comfortable count. Design it as a DENSE MENU WALL / price list that prioritises " +
        "complete, scannable COVERAGE over decoration — think a diner/dhaba price board, NOT a " +
        "boutique hero layout:\n" +
        "- NO hero sections and NO decorative whitespace bands — every band earns its place; fill " +
        "the canvas edge-to-edge.\n" +
        "- DROP item descriptions entirely — show item name + price only.\n" +
        "- NO per-item photos. The ONLY imagery is the plan's ONE shared slot (its container carries " +
        'data-image-slot="shared") when the plan calls for one — keep it a COMPACT band (target ≤ ' +
        "roughly 15–20% of the canvas) so item coverage keeps priority; no shared slot → no imagery.\n" +
        "- Category/section HEADERS are the primary visual structure: clear, repeated, colour-blocked " +
        "headers a guest scans by, with tightly-grouped rows beneath each.\n" +
        "- Flow the name+price rows in as many balanced COLUMNS as the canvas cleanly allows (per the " +
        "TYPE SCALE directive), prices aligned down each column with tabular-nums, dotted leaders " +
        "optional. Use the directive's sizes (never below the engine floor) and never overflow.",
    ];
  }
  return [
    "DENSITY — DENSE BOARD (compact register): this board carries more items than a boutique layout " +
      "can breathe around. Design it as a COMPACT, information-dense menu wall (a well-organised " +
      "diner/dhaba board), NOT a sparse hero layout:\n" +
      "- NO large hero sections and NO big decorative whitespace bands — reclaim that space for items.\n" +
      "- Category/section HEADERS carry the visual structure: clear, repeated, distinct headers with " +
      "tightly-grouped rows beneath each.\n" +
      "- Lay the name+price rows in a MULTI-COLUMN price-list register (2–3 columns as the canvas " +
      "allows, per the TYPE SCALE directive), name + price kept tight per row (dotted leaders welcome), " +
      "prices aligned with tabular-nums.\n" +
      "- Descriptions: keep at most a SHORT one-line note where it earns its place; TRUNCATE longer " +
      "ones — never let a description force a row to wrap three lines.\n" +
      '- Photos: the plan\'s ONE shared slot (its container carries data-image-slot="shared") as a ' +
      "COMPACT band (target ≤ roughly 15–20% of the canvas), or at most SMALL thumbnails for a few " +
      "signature items — never a full-bleed per-item hero. Coverage + scannability come before a " +
      "photo showcase.",
  ];
}

/**
 * The SPACE & SCALE directive (D33) for a `comfortable` board — the mirror of the D30 dense idiom.
 * A board carrying few enough items to breathe has the OPPOSITE failure mode of a dense one: dead
 * zones. Screen real estate is valuable, so a sparse board must scale content UP and pack it
 * intentionally to fill the canvas, not float a small cluster in a void. Theme-AGNOSTIC: it
 * constrains COMPOSITION + register only (colours/type tokens still come from the theme, exact sizes
 * from the TYPE SCALE directive). Only `comfortable` boards get it (`dense`/`packed`/absent → [] so
 * the density idiom or the generic minimums own those boards). Complements the IMAGE SLOT contract.
 */
function sparseDirectiveLines(request: PaintRequest): string[] {
  if (request.densityTier !== "comfortable") return [];
  return [
    "SPACE & SCALE — COMFORTABLE BOARD (this board has few enough items to breathe; use that room " +
      "DELIBERATELY — screen real estate is valuable and DEAD ZONES are the failure mode here, NOT " +
      "crowding):\n" +
      "- SCALE CONTENT TO THE CANVAS: with few items go LARGE — big type, big cards, generous internal " +
      "padding — so the content FILLS the frame edge-to-edge. Never centre a small cluster of content " +
      "in a sea of empty canvas.\n" +
      "- NO EMPTY HERO ZONES: never reserve a tall band of empty space above an item's name inside its " +
      "card (the classic ~300px void with one floating motif, content crammed into the bottom half). " +
      "Decorative motifs may sit BEHIND or BESIDE content, but must never occupy a content row.\n" +
      "- CARDS HUG THEIR CONTENT: a name+price-only item gets a COMPACT card sized to what it actually " +
      "holds — never a tall box sized for a description or photo that isn't there. Match each card's " +
      "height to its real content.\n" +
      "- LINE-GAP DISCIPLINE: tight, consistent leading on price rows; do NOT stretch rows apart with " +
      "justify-between or oversized vertical gaps. A dotted leader or a hairline rule may connect a " +
      "name to its price across the row.\n" +
      "- SPARE SPACE BECOMES A PHOTO: if the board still has clear empty canvas AND its items have " +
      "photos, fill that space with a CATEGORY PHOTO PANEL (or a row of photo tiles) selling the food — " +
      "anchored to a section per the IMAGE SLOT / LAYOUT STRATEGY (captioned with its category), never " +
      "abstract decoration and never a free-floating image that belongs to no section.",
  ];
}

/**
 * The caption that anchors an image slot to its category (D33). Categories are keyed by NAME in this
 * engine, so the slot's `categoryId` doubles as the display caption; failing that, the single
 * category shared by the slot's photo items, then the title of the section that owns them — so the
 * painter has a category name to label the photo panel with, never a free-floating hero. When the
 * slot's photo items span MORE THAN ONE category (B4), a single-category caption would mislabel the
 * band, so return `undefined` — the emit line drops the caption clause and the anchoring text keeps
 * the band tied to its section without a false one-category label.
 */
function imageSlotCaption(request: PaintRequest): string | undefined {
  const slot = request.planScreen.imageSlot;
  if (slot === undefined) return undefined;
  if (slot.categoryId !== undefined) return slot.categoryId;
  const byId = new Map(request.items.map((i) => [i.id, i]));
  const cats = [
    ...new Set(
      slot.items.map((id) => byId.get(id)?.category).filter((c): c is string => c !== undefined),
    ),
  ];
  if (cats.length === 1) return cats[0];
  if (cats.length > 1) return undefined;
  return request.planScreen.sections.find((s) => s.items.some((id) => slot.items.includes(id)))
    ?.title;
}

/**
 * Per-CATEGORY image-slot directives (the category-images requirement): each section of a comfortable
 * board carries its own slot — a photo panel/carousel when the category has photos, else a deliberate
 * themed food-icon panel. Each container is captioned + tagged `data-image-slot="<category name>"` so
 * the requirement is deterministically checkable. Empty when no section carries a slot (matrix /
 * dense / packed boards use the ONE board-level shared slot instead).
 */
function sectionSlotLines(request: PaintRequest): string[] {
  const lines: string[] = [];
  for (const section of request.planScreen.sections) {
    const slot = section.imageSlot;
    if (slot === undefined) continue;
    if (slot.kind === "photos") {
      lines.push(
        `Section image slot — "${section.title}": render a CATEGORY PHOTO PANEL anchored inside/adjacent ` +
          `to this section, its container carrying data-image-slot="${section.title}" and captioned ` +
          `"${section.title}" (2+ photos → a gallery-fade carousel cross-fading them; 1 photo → a ` +
          `single static panel), NEVER a free-floating hero. Photo item ids: ${JSON.stringify(slot.items)}`,
      );
    } else {
      lines.push(
        `Section image slot — "${section.title}": this category has NO item photos, so give it a ` +
          `deliberate themed FOOD-ICON panel — render ONE curated engine glyph as ` +
          `<svg data-icon="<name>"></svg> (leave it EMPTY; the engine inlines the real glyph) ` +
          `choosing the best-fitting name from [${ICON_GLYPH_NAMES.join(", ")}], coloured with a ` +
          `theme text-token class, plus the category name — its container carrying ` +
          `data-image-slot="${section.title}" and captioned "${section.title}". NEVER hand-draw ` +
          `food art (no ad-hoc SVG dish/cup blobs — LLM-drawn food icons ship as broken dark ` +
          `smudges); a typographic emblem (the big category initial on a token-ruled panel) is the ` +
          `allowed alternative when no glyph name fits. ICON PANEL PROPORTION — keep it a COMPACT, ` +
          `deliberate panel whose glyph is SCALED TO FILL most of it (caption integral), NEVER a tiny ` +
          `glyph floating in a large empty panel, NEVER a tall skinny vertical strip, and NEVER taller ` +
          `or wider than its own section's item content; if the section has little content the panel ` +
          `stays SMALL with it. Make it read as an intentional illustration, NEVER a blank or ` +
          `missing-photo box.`,
      );
    }
  }
  return lines;
}

/**
 * True when an item renders WITHOUT any price element — no base `price`, no `sizes` (a size always
 * carries a price), no priced `variant`. Under the engine's zeroPriceRender:"hide" policy (D29)
 * zero/missing prices are stripped upstream, so this is a plain truth about the item the painter
 * receives (also correct for genuine price-on-request items) — the adapter never re-runs menu-lint.
 * Mirrors `expectedPrices(item).length === 0` in structural-checks so paint and QA agree on which
 * items are priceless.
 */
function isPriceless(item: CanonicalItem): boolean {
  return (
    item.price === undefined &&
    (item.sizes?.length ?? 0) === 0 &&
    !(item.variants ?? []).some((v) => v.price !== undefined)
  );
}

/**
 * Slim the plan object echoed to the painter as JSON so the raw echo can't contradict the
 * authoritative directives that now own layout. Two redundant fields are dropped (B1 + B5):
 *   - the board-level `imageSlot` — the dedicated "Image slot (board-level shared)" directive below
 *     carries its ids PLUS the placement/caption/carousel semantics the raw JSON lacks.
 *   - each NON-matrix section's `layoutHint` — a stale planner free-text hint the LAYOUT STRATEGY +
 *     density/orientation directives now supersede; kept ONLY on a matrix section, where
 *     MATRIX_FIRST_STRATEGY textually references "the section layoutHint".
 * Nothing parses the model's plan echo (D50's structural check reads the real plan object), so this
 * is purely prompt hygiene.
 */
function slimPlanForPrompt(plan: PaintRequest["planScreen"]): Record<string, unknown> {
  const { imageSlot: _imageSlot, sections, ...rest } = plan;
  return {
    ...rest,
    sections: sections.map((section) => {
      if (section.matrix !== undefined || section.representation === "matrix") return section;
      const { layoutHint: _layoutHint, ...sectionRest } = section;
      return sectionRest;
    }),
  };
}

export function describeRequest(request: PaintRequest): string {
  const tokens = request.theme.tokens;
  const motion = request.theme.motion
    .map((m) => `${m.name} (${m.kind}${m.params ? `, params ${JSON.stringify(m.params)}` : ""})`)
    .join(", ");
  // Strip from the item payload: the image data-URIs (inlined at package time — the painter
  // references photos by data-img-item, and the "Item ids WITH a photo" allowlist below carries
  // photo truth) and the off-plan per-item `category` (B2 — a mis-cased upstream taxonomy the COPY
  // WHITELIST could otherwise bless as a competing sub-heading; section structure comes from the
  // plan). Mark each priceless item RIGHT IN the digest JSON (`"priceless":true`) so the painter
  // composes it deliberately — name-only — instead of drawing an empty price container (D29-review
  // Fix 3).
  const slimItems = request.items.map((item) => {
    const { images: _images, category: _category, ...rest } = item;
    return {
      ...rest,
      ...(isPriceless(item) ? { priceless: true } : {}),
    };
  });
  const withPhotos = request.items.filter((i) => (i.images?.length ?? 0) > 0).map((i) => i.id);
  const anyPriceless = request.items.some(isPriceless);
  const anyVariantLabels = request.items.some(
    (i) => (i.sizes?.length ?? 0) > 0 || (i.variants?.length ?? 0) > 0,
  );
  const lines: string[] = [
    `Theme: ${request.theme.name} (density: ${request.theme.density}${request.theme.motif ? `, motif: ${request.theme.motif}` : ""})`,
    `Colour tokens — use as Tailwind classes text-<name> / bg-<name> / border-<name> (e.g. text-text, bg-surface, text-price). Roles: ${describeTokenRoles(tokens.colors)}.`,
    `Motion vocabulary: ${motion}`,
    `Locale: ${request.constraints.locale}, currency: ${request.constraints.currency}`,
    `Target canvas: ${request.viewport?.width ?? 1920}x${request.viewport?.height ?? 1080}px (aspect ${request.constraints.aspect})`,
    ...(request.constraints.aspect === "9:16"
      ? [
          "PORTRAIT (9:16) COMPOSITION: this canvas is tall and narrow — compose a single-column VERTICAL flow: title band at the top, sections stacked full-width down the canvas, items in ONE column (at most two narrow columns for short names). Any photo hero is a full-width horizontal band (roughly the top quarter of the canvas, never half). The type-size minimums are unchanged — the canvas is narrower, not smaller.",
          "PORTRAIT FILL — TOP TO BOTTOM: distribute the stacked sections so the content reaches the BOTTOM edge of the tall canvas — the last section must finish near the bottom, never leaving the lower half (or any large bottom band) empty. Scale type up and let sections and rows grow to ABSORB the full height rather than clustering everything in the top half; a portrait board that ends at 45% of its height with a blank lower half is a failure. Use full-width rows and generous section spacing so the vertical space is filled with content, not padding.",
          "PORTRAIT CATEGORY HEROES — the category photo sits ABOVE the category title at full column width; the category description subtitle sits BELOW the title.",
        ]
      : [
          "LANDSCAPE CATEGORY HEROES — a category hero photo sits BESIDE its category title (photo on one side; title + category description as a subtitle on the other), never stacked in a tall band. A category/section BAND (its title/header strip) must HUG its content — never taller than roughly two line-heights of its title, and NEVER a wide empty colour field; if a band has spare room, that space goes into BIGGER TYPE or a tighter overall board fit, never into a taller band.",
        ]),
    ...(request.board !== undefined
      ? [
          `BOARD FAMILY — this is screen ${request.board.index} of ${request.board.total} in one set hung side by side. All screens share ONE visual system: identical masthead treatment (same background token, same height, title left / brand right), identical section-header recipe, identical price treatment, same canvas background token. Do not restyle or re-brand this board relative to its siblings.`,
        ]
      : []),
    ...(request.planScreen.title !== undefined
      ? [`Masthead title: ${JSON.stringify(request.planScreen.title)}`]
      : []),
    `Plan: ${JSON.stringify(slimPlanForPrompt(request.planScreen))}`,
    request.blueprint
      ? renderBlueprintStrategy(request.blueprint)
      : describeLayoutStrategy(request.planScreen),
    ...matrixDirectiveLines(request),
    ...densityDirectiveLines(request),
    ...sparseDirectiveLines(request),
    ...(request.sizeDirective !== undefined ? [request.sizeDirective] : []),
    `Items: ${JSON.stringify(slimItems)}`,
    `Item ids WITH a photo (only these may use <img>): ${withPhotos.length > 0 ? withPhotos.join(", ") : "(none)"}`,
    ...(anyPriceless
      ? [
          'PRICELESS ITEMS: any item marked "priceless":true in the item JSON above has NO ' +
            "renderable price. Render it NAME-ONLY (plus its description if any) — NEVER an empty " +
            'price chip/box, a price container or data-bind="price" span with nothing in it, an ' +
            "invented $0.00, or a dotted leader running to nothing. If the layout needs balance, a " +
            'small theme-toned "ask" tag (e.g. "MP") beside the name is fine — never a hollow price slot.',
        ]
      : []),
    ...(anyVariantLabels
      ? [
          "PILLS & VARIANT LABELS: a size/variant label and its price are ONE readable unit — the " +
            'label and its price NEVER split onto separate lines or wrap apart (e.g. "10in $12" stays ' +
            'together, never "10in" on one line and "$12" on the next). Pill text uses HIGH-CONTRAST ' +
            "tokens at legible sizes (text-text/text-price on a solid surface-strong pill — NEVER tiny " +
            "text-muted-on-surface). A row of size/variant pills aligns HORIZONTALLY under its item " +
            "name, evenly sized, never a cramped stack of illegible chips.",
        ]
      : []),
    ...sectionSlotLines(request),
  ];
  if (request.planScreen.imageSlot) {
    const caption = imageSlotCaption(request);
    lines.push(
      `Image slot (board-level shared) — render ONE COMPACT CATEGORY PHOTO PANEL for these item ids, ` +
        `its container carrying data-image-slot="shared", anchored inside/adjacent to its ` +
        `section${caption !== undefined ? ` and captioned "${caption}"` : ""} (2+ photos → a ` +
        `gallery-fade carousel cross-fading them; 1 photo → a single static panel), NEVER a ` +
        `free-floating hero: ${JSON.stringify(request.planScreen.imageSlot.items)}`,
    );
  }
  if (request.brand !== undefined) {
    lines.push(...brandUserLines(request.brand));
  }
  if (request.theme.components !== undefined && request.theme.components.length > 0) {
    lines.push(describeComponents(request.theme.components));
  }
  if (request.antiPatterns !== undefined && request.antiPatterns.length > 0) {
    lines.push(
      `NEVER (board-set anti-patterns):\n${request.antiPatterns.map((a) => `- ${a}`).join("\n")}`,
    );
  }
  if (request.previousHtml && request.findings && request.findings.length > 0) {
    // Long-context ordering (Anthropic guidance): put the bulky Previous HTML FIRST and the
    // actionable instruction + findings LAST, so they aren't buried ~20KB before the prompt end.
    lines.push(
      "Previous HTML (your last output):",
      request.previousHtml,
      "This is a RE-PAINT. Make the MINIMAL change that resolves these QA findings, preserving everything else:",
      serializeFindingsForPrompt(request.findings),
      REF_INSTRUCTION,
    );
  }
  return lines.join("\n");
}

/** Frontier-model painter via OpenRouter (D1). Model id comes from `ModelRouting.paint`. */
export class OpenRouterPainter implements Painter {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly logger?: Logger,
    private readonly reasoning?: ReasoningSetting,
    private readonly maxTokens?: number,
    private readonly resilience?: RoleResilience,
    private readonly usage?: UsageSink,
  ) {}

  async paint(request: PaintRequest): Promise<string> {
    const isRepaint = request.previousHtml !== undefined && (request.findings?.length ?? 0) > 0;
    const system = buildSystem(request.theme, isRepaint);
    const user = describeRequest(request);
    // Surface the exact prompt the painter receives so a `try` run shows how the model is driven.
    // The system prompt differs between paint and re-paint only in the tail FINAL SELF-CHECK line
    // (C1) and is identical across a board's re-paints, so emit it only on the first paint; the user
    // prompt (plan + items, and on a re-paint the findings + previous HTML) goes every time.
    if (!isRepaint) {
      this.logger?.debug(`painter SYSTEM prompt (theme "${request.theme.name}"):\n${system}`);
    }
    // On a re-paint the user prompt embeds the ENTIRE previous HTML; redact that blob from the log
    // (keep the findings + instructions) so debug output stays a readable prompt, not a page dump.
    const userForLog =
      request.previousHtml !== undefined
        ? user.replace(
            request.previousHtml,
            `[previous HTML omitted — ${request.previousHtml.length} chars]`,
          )
        : user;
    this.logger?.debug(
      `painter USER prompt — board "${request.planScreen.id}" (${isRepaint ? "re-paint" : "first paint"}):\n${userForLog}`,
    );
    const onUsage = buildUsageReporter(this.logger, this.usage, "paint", this.model);
    const html = await requestText(this.client, {
      model: this.model,
      system,
      user,
      // A full screen of dense HTML is large; the configured `paint` max_tokens (config-as-data)
      // gives the model ample room so it isn't truncated to empty (the painter contract forbids
      // dropping items, so output can't be trimmed to fit) without over-reserving OpenRouter credit.
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
      ...resilienceFields(this.resilience),
      ...(onUsage !== undefined ? { onUsage } : {}),
      ...buildBroadcast(request.correlation, "paint"),
    });
    const trimmed = extractScreenHtml(html);
    if (trimmed === "")
      throw new PaintError(
        "painter returned empty HTML (model produced no content — likely truncated or refused; " +
          "if a board is very dense, raise --screens to spread items across more boards).",
      );
    return trimmed;
  }
}

/**
 * Extract the screen HTML from a model response. Models sometimes ignore "no markdown fences" and
 * wrap the markup in a ```html block, and — especially on a re-paint, where the prompt carries QA
 * findings — prefix it with chain-of-thought prose ("Looking at the two findings: 1. …"). We first
 * take the contents of a fenced code block if one is present (even after a prose preamble), then
 * drop any remaining prose before the first real tag — so neither the reasoning nor a stray ```
 * marker can leak into the rendered page.
 */
export function extractScreenHtml(raw: string): string {
  const fenced = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  let html = fenced?.[1] ?? raw;
  const firstTag = html.search(
    /<(?:!doctype|html|body|div|section|main|article|header|ul|ol|table)\b/i,
  );
  if (firstTag > 0) html = html.slice(firstTag);
  return html.trim();
}
