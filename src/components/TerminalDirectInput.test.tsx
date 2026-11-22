// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalDirectInput } from "./TerminalDirectInput";
import { stickyCtrlBytes, TERMINAL_ACCESSORY_KEYS } from "../lib/terminalKeys";
import { LiveTextCommitPipeline } from "../lib/liveInputText";

afterEach(cleanup);

function setup(sessionKey = "t1") {
  const send = vi.fn();
  const focusRef: { current: (() => void) | null } = { current: null };
  const utils = render(<TerminalDirectInput send={send} focusRef={focusRef} sessionKey={sessionKey} />);
  const ctrl = () => screen.getByRole("button", { name: "Control" });
  const capture = screen.getByLabelText("Terminal keyboard input") as HTMLInputElement;
  /** One key from the iOS keyboard: the field gets the character, then `input`. */
  const type = (ch: string) => fireEvent.input(capture, { target: { value: ch } });
  const sent = () => send.mock.calls.map((c) => c[0] as string);
  return { ...utils, send, sent, ctrl, capture, type, focusRef };
}

describe("sticky Ctrl key", () => {
  it("sits after Esc as a Control toggle, unpressed, styled like its neighbours", () => {
    const { ctrl } = setup();
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    const ids = Array.from(bar.querySelectorAll("button")).map((b) => b.getAttribute("data-k2-key"));
    expect(ids).toEqual([
      "escape",
      "ctrl",
      ...TERMINAL_ACCESSORY_KEYS.slice(1).map((k) => k.id),
    ]);
    expect(ctrl().textContent).toBe("Ctrl");
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
    expect(ctrl().className).toMatch(/zen-glass zen-glass-pill/);
    expect(ctrl().style.height).toBe("32px");
    // The Ctrl+C-style chords are still there; no separate Ctrl+B key.
    expect(screen.getByRole("button", { name: "Interrupt terminal" })).not.toBeNull();
    expect(bar.querySelector('[data-k2-key="ctrlB"]')).toBeNull();
  });

  it("a tap arms it in the accent and keeps focus; a tap that arms raises the keyboard", () => {
    const { ctrl, capture } = setup();
    expect(fireEvent.pointerDown(ctrl())).toBe(false);
    expect(fireEvent.mouseDown(ctrl())).toBe(false);
    fireEvent.click(ctrl());
    expect(ctrl().getAttribute("aria-pressed")).toBe("true");
    expect(ctrl().style.background).toContain("--color-accent-fill");
    expect(document.activeElement).toBe(capture);
  });

  it("arm → type b → exactly \\x02, nothing else, and Ctrl disarms", () => {
    const { ctrl, capture, type, sent } = setup();
    fireEvent.click(ctrl());
    type("b");
    expect(sent()).toEqual(["\x02"]);
    expect(capture.value).toBe("");
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
    // One key only: the next b is a b.
    type("b");
    expect(sent()).toEqual(["\x02", "b"]);
  });

  it("arm → type C → \\x03 (case-insensitive)", () => {
    const { ctrl, type, sent } = setup();
    fireEvent.click(ctrl());
    type("C");
    expect(sent()).toEqual(["\x03"]);
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
  });

  it("arm → tap Ctrl again → disarmed, and b sends b", () => {
    const { ctrl, type, sent } = setup();
    fireEvent.click(ctrl());
    fireEvent.click(ctrl());
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
    type("b");
    expect(sent()).toEqual(["b"]);
  });

  it("arm → tap Esc → \\x1b and disarmed", () => {
    const { ctrl, type, sent } = setup();
    fireEvent.click(ctrl());
    fireEvent.click(screen.getByRole("button", { name: "Escape" }));
    expect(sent()).toEqual(["\x1b"]);
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
    type("b");
    expect(sent()).toEqual(["\x1b", "b"]);
  });

  it("arm → an arrow (fires on pointer down) sends its own bytes and disarms", () => {
    const { ctrl, sent } = setup();
    fireEvent.click(ctrl());
    const up = screen.getByRole("button", { name: "Arrow Up" });
    fireEvent.pointerDown(up);
    fireEvent.pointerUp(up);
    expect(sent()).toEqual(["\x1b[A"]);
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
  });

  it("a character Ctrl means nothing for disarms and goes plainly", () => {
    const { ctrl, type, sent } = setup();
    fireEvent.click(ctrl());
    type("1");
    expect(sent()).toEqual(["1"]);
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
  });

  it("Enter from the keyboard while armed sends \\r and disarms", () => {
    const { ctrl, capture, sent } = setup();
    fireEvent.click(ctrl());
    fireEvent.keyDown(capture, { key: "Enter" });
    expect(sent()).toEqual(["\r"]);
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
  });

  it("an IME composition while armed sends one control byte, not the letter", () => {
    const { ctrl, capture, sent } = setup();
    fireEvent.click(ctrl());
    fireEvent.compositionStart(capture);
    fireEvent.input(capture, { target: { value: "b" } });
    expect(sent()).toEqual([]);
    fireEvent.compositionEnd(capture, { data: "b" });
    expect(sent()).toEqual(["\x02"]);
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
  });

  it("keyboard dismiss (Hide keyboard) disarms", () => {
    const { ctrl, capture, type, sent } = setup();
    fireEvent.click(ctrl());
    expect(document.activeElement).toBe(capture);
    fireEvent.click(screen.getByRole("button", { name: "Hide keyboard" }));
    expect(document.activeElement).not.toBe(capture);
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
    act(() => capture.focus());
    type("b");
    expect(sent()).toEqual(["b"]);
  });

  it("another terminal disarms", () => {
    const { ctrl, rerender, send, focusRef } = setup("t1");
    fireEvent.click(ctrl());
    expect(ctrl().getAttribute("aria-pressed")).toBe("true");
    rerender(<TerminalDirectInput send={send} focusRef={focusRef} sessionKey="t2" />);
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
  });
});

