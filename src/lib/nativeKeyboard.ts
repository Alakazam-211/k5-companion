// The keyboard for a focus the page itself makes (iOS). WebKit raises the
// keyboard only for a focus during a user interaction (a tap); a
// script's focus() otherwise gets the caret and no keyboard. When the page
// must give the keyboard back on its own (a swipe-back that springs home
// refocuses the field it blurred), it arms a one-shot allowance in the
// shell first (src-tauri/src/lib.rs `ios_keyboard_allow_focus`), then
// focuses. Off iOS this resolves false and a plain focus is used.

function inShell(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** Focus `el` with its keyboard. The plain focus runs at once (enough
 *  inside a touch handler); on iOS the allowance is armed and the field
 *  focused again, which WebKit treats as a fresh focus while no keyboard
 *  is showing for it. Skipped if focus moved elsewhere meanwhile. */
export function focusWithKeyboard(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  if (!inShell()) return;
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (!(await invoke<boolean>("ios_keyboard_allow_focus"))) return;
    } catch {
      return;
    }
    const a = document.activeElement;
    if (!el.isConnected || (a !== el && a !== document.body && a !== null)) return;
    el.focus({ preventScroll: true });
  })();
}

/** How long a refocus after a native sheet waits for its keyboard (ms). */
export const KEYBOARD_RETURN_MS = 1000;

/** `focusWithKeyboard` for a field coming back from a native sheet that
 *  took the keyboard (a photo or file picker). If no keyboard comes for it
 *  within `waitMs` (no `k2-keyboard-will` show: WebKit kept the caret but
 *  raised nothing), the field is blurred, so the screen's composer leaves
 *  its typing gap (8px over the keyboard) and rests above the home
 *  indicator again; a tap brings the keyboard as usual. Not while the app
 *  is hidden (a focus change then can hang UIKit's keyboard queue;
 *  useComposerFocusGap blurs on return). Returns a cancel. */
export function focusWithKeyboardOrRest(el: HTMLElement, waitMs = KEYBOARD_RETURN_MS): () => void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    window.removeEventListener("k2-keyboard-will", onWill);
  };
  const onWill = (e: Event) => {
    const d = (e as CustomEvent<{ show?: boolean }>).detail;
    if (d && d.show !== false) stop();
  };
  window.addEventListener("k2-keyboard-will", onWill);
  timer = setTimeout(() => {
    if (done) return;
    stop();
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (document.activeElement === el) el.blur();
  }, waitMs);
  focusWithKeyboard(el);
  return stop;
}
