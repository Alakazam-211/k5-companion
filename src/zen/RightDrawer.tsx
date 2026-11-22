// The chat's right drawers (Sessions, Files; K2 Design 2026-11-20): a
// floating tile (.k2-tile .k2-drawer) 8px in from the edges, over a plain
// dim scrim that covers the chat and its header. It slides in with
// Chatter's curve (chatterSwipe.ts), slides out a little faster and stays
// mounted until the slide ends; a rightward swipe on it closes it (the
// same decisions as Chatter's swipe). Reduce Motion: a short fade only.
// It is a modal dialog: the close button takes focus on open, and focus
// goes back to the header toggle on close.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { velocityFromSamples } from "../lib/swipeBack";
import {
  CHATTER_EASE,
  CHATTER_TRANSITION,
  chatterOffset,
  chatterPhase,
  chatterSettlesOpen,
  chatterSwipeIgnores,
  type ChatterPhase,
} from "./chatterSwipe";
import { useFileDrag } from "./fileDrag";
import { PIN_HOLD_MS } from "./pinChats";
import { prefersReducedMotion } from "../kit/mobileChat/sendFly";

/** Space between the drawer and the screen's edges. */
export const DRAWER_GAP_PX = 8;
/** One width for both drawers. */
export const DRAWER_WIDTH = "min(240px, calc(100vw - 72px))";
export const DRAWER_OPEN_TRANSFORM = "translateX(0px)";
export const DRAWER_CLOSED_TRANSFORM = `translateX(calc(100% + ${DRAWER_GAP_PX}px))`;
export const DRAWER_CLOSE_MS = 220;
/** Reduce Motion: no slide, this fade only. */
export const DRAWER_FADE_MS = 140;
export const SCRIM_FADE_MS = 180;
/** A file dragged out of the Files drawer: it moves mostly aside (180ms). */
export const DRAWER_DRAG_TRANSFORM = "translateX(72%)";
const DRAG_MOVE = "180ms ease";

const OPEN_TRANSITION = `${CHATTER_TRANSITION}, opacity ${DRAG_MOVE}`;
const CLOSE_TRANSITION = `transform ${DRAWER_CLOSE_MS}ms ${CHATTER_EASE}, opacity ${DRAG_MOVE}`;
const FADE_TRANSITION = `opacity ${DRAWER_FADE_MS}ms ease`;
const SCRIM_TRANSITION = `opacity ${SCRIM_FADE_MS}ms var(--motion-ease-standard, ease)`;

/** How long a closed drawer stays mounted: its slide (or fade) and a frame. */
export function drawerUnmountMs(reduced: boolean): number {
  return (reduced ? DRAWER_FADE_MS : Math.max(DRAWER_CLOSE_MS, SCRIM_FADE_MS)) + 40;
}

/** The panel's motion styles. `at`: at its open place (not entering or
 *  leaving). `dragging`: a file is out of the Files drawer. */
export function drawerPanelMotion(s: { at: boolean; reduced: boolean; dragging: boolean }): CSSProperties {
  if (s.reduced) {
    // The drag still moves it aside (the composer must show), unanimated.
    return s.at && s.dragging
      ? { transform: DRAWER_DRAG_TRANSFORM, opacity: 0.4, transition: FADE_TRANSITION }
      : { transform: "none", opacity: s.at ? 1 : 0, transition: FADE_TRANSITION };
  }
  if (s.at && s.dragging) {
    return { transform: DRAWER_DRAG_TRANSFORM, opacity: 0.4, transition: `transform ${DRAG_MOVE}, opacity ${DRAG_MOVE}` };
  }
  return {
    transform: s.at ? DRAWER_OPEN_TRANSFORM : DRAWER_CLOSED_TRANSFORM,
    opacity: 1,
    transition: s.at ? OPEN_TRANSITION : CLOSE_TRANSITION,
    willChange: "transform",
  };
}

/** The scrim's: in with the drawer, out on close and while a file drags
 *  (then it lets touches through to the composer, the drop target). */
export function drawerScrimMotion(s: { at: boolean; reduced: boolean; dragging: boolean }): CSSProperties {
  const on = s.at && !s.dragging;
  return {
    opacity: on ? 1 : 0,
    pointerEvents: on ? undefined : "none",
    transition: s.reduced ? FADE_TRANSITION : SCRIM_TRANSITION,
  };
}

