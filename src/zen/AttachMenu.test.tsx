// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { GlassComposer } from "./GlassComposer";
import {
  ATTACH_MENU_ITEMS,
  ATTACH_MENU_RADIUS_PX,
  ATTACH_MENU_ROW_PX,
  CAMERA_PHOTO_ONLY_LABEL,
  type AttachMenuExtra,
} from "./AttachMenu";
import { useVoiceCall } from "./voice/voiceCall";
import { BookmarkPlusIcon } from "./icons";
import { backHandlerCount, handleAndroidBack } from "../lib/androidBack";
import menuSrc from "./AttachMenu.tsx?raw";
import { KEYBOARD_RETURN_MS } from "../lib/nativeKeyboard";

const picker = vi.hoisted(() => ({
  available: vi.fn(() => false),
  pick: vi.fn(),
}));

vi.mock("../lib/nativePicker", async (orig) => {
  const real = await orig<typeof import("../lib/nativePicker")>();
  return {
    ...real,
    nativePickerAvailable: picker.available,
    nativePick: picker.pick,
  };
});

// The shell: `ios_keyboard_allow_focus` arms WebKit's keyboard for the
// next focus (focusWithKeyboard).
const core = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string) => cmd === "ios_keyboard_allow_focus"),
}));
vi.mock("@tauri-apps/api/core", async (orig) => {
  const real = await orig<typeof import("@tauri-apps/api/core")>();
  return { ...real, invoke: core.invoke };
});

let cssSrc = "";
beforeAll(async () => {
  // @ts-expect-error Node fs — vitest runtime, not in app tsconfig libs
  const { readFileSync } = await import("fs");
  cssSrc = readFileSync("src/styles/index.css", "utf8") as string;
});

beforeEach(() => {
  picker.available.mockReset().mockReturnValue(false);
  picker.pick.mockReset();
});
afterEach(cleanup);

function Harness({
  onAttach = () => {},
  onAttachError,
  attach,
  attachDisabled,
  menuExtras,
}: {
  onAttach?: (files: File[]) => void;
  onAttachError?: (m: string) => void;
  attach?: boolean;
  attachDisabled?: boolean;
  menuExtras?: AttachMenuExtra[];
}) {
  const [value, setValue] = useState("draft");
  return (
    <div>
      <p data-testid="outside">thread</p>
      <GlassComposer
        value={value}
        onChange={setValue}
        onSubmit={() => {}}
        onAttach={onAttach}
        onAttachError={onAttachError}
        canSend
        sendReady
        attach={attach}
        attachDisabled={attachDisabled}
        menuExtras={menuExtras}
      />
    </div>
  );
}

const field = () => screen.getByTestId("composer-input") as HTMLTextAreaElement;
const plus = () => screen.getByTestId("composer-attach");
const menu = () => screen.queryByTestId("composer-attach-menu");

/** Focus the field, then tap `＋` the way a finger does. */
function openMenu() {
  field().focus();
  const btn = plus();
  fireEvent.pointerDown(btn);
  fireEvent.mouseDown(btn);
  fireEvent.click(btn);
}

/** Stub the hidden inputs' click (jsdom would no-op it anyway). */
function stubInputs() {
  const clicked: string[] = [];
  for (const tid of ["composer-file-input", "composer-photo-input", "composer-camera-input"]) {
    (screen.getByTestId(tid) as HTMLInputElement).click = () => {
      clicked.push(tid);
    };
  }
  return clicked;
}

