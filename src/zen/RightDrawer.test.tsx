// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  DRAWER_CLOSED_TRANSFORM,
  DRAWER_CLOSE_MS,
  DRAWER_DRAG_TRANSFORM,
  DRAWER_FADE_MS,
  DRAWER_OPEN_TRANSFORM,
  DRAWER_WIDTH,
  RightDrawer,
  drawerUnmountMs,
} from "./RightDrawer";
import { CHATTER_TRANSITION } from "./chatterSwipe";
import { useFileDrag } from "./fileDrag";

function Harness({ initial = false, dragging = false }: { initial?: boolean; dragging?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div>
      <button type="button" data-testid="toggle" onClick={() => setOpen((v) => !v)}>
        Toggle
      </button>
      <RightDrawer
        open={open}
        label="Sessions"
        testId="drawer"
        onClose={() => setOpen(false)}
        closeSelector='[data-testid="drawer-close"]'
        returnFocusSelector='[data-testid="toggle"]'
        dragging={dragging}
      >
        <button type="button" data-testid="drawer-close" onClick={() => setOpen(false)}>
          Close
        </button>
        <div data-testid="drawer-body">rows</div>
      </RightDrawer>
    </div>
  );
}

const at = (x: number, y = 300) => ({
  touches: [{ clientX: x, clientY: y }],
  changedTouches: [{ clientX: x, clientY: y }],
});

function reduceMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: on && q.includes("prefers-reduced-motion"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useFileDrag.setState({ drag: null } as never);
  // jsdom has no matchMedia of its own.
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("RightDrawer", () => {
  it("is a modal dialog with its name, floating 8px in, one width for both drawers", () => {
    render(<Harness initial />);
    const dialog = screen.getByRole("dialog", { name: "Sessions" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("data-testid")).toBe("drawer");
    expect(dialog.className).toMatch(/k2-tile/);
    expect(dialog.className).toMatch(/k2-drawer/);
    expect(dialog.style.right).toBe("8px");
    // jsdom drops min()/env() values it cannot parse; the width is one
    // value for both drawers.
    expect(DRAWER_WIDTH).toBe("min(240px, calc(100vw - 72px))");
    expect(dialog.style.zIndex).toBe("15");
  });

  it("slides in with Chatter's curve over a scrim under it (z 14)", () => {
    render(<Harness initial />);
    const dialog = screen.getByTestId("drawer");
    expect(dialog.getAttribute("data-state")).toBe("open");
    expect(dialog.style.transform).toBe(DRAWER_OPEN_TRANSFORM);
    expect(dialog.style.transition).toContain(CHATTER_TRANSITION);
    const scrim = screen.getByTestId("drawer-scrim");
    expect(scrim.className).toMatch(/k2-drawer-scrim/);
    expect(scrim.style.zIndex).toBe("14");
    expect(scrim.style.opacity).toBe("1");
    expect(scrim.style.pointerEvents).toBe("");
  });

  it("a tap on the scrim closes it", () => {
    render(<Harness initial />);
    fireEvent.click(screen.getByTestId("drawer-scrim"));
    expect(screen.getByTestId("drawer").getAttribute("data-state")).toBe("closing");
  });

  it("stays mounted until the closing slide ends, then unmounts", () => {
    vi.useFakeTimers();
    render(<Harness initial />);
    fireEvent.click(screen.getByTestId("drawer-close"));
    const dialog = screen.getByTestId("drawer");
    expect(dialog.getAttribute("data-state")).toBe("closing");
    expect(dialog.style.transform).toBe(DRAWER_CLOSED_TRANSFORM);
    expect(dialog.style.transition).toContain(`transform ${DRAWER_CLOSE_MS}ms`);
    expect(dialog.getAttribute("aria-hidden")).toBe("true");
    expect(dialog.style.pointerEvents).toBe("none");
    expect(screen.getByTestId("drawer-scrim").style.opacity).toBe("0");
    act(() => {
      vi.advanceTimersByTime(DRAWER_CLOSE_MS);
    });
    expect(screen.getByTestId("drawer")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(drawerUnmountMs(false) - DRAWER_CLOSE_MS);
    });
    expect(screen.queryByTestId("drawer")).toBeNull();
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
  });

  it("reopening during the slide keeps the same drawer", () => {
    vi.useFakeTimers();
    render(<Harness initial />);
    const body = screen.getByTestId("drawer-body");
    fireEvent.click(screen.getByTestId("drawer-close"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(screen.getByTestId("toggle"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("drawer-body")).toBe(body);
    expect(screen.getByTestId("drawer").getAttribute("data-state")).toBe("open");
  });

  it("focuses its close button on open and gives focus back to the toggle on close", () => {
    render(<Harness />);
    const toggle = screen.getByTestId("toggle");
    toggle.focus();
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(screen.getByTestId("drawer-close"));
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(document.activeElement).toBe(toggle);
  });

  it("while a file drags out: moves aside, fades, and the scrim lets touches through", () => {
    render(<Harness initial dragging />);
    const dialog = screen.getByTestId("drawer");
    expect(dialog.getAttribute("data-dragging")).toBe("1");
    expect(dialog.style.transform).toBe(DRAWER_DRAG_TRANSFORM);
    expect(dialog.style.opacity).toBe("0.4");
    const scrim = screen.getByTestId("drawer-scrim");
    expect(scrim.style.opacity).toBe("0");
    expect(scrim.style.pointerEvents).toBe("none");
  });

  it("Reduce Motion: no slide, a short fade", () => {
    reduceMotion(true);
    render(<Harness initial />);
    const dialog = screen.getByTestId("drawer");
    expect(dialog.style.transform).toBe("none");
    expect(dialog.style.transition).toBe(`opacity ${DRAWER_FADE_MS}ms ease`);
    expect(dialog.style.opacity).toBe("1");
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(dialog.style.opacity).toBe("0");
    expect(dialog.style.transform).toBe("none");
    act(() => {
      vi.advanceTimersByTime(drawerUnmountMs(true));
    });
    expect(screen.queryByTestId("drawer")).toBeNull();
  });

  it("a rightward swipe on it closes it; a vertical one is the list's", () => {
    render(<Harness initial />);
    const dialog = screen.getByTestId("drawer");
    const body = screen.getByTestId("drawer-body");
    // Vertical: not taken.
    act(() => {
      fireEvent.touchStart(body, at(100, 300));
      expect(fireEvent.touchMove(body, at(102, 360))).toBe(true);
      fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 102, clientY: 360 }] });
    });
    expect(dialog.getAttribute("data-state")).toBe("open");
    // Rightward, far: the drawer follows, then closes.
    act(() => {
      fireEvent.touchStart(body, at(100));
      expect(fireEvent.touchMove(body, at(130))).toBe(false);
      fireEvent.touchMove(body, at(600));
      fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 600, clientY: 300 }] });
    });
    expect(dialog.getAttribute("data-state")).toBe("closing");
  });

  it("does not swipe while a file is being dragged", () => {
    render(<Harness initial />);
    const body = screen.getByTestId("drawer-body");
    useFileDrag.setState({ drag: { name: "a.ts", path: "/w/a.ts", x: 0, y: 0 } } as never);
    act(() => {
      fireEvent.touchStart(body, at(100));
      expect(fireEvent.touchMove(body, at(130))).toBe(true);
      fireEvent.touchMove(body, at(600));
      fireEvent.touchEnd(body, { touches: [], changedTouches: [{ clientX: 600, clientY: 300 }] });
    });
    expect(screen.getByTestId("drawer").getAttribute("data-state")).toBe("open");
  });
});
