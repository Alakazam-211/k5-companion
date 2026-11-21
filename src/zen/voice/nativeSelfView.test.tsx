// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoHandle } from "@sew/voice";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  addPluginListener: vi.fn(async () => ({ unregister() {} })),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const ios = vi.hoisted(() => ({ on: true }));
vi.mock("../../lib/nativePicker", async (orig) => ({
  ...(await orig<typeof import("../../lib/nativePicker")>()),
  isIosWebView: () => ios.on,
}));

import {
  __setSelfViewOpsForTests,
  probeNativeSelfView,
  SELF_VIEW_POLL_MS,
  useNativeSelfView,
  useNativeSelfViewTile,
  type SelfCamera,
} from "./nativeSelfView";
import { HIDDEN, type TileFrame } from "./videoTile";
import { Self } from "./kit/KitCall";
import type { LayerVideo } from "./kit/layerVideo";

let frames: TileFrame[];
let told: [boolean, boolean][];
let answer: boolean | "reject";
let raf: Map<number, FrameRequestCallback>;
let nextRaf: number;
let rect: { left: number; top: number; width: number; height: number };

function runFrames() {
  act(() => {
    for (let i = 0; i < 10 && raf.size; i++) {
      const run = [...raf.values()];
      raf.clear();
      for (const cb of run) cb(0);
    }
  });
}
const lastFrame = () => frames[frames.length - 1];

