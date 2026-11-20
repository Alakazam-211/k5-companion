// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => true);
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => invoke() }));

import { KEYBOARD_RETURN_MS, focusWithKeyboard, focusWithKeyboardOrRest } from "./nativeKeyboard";

let input: HTMLInputElement;
beforeEach(() => {
  invoke.mockClear();
  invoke.mockResolvedValue(true);
  input = document.createElement("input");
  document.body.appendChild(input);
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  input.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("focusWithKeyboard", () => {
  it("focuses at once, arms the shell, then focuses again", async () => {
    const spy = vi.spyOn(input, "focus");
    focusWithKeyboard(input);
    expect(document.activeElement).toBe(input);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("no second focus if the shell can't allow it, or focus moved on", async () => {
    invoke.mockResolvedValue(false);
    const spy = vi.spyOn(input, "focus");
    focusWithKeyboard(input);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledTimes(1);

    invoke.mockResolvedValue(true);
    const other = document.createElement("textarea");
    document.body.appendChild(other);
    focusWithKeyboard(input);
    other.focus();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("outside the shell: a plain focus only", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    focusWithKeyboard(input);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(input);
    expect(invoke).not.toHaveBeenCalled();
  });
});

/** Let the shell round trip finish (dynamic import + invoke) without
 *  touching the faked setTimeout (vi.waitFor would advance it). */
async function until(check: () => boolean) {
  const tick = () =>
    new Promise<void>((r) => (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate(r));
  for (let i = 0; i < 50 && !check(); i += 1) await tick();
}

describe("focusWithKeyboardOrRest", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const will = (show: boolean) =>
    window.dispatchEvent(new CustomEvent("k2-keyboard-will", { detail: { show } }));

  it("focuses with the keyboard; blurs if no keyboard shows in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    focusWithKeyboardOrRest(input);
    expect(document.activeElement).toBe(input);
    await until(() => invoke.mock.calls.length === 1);
    expect(invoke).toHaveBeenCalledTimes(1);
    will(false); // a stale hide is not a show
    vi.advanceTimersByTime(KEYBOARD_RETURN_MS - 1);
    expect(document.activeElement).toBe(input);
    vi.advanceTimersByTime(1);
    expect(document.activeElement).not.toBe(input);
  });

  it("a keyboard show keeps the focus", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    focusWithKeyboardOrRest(input, 500);
    will(true);
    vi.advanceTimersByTime(1000);
    expect(document.activeElement).toBe(input);
  });

  it("no blur once focus moved on, after stop(), or while the app is hidden", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const other = document.createElement("textarea");
    document.body.appendChild(other);
    focusWithKeyboardOrRest(input, 500);
    other.focus();
    vi.advanceTimersByTime(500);
    expect(document.activeElement).toBe(other);
    other.remove();

    const stop = focusWithKeyboardOrRest(input, 500);
    stop();
    vi.advanceTimersByTime(500);
    expect(document.activeElement).toBe(input);

    input.blur();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      focusWithKeyboardOrRest(input, 500);
      vi.advanceTimersByTime(500);
      expect(document.activeElement).toBe(input);
    } finally {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }
  });
});
