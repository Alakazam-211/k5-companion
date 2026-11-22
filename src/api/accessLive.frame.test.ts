import { describe, expect, it } from "vitest";
import { isAccessChangedFrame } from "./accessLive";

describe("isAccessChangedFrame (K2 0.46.17)", () => {
  it("takes sessions/events' kind and the Home chat socket's type", () => {
    expect(isAccessChangedFrame({ kind: "access_changed" })).toBe(true);
    expect(isAccessChangedFrame({ type: "access_changed" })).toBe(true);
    expect(isAccessChangedFrame({ type: "access_changed", extra: 1 })).toBe(true);
  });
  it("ignores other frames", () => {
    expect(isAccessChangedFrame({ type: "message" })).toBe(false);
    expect(isAccessChangedFrame({ kind: "thread_message" })).toBe(false);
    expect(isAccessChangedFrame(null)).toBe(false);
    expect(isAccessChangedFrame("access_changed")).toBe(false);
  });
});
