# SRSZQ Interaction Polish — Change Log

Source commit: `5aa35ab7830790f872a04bfba46fb6edff5b93ff`

## Visual and interaction layer

- Added one shared button primitive with stable label/status slots, loading feedback, success/error feedback and inline SVG icons.
- Added interaction styling for hover-capable devices, pressed state, keyboard focus, selected state, disabled state and reduced-motion users.
- Upgraded replay controls, game actions, online exit/rematch actions, account actions, friend invitation actions and daily-training navigation without changing their business callbacks.
- Made `ModeArtwork` SVG definition IDs unique per rendered instance.

## Modal behavior

- Replaced the visual overlay implementation with a native `dialog` top layer.
- Added Escape handling, focus containment, focus restoration and safe outside-click handling.
- Confirmation, board settings and end-of-game dialogs focus their safe action first.
- Background board input remains blocked while a dialog is open.

## Honest async feedback

- Added a scoped `useAsyncFeedback` helper with immediate duplicate-click protection and stale-scope rejection.
- Account claim, friend invite/accept/reject, daily answer and next-question flows now expose their real pending/error/success state.
- Pending remains active until related refresh work completes.
- No retries, fake successes or delayed business actions were added.

## Daily training guarantee

- Only the server verdict `CORRECT` is accepted as success.
- `INCORRECT`, `ILLEGAL` and `OPEN` stay on the current puzzle and never display success.
- Wrong moves do not remain on the board.
- The accepted move remains on the board after success and after refresh.
- Only the server-authoritative Next action advances the session; the 20-question cap is unchanged.

## Preserved product behavior

- One-click accounts, login, 20-second matchmaking, 30-second online turns, five AI levels, score policy, shared rules, daily persistence, site layout, ink background, colors and intersection board were retained.
- No backend rules, database schema, DNS, cloud configuration or production state changed.
