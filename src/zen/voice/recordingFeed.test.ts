// The call's event feed (K2 0.46.17): Sew's perms_changed re-reads the
// recording rights; a refusal falls back to today's reads with one line.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEED_PERMS_DEBOUNCE_MS,
  parseFeedEvent,
  permsConcernCall,
  startRecordingFeed,
  type FeedDeps,
} from "./recordingFeed";

function harness(over: Partial<FeedDeps> = {}) {
  let push: (p: unknown) => void = () => {};
  let n = 0;
  const notes: string[] = [];
  const deps: FeedDeps = {
    open: vi.fn(async () => ++n),
    close: vi.fn(),
    listen: vi.fn(async (fn) => {
      push = fn;
      return () => {
        push = () => {};
      };
    }),
    note: (w) => void notes.push(w.join(" ")),
    revive: vi.fn(async () => "still-valid" as const),
    signin: vi.fn(),
    ...over,
  };
  return { deps, notes, send: (p: Record<string, unknown>) => push({ server: "s1", n, ...p }), opened: () => n };
}

/** Fire what is due and let the open's promise chain finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("perms_changed", () => {
  it("for the call's channel: one rights re-read per burst, and a call-log line", async () => {
    const h = harness();
    const onPerms = vi.fn();
    const feed = startRecordingFeed("s1", onPerms, h.deps);
    await settle();
    expect(h.deps.open).toHaveBeenCalledWith("s1");
    h.send({ kind: "open" });
    h.send({ kind: "ready", channel: "42", space: "5" });
    h.send({ kind: "perms", channels: ["42"], space: "5" });
    h.send({ kind: "perms", channels: ["42"], space: null });
    vi.advanceTimersByTime(FEED_PERMS_DEBOUNCE_MS);
    expect(onPerms).toHaveBeenCalledTimes(1);
    expect(h.notes).toContain("recording perms_changed");
    feed.stop();
    expect(h.deps.close).toHaveBeenCalled();
  });

  it("another room's change is not the call's; the call's space is", async () => {
    const h = harness();
    const onPerms = vi.fn();
    const feed = startRecordingFeed("s1", onPerms, h.deps);
    await settle();
    h.send({ kind: "ready", channel: "42", space: "5" });
    h.send({ kind: "perms", channels: ["99"], space: "6" });
    vi.advanceTimersByTime(FEED_PERMS_DEBOUNCE_MS);
    expect(onPerms).not.toHaveBeenCalled();
    h.send({ kind: "mine", channel: "43", space: "5" });
    h.send({ kind: "perms", channels: [], space: "5" });
    vi.advanceTimersByTime(FEED_PERMS_DEBOUNCE_MS);
    expect(onPerms).toHaveBeenCalledTimes(1);
    feed.stop();
  });

  it("drops another server's events and a closed feed's late ones", async () => {
    const h = harness();
    const onPerms = vi.fn();
    const feed = startRecordingFeed("s1", onPerms, h.deps);
    await settle();
    h.send({ kind: "perms", channels: ["42"], server: "s2" });
    h.send({ kind: "perms", channels: ["42"], n: 99 });
    vi.advanceTimersByTime(FEED_PERMS_DEBOUNCE_MS);
    expect(onPerms).not.toHaveBeenCalled();
    feed.stop();
  });

  it("events that beat the open's answer still count", async () => {
    let push: (p: unknown) => void = () => {};
    const h = harness({
      listen: vi.fn(async (fn) => {
        push = fn;
        return () => {};
      }),
      open: vi.fn(async () => {
        push({ server: "s1", n: 7, kind: "refused", code: 404 });
        return 7;
      }),
    });
    const feed = startRecordingFeed("s1", vi.fn(), h.deps);
    await settle();
    expect(h.notes).toContain("recording feed unavailable 404");
    feed.stop();
  });
});

describe("refusals and closes", () => {
  it.each([403, 404])("%i: one 'recording feed unavailable' line, no retry", async (code) => {
    const h = harness();
    const feed = startRecordingFeed("s1", vi.fn(), h.deps);
    await settle();
    h.send({ kind: "refused", code });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.notes).toEqual([`recording feed unavailable ${code}`]);
    expect(h.deps.open).toHaveBeenCalledTimes(1);
    feed.stop();
  });

  it("4000 reset reconnects at once; the READY after it re-reads the rights", async () => {
    const h = harness();
    const onPerms = vi.fn();
    const feed = startRecordingFeed("s1", onPerms, h.deps);
    await settle();
    h.send({ kind: "ready", channel: "42", space: "5" });
    h.send({ kind: "closed", code: 4000 });
    await settle();
    expect(h.deps.open).toHaveBeenCalledTimes(2);
    h.send({ kind: "ready", channel: "42", space: "5" });
    vi.advanceTimersByTime(FEED_PERMS_DEBOUNCE_MS);
    expect(onPerms).toHaveBeenCalledTimes(1);
    feed.stop();
  });

  it("4001 login ended: whoami, Sign in again when dead, no reconnect", async () => {
    const h = harness({ revive: vi.fn(async () => "signin-required" as const) });
    const feed = startRecordingFeed("s1", vi.fn(), h.deps);
    await settle();
    h.send({ kind: "closed", code: 4001 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.revive).toHaveBeenCalledWith("s1");
    expect(h.deps.signin).toHaveBeenCalledWith("s1");
    expect(h.deps.open).toHaveBeenCalledTimes(1);
    feed.stop();
  });

  it("a drop reconnects with backoff while the call lasts", async () => {
    const h = harness();
    const feed = startRecordingFeed("s1", vi.fn(), h.deps);
    await settle();
    h.send({ kind: "closed", code: 1006 });
    await vi.advanceTimersByTimeAsync(999);
    expect(h.deps.open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.deps.open).toHaveBeenCalledTimes(2);
    feed.stop();
    h.send({ kind: "closed", code: 1006 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.open).toHaveBeenCalledTimes(2);
  });

  it("no native feed (off iOS, no token): nothing at all", async () => {
    const h = harness({ open: vi.fn(async () => null) });
    const feed = startRecordingFeed("s1", vi.fn(), h.deps);
    await settle();
    feed.stop();
    expect(h.deps.close).not.toHaveBeenCalled();
    expect(h.notes).toEqual([]);
  });
});

describe("pure", () => {
  it("parses the native events", () => {
    expect(parseFeedEvent({ server: "s1", n: 1, kind: "perms", channels: ["1", 2], space: "5" })).toEqual({
      server: "s1",
      n: 1,
      kind: "perms",
      channels: ["1"],
      space: "5",
    });
    expect(parseFeedEvent({ server: "s1", n: 1, kind: "closed", code: 4000 })).toMatchObject({ code: 4000 });
    expect(parseFeedEvent({ server: "s1", kind: "open" })).toBeNull();
    expect(parseFeedEvent({ server: "s1", n: 1, kind: "nope" })).toBeNull();
  });

  it("where the phone is not known yet, every change counts", () => {
    expect(permsConcernCall({ channels: [], space: "5" }, { channel: null, space: null })).toBe(true);
    expect(permsConcernCall({ channels: ["1"], space: null }, { channel: "2", space: null })).toBe(false);
  });
});