describe("stickyCtrlBytes", () => {
  it("maps letters A..Z / a..z to 0x01..0x1A", () => {
    for (let i = 0; i < 26; i++) {
      const byte = String.fromCharCode(i + 1);
      expect(stickyCtrlBytes(String.fromCharCode(0x61 + i))).toBe(byte);
      expect(stickyCtrlBytes(String.fromCharCode(0x41 + i))).toBe(byte);
    }
    expect(stickyCtrlBytes("b")).toBe("\x02");
  });

  it("maps the standard extras", () => {
    const table: Array<[string, string]> = [
      ["@", "\x00"],
      [" ", "\x00"],
      ["[", "\x1b"],
      ["\\", "\x1c"],
      ["]", "\x1d"],
      ["^", "\x1e"],
      ["_", "\x1f"],
      ["-", "\x1f"],
      ["?", "\x7f"],
    ];
    for (const [ch, byte] of table) expect(stickyCtrlBytes(ch)).toBe(byte);
  });

  it("has nothing for other characters", () => {
    for (const ch of ["1", "!", ".", "/", "é", "", "ab"]) expect(stickyCtrlBytes(ch)).toBeNull();
  });
});

describe("LiveTextCommitPipeline sticky Ctrl", () => {
  const rig = () => {
    const sent: string[] = [];
    const onCtrlDisarm = vi.fn();
    const p = new LiveTextCommitPipeline({
      sendBytes: (b) => sent.push(b),
      setFieldValue: () => {},
      onCtrlDisarm,
    });
    return { p, sent, onCtrlDisarm };
  };

  it("each extra typed while armed sends only its byte", () => {
    for (const [ch, byte] of [
      [" ", "\x00"],
      ["[", "\x1b"],
      ["-", "\x1f"],
      ["?", "\x7f"],
    ]) {
      const { p, sent, onCtrlDisarm } = rig();
      p.setCtrlArmed(true);
      p.fieldInput(ch);
      expect(sent).toEqual([byte]);
      expect(p.isCtrlArmed).toBe(false);
      expect(onCtrlDisarm).toHaveBeenCalledTimes(1);
    }
  });

  it("text deferred before arming flushes first, in typed order", () => {
    vi.useFakeTimers();
    try {
      const { p, sent } = rig();
      p.fieldInput("é"); // non-ASCII without composition: deferred 150ms
      expect(sent).toEqual([]);
      p.setCtrlArmed(true);
      p.fieldInput("éb");
      expect(sent).toEqual(["é", "\x02"]);
      vi.runAllTimers();
      expect(sent).toEqual(["é", "\x02"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a control byte disarms; disarmed typing is untouched", () => {
    const { p, sent, onCtrlDisarm } = rig();
    p.setCtrlArmed(true);
    p.controlBytes("\t");
    expect(onCtrlDisarm).toHaveBeenCalledTimes(1);
    p.fieldInput("b");
    expect(sent).toEqual(["\t", "b"]);
  });
});
