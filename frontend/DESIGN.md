# SRSZQ Visual System

<!-- Impeccable design authority for the frontend. Full rationale: ../W7_TABLETOP_DESIGN_SYSTEM.md -->

## Direction

The frontend uses **The Open Game Box**, a warm modern tabletop world for a three-player strategy game. Cream paper, warm wood, matte pastel pieces, compact score-sheet typography, and disciplined tactile controls replace the former dark software shell. The board is always the primary object on play surfaces.

## Core tokens

- Canvas `#F5EEDC`, paper `#FFF9EA`, ink `#2F2923`, soft ink `#675C50`.
- Wood range `#E7C99B`, `#C99457`, `#9B6338`, `#674126`.
- Player A coral `#F27D72`, B pistachio `#8FCB9B`, C sky `#74B7D8`.
- Radius scale 8px, 12px, 18px. Circles only for pieces and status markers.
- Shadows progress from paper to button to board to piece; piece depth is strongest.
- Spacing follows 4, 8, 12, 16, 24, 32, 48, 64px.
- Major headings use the self-hosted SRSZQ WenKai display subset; body copy stays on the system CJK sans stack.

## Composition

Use whitespace, typographic grouping, and rules before cards. Paper panels are reserved for semantic groups. Ranking remains a semantic table and reflows into compact score-sheet rows on phones. Player identity is a compact seat strip. The BAC mechanic is a tabletop round track shared across game surfaces. Mobile order is status, board, players, actions, secondary information.

## Interaction and motion

The authored moment is a 420ms piece placement using transform, opacity, scale, and a settled shadow. Buttons compress on press. Turn and victory-right changes use short surface emphasis. `prefers-reduced-motion` removes spatial movement while keeping state confirmation visible.

## Guardrails

Keep A/B/C text with every player color. Preserve rules, routes, server authority, W6 seat randomization, AI stars, form semantics, keyboard focus, and mobile playability. Do not use purple gradients, glass decoration, background glows, generic SaaS cards, pill soup, childish mascot styling, or decorative looping motion.