describe("AttachMenu: opening", () => {
  it("＋ toggles a glass menu above it with the three rows, and the field keeps focus", () => {
    render(<Harness />);
    openMenu();
    const m = menu()!;
    expect(m).not.toBeNull();
    expect(document.activeElement).toBe(field());
    expect(m.getAttribute("role")).toBe("menu");
    expect(m.className).toMatch(/zen-glass/);
    expect(m.className).toMatch(/k2-attach-menu/);
    expect(m.style.borderRadius).toBe(`${ATTACH_MENU_RADIUS_PX}px`);
    expect(m.style.bottom).toBe("calc(100% + 8px)");
    expect(plus().getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Photo Library",
      "Take Photo or Video",
      "Choose Files",
    ]);
    expect(items.map((i) => i.querySelector("svg")?.getAttribute("data-k2-icon"))).toEqual([
      "photo",
      "camera",
      "folder",
    ]);
    for (const i of items) {
      expect(i.style.minHeight).toBe(`${ATTACH_MENU_ROW_PX}px`);
      expect(i.style.fontSize).toBe("17px");
    }
    // The menu sits beside the field, not in it (the field's children stay
    // ＋ / textarea / send), and the bar lets it overflow upward.
    expect(screen.getByTestId("composer-field").contains(m)).toBe(false);
    expect(screen.getByTestId("composer-bar").style.overflow).toBe("visible");
    fireEvent.click(plus());
    expect(menu()).toBeNull();
    expect(plus().getAttribute("aria-expanded")).toBe("false");
  });

  it("＋ and every menu row prevent default on pointerdown and mousedown (no blur)", () => {
    render(<Harness />);
    openMenu();
    const targets = [plus(), menu()!, ...screen.getAllByRole("menuitem")];
    for (const el of targets) {
      for (const type of ["pointerDown", "mouseDown"] as const) {
        const ev = createEvent[type](el);
        fireEvent(el, ev);
        expect(ev.defaultPrevented, `${type} on ${el.textContent}`).toBe(true);
      }
    }
    expect(document.activeElement).toBe(field());
    expect(menu()).not.toBeNull();
  });

  it("attach={false} hides ＋ entirely; a disabled ＋ closes an open menu", () => {
    const { rerender } = render(<Harness attach={false} />);
    expect(screen.queryByTestId("composer-attach")).toBeNull();
    rerender(<Harness />);
    openMenu();
    expect(menu()).not.toBeNull();
    rerender(<Harness attachDisabled />);
    expect(menu()).toBeNull();
    rerender(<Harness />);
    expect(menu()).toBeNull();
  });
});

