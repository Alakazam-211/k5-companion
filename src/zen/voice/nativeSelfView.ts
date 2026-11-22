import { invoke } from "@tauri-apps/api/core";
import { useEffect, type RefObject } from "react";
import { create } from "zustand";
import { isIosWebView } from "../../lib/nativePicker";
import { currentViewport, HIDDEN, sameFrame, tileFrame, type TileFrame } from "./videoTile";

// The native self-view (iOS): your own camera on the call screen's tile is
// drawn by Swift (K2SelfView, an AVSampleBufferDisplayLayer over the
// webview) from Sew's `local:camera` native sink, about one frame behind the
// camera, instead of the kit's webview sink (VP8 encode, the bridge, a
// WebCodecs decode: several frames late).
//
// The page keeps the tile's box, so the kit's layout, names and controls
// stay as they are; it just doesn't open the webview sink in it. Two things
// go to native:
//   - to Rust, `voice_self_view {tile, camera}`: the tile is on the call
//     screen, and your camera is on or paused. Rust opens the sink while both
//     are true in a call (src-tauri/src/voice/self_view.rs), and closes it
//     when either goes or the call ends;
//   - to Swift, `callOp selfViewFrame`: the box's rect in webview points
//     (the same frame as the remote layer's `pipFrame`), on its resize, any
//     scroll, a window, keyboard or orientation change, the return to the
//     app and a slow check for moves nothing else reports. Hidden while the
//     camera is paused (the page shows "Camera paused"), while something
//     covers the tile, off screen, and in the background.
// Only where Rust answers that it draws the self-view (iOS). Everywhere else
// (and until it answers) the kit's own self-view stays. The floating call
// card keeps the kit's self-view too.

/** How often the rect is checked for a move no event reports (another tile
 *  joining above it), while it shows. */
export const SELF_VIEW_POLL_MS = 500;

export const useNativeSelfView = create<{ available: boolean }>(() => ({ available: false }));

type Ops = {
  /** Rust: whether the tile shows and the camera is on; answers whether
   *  this shell draws the self-view natively. */
  tell(tile: boolean, camera: boolean): Promise<boolean>;
  /** Swift: where the tile is. */
  frame(f: TileFrame): void;
};

const nativeOps: Ops = {
  tell: (tile, camera) => invoke<unknown>("voice_self_view", { tile, camera }).then((v) => v === true),
  frame: (f) => {
    void invoke("plugin:k2-push|call_op", { op: "selfViewFrame", ...f }).catch(() => {});
  },
};

let ops: Ops = nativeOps;
let lastFrame: TileFrame | null = null;
let probed = false;

/** The frame to Swift, unless it's the one it already has. */
function sendFrame(f: TileFrame): void {
  if (sameFrame(lastFrame, f)) return;
  lastFrame = f;
  ops.frame(f);
}

/** Ask once whether this shell draws the self-view natively (iOS only). */
export function probeNativeSelfView(): void {
  if (probed || !isIosWebView()) return;
  probed = true;
  ops.tell(false, false).then(
    (ok) => useNativeSelfView.setState({ available: ok }),
    () => useNativeSelfView.setState({ available: false })
  );
}

/** Your camera as the kit has it (LayerVideo's `selfState`). */
export type SelfCamera = "on" | "paused" | "off";

/** The call screen's self-view box `ref`, drawn natively: tells Rust the tile
 *  shows (and whether the camera runs) while mounted, and keeps Swift's view
 *  on the box while the camera is on and nothing covers it. */
export function useNativeSelfViewTile(
  ref: RefObject<HTMLElement | null>,
  { camera, covered, radius }: { camera: SelfCamera; covered: boolean; radius: number }
): void {
  const running = camera !== "off";
  useEffect(() => {
    ops.tell(true, running).catch(() => {});
  }, [running]);
  useEffect(
    () => () => {
      ops.tell(false, false).catch(() => {});
    },
    []
  );

  const show = camera === "on" && !covered;
  useEffect(() => {
    const el = ref.current;
    if (!show || !el) {
      sendFrame(HIDDEN);
      return;
    }
    let raf = 0;
    const measure = () => {
      raf = 0;
      if (document.visibilityState === "hidden") return sendFrame(HIDDEN);
      sendFrame(tileFrame(el.getBoundingClientRect(), currentViewport(), radius));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    if (el.parentElement) ro?.observe(el.parentElement);
    const vv = window.visualViewport;
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("visibilitychange", schedule);
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    const poll = setInterval(schedule, SELF_VIEW_POLL_MS);
    schedule();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearInterval(poll);
      ro?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("visibilitychange", schedule);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      sendFrame(HIDDEN);
    };
  }, [ref, show, radius]);
}

export function __setSelfViewOpsForTests(next: Ops | null): void {
  ops = next ?? nativeOps;
  lastFrame = null;
  probed = false;
  useNativeSelfView.setState({ available: false });
}