export function RightDrawer({
  open,
  label,
  testId,
  onClose,
  closeSelector,
  returnFocusSelector,
  dragging = false,
  children,
}: {
  open: boolean;
  /** The dialog's name ("Sessions", "Files"). */
  label: string;
  testId: string;
  onClose: () => void;
  /** The drawer's close button: focused on open. */
  closeSelector: string;
  /** The header toggle: focus goes back to it on close. */
  returnFocusSelector: string;
  dragging?: boolean;
  /** Rendered while mounted; `open` is false during the closing slide. */
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  /** At the open place (false while entering and leaving). */
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const present = open || mounted;
  const at = open && shown;

  const openRef = useRef(open);
  openRef.current = open;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (unmountTimer.current) clearTimeout(unmountTimer.current);
    unmountTimer.current = null;
    if (open) {
      setReduced(prefersReducedMotion());
      setMounted(true);
      return;
    }
    setShown(false);
    unmountTimer.current = setTimeout(() => {
      unmountTimer.current = null;
      setMounted(false);
    }, drawerUnmountMs(reducedRef.current));
  }, [open]);

  // Entering: the panel has painted off screen (its closed place); read
  // the layout so the browser has it, then move it to the open place.
  useLayoutEffect(() => {
    if (!open || shown) return;
    panelRef.current?.getBoundingClientRect();
    setShown(true);
  }, [open, shown]);

  useEffect(
    () => () => {
      if (unmountTimer.current) clearTimeout(unmountTimer.current);
    },
    []
  );

  // Focus: the close button on open; the toggle on close, unless the
  // reader has already put focus somewhere else.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      panelRef.current?.querySelector<HTMLElement>(closeSelector)?.focus({ preventScroll: true });
    } else if (wasOpen.current) {
      const active = typeof document !== "undefined" ? document.activeElement : null;
      const panel = panelRef.current;
      if (!active || active === document.body || (panel && panel.contains(active))) {
        document.querySelector<HTMLElement>(returnFocusSelector)?.focus({ preventScroll: true });
      }
    }
    wasOpen.current = open;
  }, [open, closeSelector, returnFocusSelector]);

  // A rightward swipe on the drawer closes it (Chatter's decisions). A
  // touch that holds still first is a Files row's hold (menu or drag),
  // not a swipe; so is anything while a file is out.
  useEffect(() => {
    const panel = panelRef.current;
    if (!present || !panel) return;
    let phase: ChatterPhase | null = null;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let t0 = 0;
    let width = 1;
    let samples: { t: number; x: number }[] = [];

    const place = (stay: boolean) => {
      const motion = { at: stay, reduced: reducedRef.current, dragging: draggingRef.current };
      Object.assign(panel.style, drawerPanelMotion(motion));
      const scrim = scrimRef.current;
      if (scrim) Object.assign(scrim.style, drawerScrimMotion(motion));
    };
    const settle = (stay: boolean) => {
      place(stay);
      if (!stay) onCloseRef.current();
    };

    const start = (e: TouchEvent) => {
      phase = null;
      if (!openRef.current || e.touches.length !== 1) return;
      if (useFileDrag.getState().drag || chatterSwipeIgnores(e.target, panel)) return;
      const t = e.touches[0];
      x0 = t.clientX;
      y0 = t.clientY;
      dx = 0;
      t0 = Date.now();
      width = Math.max(1, panel.offsetWidth + DRAWER_GAP_PX);
      samples = [{ t: e.timeStamp || t0, x: x0 }];
      phase = "armed";
    };

    const move = (e: TouchEvent) => {
      if (!phase || phase === "rejected") return;
      if (useFileDrag.getState().drag) {
        if (phase === "tracking") place(true);
        phase = "rejected";
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      dx = t.clientX - x0;
      const was = phase;
      phase = chatterPhase(phase, dx, t.clientY - y0, true);
      if (was === "armed" && phase === "tracking" && Date.now() - t0 >= PIN_HOLD_MS) {
        phase = "rejected";
        return;
      }
      if (phase !== "tracking") return;
      if (e.cancelable) e.preventDefault();
      samples.push({ t: e.timeStamp || Date.now(), x: t.clientX });
      if (samples.length > 20) samples.shift();
      if (reducedRef.current) return;
      const off = chatterOffset(dx, width, true);
      panel.style.transition = "none";
      panel.style.transform = `translateX(${off}px)`;
      const scrim = scrimRef.current;
      if (scrim) {
        scrim.style.transition = "none";
        scrim.style.opacity = String(Math.max(0, 1 - off / width));
      }
    };

    const end = () => {
      if (phase !== "tracking") {
        phase = null;
        return;
      }
      phase = null;
      settle(chatterSettlesOpen(dx, velocityFromSamples(samples), width, true));
    };

    panel.addEventListener("touchstart", start, { passive: true });
    panel.addEventListener("touchmove", move, { passive: false });
    panel.addEventListener("touchend", end, { passive: true });
    panel.addEventListener("touchcancel", end, { passive: true });
    return () => {
      panel.removeEventListener("touchstart", start);
      panel.removeEventListener("touchmove", move);
      panel.removeEventListener("touchend", end);
      panel.removeEventListener("touchcancel", end);
    };
  }, [present]);

  if (!present) return null;
  const motion = { at, reduced, dragging };
  return (
    <>
      <div
        ref={scrimRef}
        className="absolute inset-0 k2-drawer-scrim"
        data-testid={`${testId}-scrim`}
        aria-hidden
        style={{ zIndex: 14, ...drawerScrimMotion(motion) }}
        onClick={(e) => {
          e.stopPropagation();
          if (openRef.current) onCloseRef.current();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-hidden={!open || undefined}
        className="absolute k2-tile k2-drawer flex flex-col"
        data-testid={testId}
        data-state={at ? "open" : open ? "opening" : "closing"}
        data-dragging={dragging ? "1" : undefined}
        style={{
          top: `calc(env(safe-area-inset-top) + ${DRAWER_GAP_PX}px)`,
          bottom: `calc(var(--safe-bottom) + ${DRAWER_GAP_PX}px)`,
          right: DRAWER_GAP_PX,
          width: DRAWER_WIDTH,
          zIndex: 15,
          pointerEvents: open ? undefined : "none",
          ...drawerPanelMotion(motion),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>
  );
}