describe("AttachMenu: closing", () => {
  it("a tap outside closes it without swallowing the tap", () => {
    render(<Harness />);
    openMenu();
    const ev = createEvent.pointerDown(screen.getByTestId("outside"));
    fireEvent(screen.getByTestId("outside"), ev);
    expect(menu()).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("a tap inside the menu does not close it", () => {
    render(<Harness />);
    openMenu();
    fireEvent.pointerDown(screen.getAllByRole("menuitem")[0]);
    expect(menu()).not.toBeNull();
  });

  it("Escape closes it", () => {
    render(<Harness />);
    openMenu();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(menu()).toBeNull();
  });

  it("Android Back closes it (topmost layer), then unregisters", () => {
    render(<Harness />);
    const before = backHandlerCount();
    openMenu();
    expect(backHandlerCount()).toBe(before + 1);
    act(() => {
      expect(handleAndroidBack()).toBe(true);
    });
    expect(menu()).toBeNull();
    expect(backHandlerCount()).toBe(before);
  });
});

describe("AttachMenu: choosing (web inputs)", () => {
  it("Take Photo or Video clicks the camera input (capture, image+video)", () => {
    render(<Harness />);
    const clicked = stubInputs();
    const cam = screen.getByTestId("composer-camera-input");
    expect(cam.getAttribute("capture")).toBe("environment");
    expect(cam.getAttribute("accept")).toBe("image/*,video/*");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Take Photo or Video" }));
    expect(clicked).toEqual(["composer-camera-input"]);
    expect(menu()).toBeNull();
    expect(picker.pick).not.toHaveBeenCalled();
  });

  it("during a voice call the camera takes photos only (video would take the call's microphone)", () => {
    useVoiceCall.setState({ phase: "connected" });
    try {
      render(<Harness />);
      const clicked = stubInputs();
      expect(screen.getByTestId("composer-camera-input").getAttribute("accept")).toBe("image/*");
      // The library still offers videos: picking one doesn't touch the mic.
      expect(screen.getByTestId("composer-photo-input").getAttribute("accept")).toBe("image/*,video/*");
      openMenu();
      expect(screen.queryByRole("menuitem", { name: "Take Photo or Video" })).toBeNull();
      fireEvent.click(screen.getByRole("menuitem", { name: CAMERA_PHOTO_ONLY_LABEL }));
      expect(clicked).toEqual(["composer-camera-input"]);
    } finally {
      act(() => useVoiceCall.setState({ phase: "idle" }));
    }
    // The call ended: video again.
    expect(screen.getByTestId("composer-camera-input").getAttribute("accept")).toBe("image/*,video/*");
  });

  it("without native pickers: Photo Library → image/video input, Choose Files → any-file input", () => {
    render(<Harness />);
    const clicked = stubInputs();
    const photo = screen.getByTestId("composer-photo-input");
    expect(photo.getAttribute("accept")).toBe("image/*,video/*");
    expect(photo.hasAttribute("capture")).toBe(false);
    expect(screen.getByTestId("composer-file-input").hasAttribute("accept")).toBe(false);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Photo Library" }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose Files" }));
    expect(clicked).toEqual(["composer-photo-input", "composer-file-input"]);
    expect(picker.pick).not.toHaveBeenCalled();
  });

  it("files from any input go to onAttach (read into memory) and the field gets focus back", async () => {
    const onAttach = vi.fn();
    render(<Harness onAttach={onAttach} />);
    stubInputs();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Take Photo or Video" }));
    // The camera took the screen (and the keyboard).
    field().blur();
    const shot = new File(["x"], "IMG_1.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("composer-camera-input"), { target: { files: [shot] } });
    expect(document.activeElement).toBe(field());
    await vi.waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    const [got] = onAttach.mock.calls[0][0] as File[];
    expect(got).not.toBe(shot);
    expect([got.name, got.type, await got.text()]).toEqual(["IMG_1.jpg", "image/jpeg", "x"]);
  });

  it("a picked file that cannot be read is reported, not attached (Android content:// grant)", async () => {
    const onAttach = vi.fn();
    const onAttachError = vi.fn();
    render(<Harness onAttach={onAttach} onAttachError={onAttachError} />);
    stubInputs();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose Files" }));
    const gone = new File(["x"], "1000007261.jpg", { type: "image/jpeg" });
    gone.arrayBuffer = () => Promise.reject(new DOMException("could not be read", "NotReadableError"));
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [gone] } });
    await vi.waitFor(() => expect(onAttachError).toHaveBeenCalledWith("Could not read 1000007261.jpg"));
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("a cancelled web picker still gives the field its focus back", () => {
    render(<Harness />);
    stubInputs();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose Files" }));
    field().blur();
    fireEvent(screen.getByTestId("composer-file-input"), new Event("cancel"));
    expect(document.activeElement).toBe(field());
  });

  it("no re-focus when the field was not focused before the menu opened", () => {
    render(<Harness />);
    stubInputs();
    fireEvent.click(plus());
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose Files" }));
    fireEvent(screen.getByTestId("composer-file-input"), new Event("cancel"));
    expect(document.activeElement).not.toBe(field());
  });
});

