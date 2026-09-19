# Responsive UI audit

The browser regression suite covers the three user-facing surfaces with deterministic quiz data,
long labels, populated rounds and all four game modes.

## Tested sizes

- Host and display: 1280 x 720, 1366 x 768 and 1920 x 1080.
- Player: 320 x 568, 360 x 640, 390 x 844 and 430 x 932 in portrait, plus 844 x 390 in landscape.
- Every case rejects horizontal viewport overflow, controls outside the usable viewport, covered
  controls, and undersized interactive targets. Reference screenshots are compared at 1280 x 720
  for host/display and 390 x 844 for player.

## Covered states

The host suite covers quiz selection, intro, team setup, game hub, Jeopardy board and question,
Order Up overview/active/results, List It overview/active/review/results, Sync Up
lobby/active/results, and victory. Host cases also reject application error screens and uncaught
browser errors.

The display suite covers standby, team lobby, game hub, Jeopardy board/question, Order Up and List
It overview/preview/active/results flows, Sync Up lobby/active/results, and victory.

The player suite covers waiting, team selection, Jeopardy buzzer, Order Up sorting, List It entry,
and Sync Up registration/voting.

## Adjustments made

- Host controls: moved the expanded host menu out of normal layout so it no longer obscures the
  rules control, separated the rules button from the menu, and enlarged setup, buzzer and Sync Up
  controls that were too small at 720p.
- Player layout: allowed long team and connection labels to shrink safely, prevented header/card
  overflow, and enlarged team-selection and Sync Up controls for phone use.
- These are responsive layout and usability corrections; no screen was structurally redesigned.

Run `npm run test:visual` for the complete suite. When an intentional UI change alters the approved
screenshots, inspect the rendered result and run `npm run test:visual:update` to accept it.
