# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

SRSZQ serves university students, young adults, and board-game players who want a quick social strategy game with friends, AI opponents, or online participants. Guest players can learn the rules and play locally without creating an account; registered players can enter ranked and social online flows.

## Product Purpose

SRSZQ makes a three-player four-in-a-row game playable and understandable across tutorial, local, human-versus-AI, and server-authoritative online modes. Success means players can immediately identify seats A, B, and C, understand whose turn and victory right are active, place a legal move, and complete a match on desktop or mobile.

## Positioning

The distinguishing mechanism is a three-player board with A to B to C turn order and a rotating victory right: rounds 1 through 5 have no eligible winner, then the right rotates C to B to A. A line of four or more only wins when the current player holds that right.

## Operating Context

Players use the product as a casual game-night experience in a browser. Core workflows include reading the rules, completing a guided tutorial, configuring a local table, practicing against AI, joining online matchmaking with AI fill, reviewing rankings, managing friends and invitations, and signing in or registering.

## Capabilities and Constraints

- Board sizes are 13 by 13 and 17 by 17.
- Game rules, legal-move checks, win detection, A to B to C order, victory-right qualification, AI strategy and difficulty mapping are owned by the shared engine and are outside a visual redesign.
- Online play remains server-authoritative; the client submits move intent and renders authoritative state.
- Tutorial uses one human seat randomized among A, B, and C plus exactly two AI seats with independently randomized 1-star through 5-star difficulty.
- Online participants receive randomized A, B, or C seats; AI fill uses only true 4-star or 5-star difficulty and exposes the correct label.
- Guest Local is available without login and allows each A, B, and C seat to be Human or AI with random or explicit 1-star through 5-star difficulty.
- Production frontend is https://srszq.com. API and WebSocket endpoints remain https://api.srszq.com and wss://api.srszq.com/ws.
- The frontend is a React and Vite single-page app. CSS and lightweight vector geometry are preferred over large media, canvas engines, or new animation libraries.

## Brand Commitments

- Product name: SRSZQ, 三人四子棋.
- Voice: clear, friendly, youthful, and grounded in modern tabletop play rather than business software.
- The visual identity must feel like a warm physical board-game table: cream paper, warm wood, tactile controls, and pastel coral, mint, and sky player pieces.
- Seats and state must always use both color and explicit A, B, or C text.
- The interface must avoid generic SaaS styling, purple-blue gradients, glass effects, excessive pills, excessive cards, childish cartoon language, and decorative motion.

## Evidence on Hand

The repository contains the production application, game rules, automated unit and integration tests, browser E2E suites, deployment configuration, prior audit and redesign reports, and synthetic QA flows. No testimonial, commercial metric, or external brand photography has been supplied and none may be fabricated.

## Product Principles

1. The board and current game state remain the clearest and most prominent objects on every play surface.
2. Physical-tabletop character must improve comprehension and enjoyment without changing game behavior.
3. Every seat, turn, star level, and victory-right state remains legible without relying on color alone.
4. Guests reach rules, tutorial, and local play with minimal friction; authenticated features retain their existing access rules.
5. The same product truth and interaction order must hold across desktop, tablet, mobile, keyboard, touch, reduced-motion, and online latency states.

## Accessibility & Inclusion

The interface targets WCAG AA contrast, visible keyboard focus, semantic labels, readable form errors, 44-pixel touch targets where practical, and an intentional `prefers-reduced-motion` alternative. Player colors, victory right, AI star level, and online presence must also be communicated in text.