describe("AttachMenu: choosing (native pickers)", () => {
  it("Photo Library → native media pick; results become Files for onAttach; focus returns", async () => {
    picker.available.mockReturnValue(true);
    picker.pick.mockResolvedValue({
      files: [new File(["hello"], "IMG_2.jpeg", { type: "image/jpeg" })],
      skipped: [],
      cancelled: false,
    });
    const onAttach = vi.fn();
    render(<Harness onAttach={onAttach} />);
    const clicked = stubInputs();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Photo Library" }));
    expect(menu()).toBeNull();
    expect(picker.pick).toHaveBeenCalledWith("media");
    field().blur();
    await act(async () => {});
    expect(onAttach).toHaveBeenCalledTimes(1);
    const [files] = onAttach.mock.calls[0] as [File[]];
    expect(files[0].name).toBe("IMG_2.jpeg");
    expect(clicked).toEqual([]);
    expect(document.activeElement).toBe(field());
  });

  it("Choose Files → native document pick; skipped files are reported", async () => {
    picker.available.mockReturnValue(true);
    picker.pick.mockResolvedValue({
      files: [],
      skipped: [{ name: "huge.mov", reason: "too large" }],
      cancelled: false,
    });
    const onAttach = vi.fn();
    const onAttachError = vi.fn();
    render(<Harness onAttach={onAttach} onAttachError={onAttachError} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose Files" }));
    expect(picker.pick).toHaveBeenCalledWith("documents");
    await act(async () => {});
    expect(onAttach).not.toHaveBeenCalled();
    expect(onAttachError).toHaveBeenCalledWith('"huge.mov" is too large (50 MB max)');
  });

  it("a cancelled native pick attaches nothing and restores focus", async () => {
    picker.available.mockReturnValue(true);
    picker.pick.mockResolvedValue({ files: [], skipped: [], cancelled: true });
    const onAttach = vi.fn();
    render(<Harness onAttach={onAttach} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Photo Library" }));
    field().blur();
    await act(async () => {});
    expect(onAttach).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
  });

  it("native `unsupported` falls back to the web input", async () => {
    picker.available.mockReturnValue(true);
    picker.pick.mockRejectedValue("unsupported: native attach pickers are iOS-only");
    render(<Harness />);
    const clicked = stubInputs();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Photo Library" }));
    await act(async () => {});
    expect(clicked).toEqual(["composer-photo-input"]);
  });

  it("another native failure is reported, not retried", async () => {
    picker.available.mockReturnValue(true);
    picker.pick.mockRejectedValue("busy: a picker is already open");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onAttachError = vi.fn();
    render(<Harness onAttachError={onAttachError} />);
    const clicked = stubInputs();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose Files" }));
    await act(async () => {});
    expect(clicked).toEqual([]);
    expect(onAttachError).toHaveBeenCalledWith("Could not open the picker.");
    warn.mockRestore();
  });
});

/** Let the shell round trip finish (dynamic import + invoke) without
 *  touching the faked setTimeout (vi.waitFor would advance it). */
async function until(check: () => boolean) {
  const tick = () =>
    new Promise<void>((r) => (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate(r));
  for (let i = 0; i < 50 && !check(); i += 1) await act(async () => tick());
}

describe("AttachMenu: back from a picker on iOS (the keyboard)", () => {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  beforeEach(() => {
    w.__TAURI_INTERNALS__ = {};
    core.invoke.mockClear();
  });
  afterEach(() => {
    delete w.__TAURI_INTERNALS__;
    vi.useRealTimers();
  });
  /** The shell's UIKeyboardWill* (useViewportHeight re-dispatches it). */
  const keyboardWill = (show: boolean) =>
    act(() => {
      window.dispatchEvent(new CustomEvent("k2-keyboard-will", { detail: { show, active: true } }));
    });
  const allowCalls = () => core.invoke.mock.calls.filter(([c]) => c === "ios_keyboard_allow_focus").length;
  /** Photo Library, held open until `answer`. */
  function openLibrary() {
    picker.available.mockReturnValue(true);
    let answer!: (r: unknown) => void;
    picker.pick.mockReturnValue(new Promise((r) => (answer = r)));
    render(<Harness />);
    openMenu();
    expect(plus().hasAttribute("data-lit")).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Photo Library" }));
    return (r: unknown) => answer(r);
  }
  const cancelled = { files: [], skipped: [], cancelled: true };

  it("a cancelled Photo Library asks for the keyboard back, and rests (blurred) when none comes — the owner 2026-11-20", async () => {
    const answer = openLibrary();
    // The picker takes the screen and the keyboard (the shell's DidHide
    // resigns the field).
    keyboardWill(false);
    field().blur();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => answer(cancelled));
    expect(document.activeElement).toBe(field());
    expect(plus().hasAttribute("data-lit")).toBe(false);
    await until(() => allowCalls() === 1);
    expect(allowCalls()).toBe(1);
    // WebKit kept the caret and raised no keyboard: a focused field would
    // hold the composer's typing gap over the home indicator.
    act(() => {
      vi.advanceTimersByTime(KEYBOARD_RETURN_MS - 1);
    });
    expect(document.activeElement).toBe(field());
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.activeElement).not.toBe(field());
  });

  it("the keyboard coming back keeps the field focused", async () => {
    const answer = openLibrary();
    keyboardWill(false);
    field().blur();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => answer(cancelled));
    await until(() => allowCalls() === 1);
    expect(allowCalls()).toBe(1);
    keyboardWill(true);
    act(() => {
      vi.advanceTimersByTime(KEYBOARD_RETURN_MS * 2);
    });
    expect(document.activeElement).toBe(field());
  });

  it("a pick the keyboard never left for (hardware keyboard) is only refocused, never blurred", async () => {
    const answer = openLibrary();
    field().blur();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => answer(cancelled));
    await until(() => allowCalls() === 1);
    expect(allowCalls()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(KEYBOARD_RETURN_MS * 2);
    });
    expect(document.activeElement).toBe(field());
  });

  it("a cancelled camera (web input on iOS) does the same", async () => {
    picker.available.mockReturnValue(true);
    render(<Harness />);
    stubInputs();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Take Photo or Video" }));
    expect(plus().hasAttribute("data-lit")).toBe(false);
    keyboardWill(false);
    field().blur();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent(screen.getByTestId("composer-camera-input"), new Event("cancel"));
    expect(document.activeElement).toBe(field());
    await until(() => allowCalls() === 1);
    expect(allowCalls()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(KEYBOARD_RETURN_MS);
    });
    expect(document.activeElement).not.toBe(field());
  });

  it("Android / the web: a plain refocus, no keyboard request, no blur", async () => {
    picker.available.mockReturnValue(false);
    render(<Harness />);
    stubInputs();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose Files" }));
    keyboardWill(false);
    field().blur();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent(screen.getByTestId("composer-file-input"), new Event("cancel"));
    expect(document.activeElement).toBe(field());
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(KEYBOARD_RETURN_MS * 2);
    });
    expect(allowCalls()).toBe(0);
    expect(document.activeElement).toBe(field());
  });

  it("＋ unlights when its press ends somewhere else (a sheet took the screen)", () => {
    render(<Harness />);
    fireEvent.pointerDown(plus());
    expect(plus().hasAttribute("data-lit")).toBe(true);
    fireEvent.pointerUp(document.body);
    expect(plus().hasAttribute("data-lit")).toBe(false);
    fireEvent.pointerDown(plus());
    expect(plus().hasAttribute("data-lit")).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(plus().hasAttribute("data-lit")).toBe(false);
  });
});

