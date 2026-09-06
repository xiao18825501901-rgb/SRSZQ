# SRSZQ W7 Design Audit Before Redesign

Date: 2026-09-07
Production baseline: `5b10a266a06bbe2de405ff9105f02e6beaecebc2`
Audited URL: https://srszq.com
Method: TASTE redesign audit, Impeccable technical audit criteria, production screenshots at 1440×900 and 390×844, and code inspection of the React/CSS implementation.

## Audit verdict

The current site is functional and restrained, but its visual language is a generic dark product shell. SRSZQ's unique three-player tabletop mechanism is visible as copy and data, yet the interface does not feel like a physical social game. The board uses a flat blue-gray grid, player C is white, buttons resemble software controls, and most page grouping comes from dark bordered rectangles. A full visual replacement is justified while preserving routes, content, rules, and interaction behavior.

| Dimension | Score | Main evidence |
| --- | ---: | --- |
| Accessibility | 3/4 | Explicit A/B/C labels and semantic controls are strong; several muted labels are low-emphasis, icon-only meaning appears in places, and mobile nav is crowded. |
| Performance | 4/4 | CSS-driven visuals, no heavy media, and small motion footprint. |
| Responsive | 3/4 | Core screens reflow and the board is playable at 390px; top navigation and secondary controls become dense. |
| Theming | 1/4 | Two overlapping token sets coexist and many colors are hard-coded in CSS and inline styles. |
| Implementation integrity | 2/4 | Shared primitives exist, but legacy and newer systems are layered together; visual identity is interchangeable with a generic React game dashboard. |
| **Total** | **13/20** | **Acceptable; significant visual-system work required.** |

## Page findings

### Landing

- The main hierarchy is understandable, but the hero is a common split-copy-plus-demo layout with little ownable character.
- The miniature board is a flat dark matrix rather than a tactile product object.
- Primary actions use software-style rounded rectangles; modes and rule preview read as dashboard content.
- The palette gives no warm social-game context and relies on red, green, and white.

### Rules

- The writing and hierarchy explain the unusual victory-right mechanic well.
- Long rule sections sit on the same dark plane with thin dividers, producing a documentation page rather than a game-night rule sheet.
- Victory-right sequencing needs one consistent tabletop track shared with game pages.

### Tutorial

- The tutorial identity and completion state are clear, and the underlying randomized-seat behavior is already testable.
- The visual shell is almost indistinguishable from standard play; it lacks the feeling of guided pieces being placed on a real table.
- Progress and coach guidance need paper-card hierarchy without enclosing every paragraph.

### Local setup and game

- The board is the dominant object on desktop and remains usable on mobile.
- The board material is flat navy with thin blue grid lines; cells look like data-grid targets.
- Player cards, timeline, controls, history, and status bar all use similar dark panels, creating card soup and equal visual weight.
- Pieces are mostly flat circles or squares; C is white and therefore lacks equal player identity.
- The existing piece animation is too short to communicate a physical drop.

### Online match

- Matchmaking state is centered and readable, but the single bordered panel resembles a SaaS waiting state.
- Search iconography and progress treatment are generic; seat arrival is not expressed as three players taking places at a table.
- Game layout gives the secondary timeline and sidebar substantial visual weight next to the board.

### Ranking

- A real table is the correct information pattern and should be preserved.
- Current presentation is a generic dark admin table. A game-night score sheet can provide identity without converting rows into cards.

### Friends and invites

- Existing list semantics should remain.
- Status badges and action buttons use the same product-dashboard vocabulary as the rest of the site.
- Invitation presentation can read as taking a seat while keeping all existing business meaning.

### Login and registration

- Form readability and labels are sound.
- The isolated dark card on an empty dark background feels like B2B authentication and does not introduce the game.
- A quiet tabletop arrangement and three physical seat pieces can create context without an oversized marketing panel.

## Systemic issues

1. **P1: Missing ownable game identity.** The visual system could belong to many developer-built multiplayer products.
2. **P1: Player palette fails the W7 commitment.** Red, green, and white must become coral A, pistachio B, and sky C while retaining A/B/C text.
3. **P1: Board material and piece depth are flat.** The central product object does not communicate warm wood or painted pieces.
4. **P2: Token drift.** Duplicate root variables and hard-coded colors make cross-page consistency expensive.
5. **P2: Panel and pill overuse.** Too many bordered containers and small capsules compete at the same level.
6. **P2: Mobile navigation density.** The 390px header fits tightly and needs an intentional compact treatment.
7. **P2: Motion lacks a product thesis.** Entrance motion is generic; the meaningful authored moment should be the placed piece settling onto the board.

## Strengths to preserve

- Clear rules content and explicit BAC victory-right explanation.
- Real table semantics for ranking.
- Server-authoritative online state and existing W6 seat/difficulty behavior.
- CSS-first implementation with no heavy visual dependencies.
- Functional desktop and mobile board layouts.
- Existing focus, labels, reduced-motion block, and automated browser coverage as a base for hardening.

## Before evidence

Screenshots are stored outside the repository at:

- `outputs/w7/before/1440x900/landing.png`
- `outputs/w7/before/1440x900/auth.png`
- `outputs/w7/before/1440x900/local.png`
- `outputs/w7/before/1440x900/rules.png`
- `outputs/w7/before/1440x900/tutorial.png`
- `outputs/w7/before/1440x900/online.png`
- `outputs/w7/before/1440x900/vsai.png`
- `outputs/w7/before/1440x900/ranking.png`
- Corresponding mobile files under `outputs/w7/before/390x844/`.
