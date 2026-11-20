# Mobile chat kit

Keyboard + composer behaviour for chat screens in a WKWebView (Tauri iOS):
the composer rides the iOS keyboard on the compositor, the interactive
(iMessage) dismiss carries it by native scrolling, taps on the list close
the keyboard, a recorder + replay harness measures how well it keeps up,
and the send motion (an iMessage-style send) lifts the typed text into its
bubble.

Full write-up (the problems, every technique and why, dead ends, native
shim, constants, validation): [docs/mobile-chat-kit.md](../../../docs/mobile-chat-kit.md).

```ts
import {
  useViewport, useViewportTrackRef, useViewportPadRef, keyboardColumnHeight, fullViewportHeight,
  useKeyboardFlip, useKeyboardForwardPlay, useComposerFocusGap, useScrollRoom,
  useKeyboardDrag, useTapToDismiss,
  // send motion
  flySourceOfField, runSendFly, createListGlider, useDeliverBrighten, SENDING_OPACITY,
} from "src/kit/mobileChat";
import "src/kit/mobileChat/sendFly.css";
```

Files: `useKeyboardFlip.ts` (show/hide FLIP), `useKeyboardForwardPlay.ts`
(hold layout, play, commit once — terminals), `useComposerFocusGap.ts`
(8px ↔ safe-bottom gap + blur on own hide), `useScrollRoom.ts` (top scroll
room), `useKeyboardDrag.ts` + `keyboardDragDock.ts` (interactive dismiss),
`useTapToDismiss.ts`. The viewport store, recorder and score live in
`src/lib/` (`useViewportHeight.ts`, `kbDragRecorder.ts`, `kbDragScore.ts`)
and are re-exported from `index.ts`. CSS: the `.mchat-*` block in
`src/styles/index.css`. Native shim: `src-tauri/src/lib.rs` (`ios_keyboard`).

Send motion: `sendFly.ts` + `sendFly.css` (the fly from the field into
the bubble; the fade under reduced motion; the pending breathe),
`listGlide.ts` (one owner for the list's transform: sends, arrivals, a
drawer), `useDeliverBrighten.ts` (pending → delivered brighten). No app
imports: the tail class and the bubble's text selector are `runSendFly`
options (defaults `FLY_TAIL_CLASS`, `FLY_TEXT_SELECTOR`). Wiring a new
chat surface: the checklist under "Send motion (kit parts)" in the doc;
Home chat (`src/zen/homeChat/HomeChatView.tsx`) is the short example.
