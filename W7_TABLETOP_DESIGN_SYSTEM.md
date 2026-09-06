# SRSZQ W7 Tabletop Design System

## Vision

SRSZQ should feel like a modern three-player strategy game already laid out on a warm shared table. The visual world combines an opened contemporary board-game box, a compact game-night score sheet, and matte painted pieces. It is playful enough to invite a first move and disciplined enough for repeated competitive play.

Impeccable direction seed `16c29403` assigned the third grounded candidate. That candidate is **The Open Game Box**: the board is the product, paper explains the rules, player seats form a finite A/B/C set, and motion comes from placing a piece. Character-catalog consistency is retained only as disciplined seat identity; mascot styling is declined. Nixie instrumentation, hostile information noise, alphabet spectacle, and origami sequencing were declined because they weaken either audience identification or immediate game clarity.

TASTE dials:

- Design variance: **7**. The replacement must be obviously ownable while retaining familiar game controls.
- Motion intensity: **5**. One authored piece-drop moment plus quiet state feedback.
- Visual density: **5**. The 13×13 and 17×17 board already carry high information density, so surrounding UI remains compact and calm.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `--color-canvas` | `#F5EEDC` | Warm paper canvas |
| `--color-paper` | `#FFF9EA` | Primary paper surface |
| `--color-paper-deep` | `#EADCBF` | Rules strips and quiet tracks |
| `--color-ink` | `#2F2923` | Primary text |
| `--color-ink-soft` | `#675C50` | Secondary text |
| `--color-wood-100` | `#E7C99B` | Light wood highlight |
| `--color-wood-300` | `#C99457` | Board face |
| `--color-wood-500` | `#9B6338` | Board frame and controls |
| `--color-wood-700` | `#674126` | Deep edge and focus contrast |
| `--color-player-a` | `#F27D72` | A, coral |
| `--color-player-b` | `#8FCB9B` | B, pistachio mint |
| `--color-player-c` | `#74B7D8` | C, sky blueberry |
| `--color-warning` | `#B64A3C` | User-facing error and illegal move |
| `--color-success` | `#3F8060` | Success and online state |

Player fills always appear with A, B, or C text in badges, labels, accessible names, or adjacent copy. No state relies on color alone.

## Typography

Major headings and brand moments use a 250 KB, site-character subset of LXGW WenKai GB Lite Medium, self-hosted with `font-display: swap` under the bundled SIL OFL license. Its handwritten Kai structure supplies the friendly rulebook voice without turning body copy into novelty type. Body copy keeps the highly legible system CJK sans stack, and game data uses tabular numerals.

## Spacing

Base steps are `4, 8, 12, 16, 24, 32, 48, 64px`. Related labels and values use 4 to 8px. A control group uses 12 to 16px. Major regions use 24 to 48px. Page sections do not repeat the same card grid rhythm.

## Radii

- Small: `8px` for fields and compact controls.
- Medium: `12px` for buttons, player strips, and timeline rows.
- Large: `18px` for true paper surfaces and board frame.
- Full circles are reserved for pieces, status dots, and compact seat markers. Pills are reserved for short status labels only.

## Shadows

- Surface: subtle ambient separation on the tabletop.
- Paper/card: low soft shadow with a downward offset.
- Button: compact wood-toned depth that compresses on press.
- Piece: strongest object shadow, plus inner highlight and lower-edge shading.
- Board: broad table shadow with an inner wooden rim.

No component invents a new shadow. Borders and shadows are not doubled without material reason.

## Buttons

Buttons resemble warm wooden or painted table controls: medium radius, visible label, weighted type, a small downward shadow, and a 1 to 2px press translation. Primary actions use wood brown with cream text. Secondary actions use paper or pale wood. Danger stays warm red. Ghost buttons remain text-forward and do not become capsules by default.

## Cards and paper surfaces

Paper surfaces are used only for a real grouping: authentication form, setup sheet, tutorial coach note, rules chapter, or matchmaking table. Page structure uses whitespace, rules, and alignment before adding another container. Nested cards and identical feature-card grids are removed where possible.

## Pieces

Pieces are circular matte-painted tokens. Each has:

- pastel seat color;
- an upper-left soft highlight;
- lower-edge shading;
- a distinct cast shadow stronger than paper elevation;
- an A/B/C accessible label through the cell and surrounding player identity.

The same piece language appears in the board, hero preview, player strips, setup, BAC track, loading state, and result state.

## Board

The board is a warm wood object with a darker frame and a subtle CSS grain derived from narrow tonal gradients in the wood direction. Grid intersections remain clear at 13×13 and 17×17. Empty cells use inset wells rather than bright dots. Legal, winning, hovered, and forbidden states remain distinguishable at a glance. Decoration never covers hit targets or coordinates.

## Icons

The system favors text labels and simple CSS geometry. Existing emoji used as generic interface icons is reduced where it weakens coherence. No new icon library or hand-drawn illustration set is required. Symbols that carry game meaning, such as stars and victory markers, always have readable text or ARIA equivalents.

## Motion

Motion thesis: **a piece is placed onto a physical board**.

- Focal moment: a 420ms translate-and-settle animation with opacity and scale, ending in a stable piece shadow.
- Continuity: current-turn and victory-right changes use short color and shadow transitions.
- Feedback: buttons depress 1 to 2px; seat selection receives a brief surface emphasis; illegal placement uses a short controlled shake with written reason.
- Budget: CSS transform and opacity only for repeated board motion; no heavy animation dependency is added.
- Reduced motion: pieces appear immediately with a brief opacity/color confirmation; state never depends on animation completion.

## Accessibility

- Target WCAG AA contrast for text and controls.
- Use `:focus-visible` with a high-contrast wood/coral ring and offset.
- Preserve semantic buttons, form labels, table structure, and logical keyboard order.
- Maintain readable A/B/C, current-turn, victory-right, AI-star, legal/forbidden, and online-state labels.
- Keep touch controls at least 44px where they are individually operated; board cells maximize available area and retain full-cell targets.

## Responsive behavior

- Wide desktop: board centered and largest; status and player information support it without competing.
- 1024px/tablet: secondary information stacks below or beside the board according to available width.
- 768px portrait: one-column flow with status, board, players, actions, then history.
- 390px and 360px: compact navigation, full-width board, no horizontal overflow, selectors and actions wrap by meaningful groups, stars stay on one readable line.
- Board size responds to both viewport width and height; desktop sidebars never force the mobile layout.