describe("AttachMenu: motion", () => {
  it("animates from the ＋ corner and only fades under reduced motion", () => {
    expect(cssSrc).toMatch(/\.k2-attach-menu \{[^}]*animation: k2-attach-menu-in/);
    expect(cssSrc).toMatch(
      /prefers-reduced-motion: reduce\) \{\s*\.k2-attach-menu \{\s*animation: k2-fade-in/
    );
    expect(ATTACH_MENU_ITEMS).toHaveLength(3);
    expect(menuSrc).toContain('role="menuitem"');
  });
});

describe("AttachMenu: extra rows", () => {
  const stashRow = (onSelect = () => {}, disabled = false): AttachMenuExtra => ({
    key: "stash",
    label: "Save to stash",
    Icon: BookmarkPlusIcon,
    onSelect,
    disabled,
  });

  it("follow the attach choices under a hairline; a tap closes the menu, then runs, and the field keeps focus", () => {
    const onSelect = vi.fn(() => expect(menu()).not.toBeNull());
    render(<Harness menuExtras={[stashRow(onSelect)]} />);
    openMenu();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Photo Library",
      "Take Photo or Video",
      "Choose Files",
      "Save to stash",
    ]);
    expect(screen.getByRole("separator")).not.toBeNull();
    const row = screen.getByTestId("composer-menu-stash");
    expect(fireEvent.pointerDown(row)).toBe(false);
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(field());
  });

  it("a disabled row is dimmed and takes no tap", () => {
    const onSelect = vi.fn();
    render(<Harness menuExtras={[stashRow(onSelect, true)]} />);
    openMenu();
    const row = screen.getByTestId("composer-menu-stash") as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("with attaching off, ＋ still opens with only the extra rows", () => {
    render(<Harness attachDisabled menuExtras={[stashRow()]} />);
    expect((plus() as HTMLButtonElement).disabled).toBe(false);
    openMenu();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Save to stash"]);
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