beforeEach(() => {
  frames = [];
  told = [];
  answer = true;
  raf = new Map();
  nextRaf = 1;
  rect = { left: 20, top: 300, width: 160, height: 120 };
  ios.on = true;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextRaf++;
    raf.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void raf.delete(id));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  __setSelfViewOpsForTests({
    tell: async (tile, camera) => {
      told.push([tile, camera]);
      if (answer === "reject") throw new Error("no command");
      return answer;
    },
    frame: (f) => void frames.push(f),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __setSelfViewOpsForTests(null);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

function Box({ camera, covered = false }: { camera: SelfCamera; covered?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useNativeSelfViewTile(ref, { camera, covered, radius: 12 });
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) el.getBoundingClientRect = () => ({ ...rect, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
      }}
      data-testid="box"
    />
  );
}

describe("the self-view box's rect to Swift", () => {
  it("is sent on mount, then on scroll, resize and orientation, once per change", () => {
    render(<Box camera="on" />);
    runFrames();
    expect(lastFrame()).toEqual({ visible: true, x: 20, y: 300, w: 160, h: 120, radius: 12 });
    const n = frames.length;
    // Nothing moved: nothing new.
    act(() => void document.dispatchEvent(new Event("scroll")));
    runFrames();
    expect(frames.length).toBe(n);
    rect = { ...rect, top: 250 };
    act(() => void document.body.dispatchEvent(new Event("scroll")));
    runFrames();
    expect(lastFrame()).toMatchObject({ visible: true, y: 250 });
    rect = { ...rect, width: 200 };
    act(() => void window.dispatchEvent(new Event("resize")));
    runFrames();
    expect(lastFrame()).toMatchObject({ w: 200 });
    rect = { ...rect, left: 40 };
    act(() => void window.dispatchEvent(new Event("orientationchange")));
    runFrames();
    expect(lastFrame()).toMatchObject({ x: 40 });
  });

  it("follows a move no event reports, on the slow check", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render(<Box camera="on" />);
    runFrames();
    rect = { ...rect, top: 500 };
    act(() => void vi.advanceTimersByTime(SELF_VIEW_POLL_MS));
    runFrames();
    expect(lastFrame()).toMatchObject({ y: 500 });
  });

  it("hides while the camera is paused or off, something covers it, it's off screen, in the background, and once gone", () => {
    const { rerender, unmount } = render(<Box camera="on" />);
    runFrames();
    expect(lastFrame().visible).toBe(true);
    rerender(<Box camera="paused" />);
    expect(lastFrame()).toEqual(HIDDEN);
    rerender(<Box camera="on" />);
    runFrames();
    expect(lastFrame().visible).toBe(true);
    rerender(<Box camera="on" covered />);
    expect(lastFrame()).toEqual(HIDDEN);
    rerender(<Box camera="on" />);
    runFrames();
    expect(lastFrame().visible).toBe(true);
    // Scrolled out of the screen.
    rect = { ...rect, top: -400 };
    act(() => void document.dispatchEvent(new Event("scroll")));
    runFrames();
    expect(lastFrame()).toEqual(HIDDEN);
    rect = { ...rect, top: 300 };
    act(() => void document.dispatchEvent(new Event("scroll")));
    runFrames();
    expect(lastFrame().visible).toBe(true);
    // The background, and back.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    runFrames();
    expect(lastFrame()).toEqual(HIDDEN);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    runFrames();
    expect(lastFrame().visible).toBe(true);
    rerender(<Box camera="off" />);
    expect(lastFrame()).toEqual(HIDDEN);
    rerender(<Box camera="on" />);
    runFrames();
    unmount();
    expect(lastFrame()).toEqual(HIDDEN);
  });
});

describe("the tile and the camera to Rust", () => {
  it("says the tile shows while mounted, and whether the camera runs (paused counts)", () => {
    const { rerender, unmount } = render(<Box camera="on" />);
    expect(told).toEqual([[true, true]]);
    // Paused keeps the sink open: nothing new for Rust.
    rerender(<Box camera="paused" />);
    expect(told).toEqual([[true, true]]);
    rerender(<Box camera="off" />);
    expect(told).toEqual([
      [true, true],
      [true, false],
    ]);
    rerender(<Box camera="on" covered />);
    expect(told[told.length - 1]).toEqual([true, true]);
    unmount();
    expect(told[told.length - 1]).toEqual([false, false]);
  });
});

describe("whether this shell draws the self-view", () => {
  it("asks once on iOS, and takes Rust's answer", async () => {
    probeNativeSelfView();
    probeNativeSelfView();
    await act(async () => {});
    expect(told).toEqual([[false, false]]);
    expect(useNativeSelfView.getState().available).toBe(true);
  });

  it("stays off when Rust says no or the command isn't there", async () => {
    answer = false;
    probeNativeSelfView();
    await act(async () => {});
    expect(useNativeSelfView.getState().available).toBe(false);
    __setSelfViewOpsForTests({
      tell: async () => {
        throw new Error("unknown command");
      },
      frame: () => {},
    });
    probeNativeSelfView();
    await act(async () => {});
    expect(useNativeSelfView.getState().available).toBe(false);
  });

  it("never asks off iOS", async () => {
    ios.on = false;
    probeNativeSelfView();
    await act(async () => {});
    expect(told).toEqual([]);
    expect(useNativeSelfView.getState().available).toBe(false);
  });
});

describe("the call screen's own tile", () => {
  const video = (state: SelfCamera) =>
    ({ subscribe: () => () => {}, selfState: () => state }) as unknown as LayerVideo;
  const handle = () => {
    const h = { key: "local:camera", attach: vi.fn(), detach: vi.fn() };
    return h as VideoHandle & { attach: ReturnType<typeof vi.fn> };
  };

  it("keeps the kit's webview self-view without the native one", () => {
    const h = handle();
    render(<Self handle={h} video={video("on")} covered={false} />);
    expect(screen.getByTestId("voice-self-video")).toBeTruthy();
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("voice-self-view").dataset.native).toBeUndefined();
    expect(told).toEqual([]);
  });

  it("opens no webview sink when the native self-view is on: the box only, placed natively", () => {
    useNativeSelfView.setState({ available: true });
    const h = handle();
    render(<Self handle={h} video={video("on")} covered={false} />);
    expect(screen.queryByTestId("voice-self-video")).toBeNull();
    expect(h.attach).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-self-view").dataset.native).toBe("yes");
    expect(told).toEqual([[true, true]]);
  });

  it("says Camera paused in the box while the native view is hidden for it", () => {
    useNativeSelfView.setState({ available: true });
    render(<Self handle={handle()} video={video("paused")} covered={false} />);
    expect(screen.getByTestId("voice-self-view").dataset.paused).toBe("yes");
    expect(screen.getByTestId("voice-video-line").textContent).toBe("Camera paused");
    runFrames();
    expect(frames.every((f) => !f.visible)).toBe(true);
  });
});
