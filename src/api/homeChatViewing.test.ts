// The viewing lease (K2 0.46.16): now, every 30 s, visible:false on leave,
// again at once on a reopened socket.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIEWING_LEASE_REPEAT_MS, createViewingLease, viewingFrame } from "./homeChatViewing";

let sent: unknown[] = [];
let open = true;
const lease = () =>
  createViewingLease({
    send: (t) => {
      if (!open) return false;
      sent.push(JSON.parse(t));
      return true;
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
  });

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  open = true;
});
afterEach(() => vi.useRealTimers());

describe("viewing lease", () => {
  it("frames are the daemon's shape", () => {
    expect(JSON.parse(viewingFrame("901", true))).toEqual({ t: "viewing", conv: "901", visible: true });
  });

  it("sends at once, then every 30 s while held", () => {
    const l = lease();
    l.set("901");
    expect(sent).toEqual([{ t: "viewing", conv: "901", visible: true }]);
    vi.advanceTimersByTime(VIEWING_LEASE_REPEAT_MS - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(VIEWING_LEASE_REPEAT_MS * 2);
    expect(sent).toHaveLength(4);
    expect(l.current()).toBe("901");
  });

  it("leaving says visible:false once and stops the timer", () => {
    const l = lease();
    l.set("901");
    l.set(null);
    expect(sent).toEqual([
      { t: "viewing", conv: "901", visible: true },
      { t: "viewing", conv: "901", visible: false },
    ]);
    vi.advanceTimersByTime(VIEWING_LEASE_REPEAT_MS * 3);
    expect(sent).toHaveLength(2);
    l.stop();
    expect(sent).toHaveLength(2);
  });

  it("another chat ends the last one first", () => {
    const l = lease();
    l.set("901");
    l.set("902");
    expect(sent.slice(1)).toEqual([
      { t: "viewing", conv: "901", visible: false },
      { t: "viewing", conv: "902", visible: true },
    ]);
    vi.advanceTimersByTime(VIEWING_LEASE_REPEAT_MS);
    expect(sent[sent.length - 1]).toEqual({ t: "viewing", conv: "902", visible: true });
  });

  it("the same chat again sends nothing new", () => {
    const l = lease();
    l.set("901");
    l.set("901");
    expect(sent).toHaveLength(1);
  });

  it("a reopened socket gets the lease again at once (the daemon dropped it)", () => {
    const l = lease();
    open = false;
    l.set("901");
    expect(sent).toHaveLength(0);
    open = true;
    l.linked();
    expect(sent).toEqual([{ t: "viewing", conv: "901", visible: true }]);
    vi.advanceTimersByTime(VIEWING_LEASE_REPEAT_MS);
    expect(sent).toHaveLength(2);
  });

  it("linked with no chat sends nothing; stop ends it", () => {
    const l = lease();
    l.linked();
    expect(sent).toHaveLength(0);
    l.set("901");
    l.stop();
    expect(sent[sent.length - 1]).toEqual({ t: "viewing", conv: "901", visible: false });
    expect(l.current()).toBeNull();
    vi.advanceTimersByTime(VIEWING_LEASE_REPEAT_MS * 2);
    expect(sent).toHaveLength(2);
  });
});
