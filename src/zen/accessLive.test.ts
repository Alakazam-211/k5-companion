// K2 0.46.17 live access: `access_changed` → one re-read per burst (both
// sockets send a copy); 4003 → whoami, then "Sign in again" and no
// reconnect loop.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reviveMock, fetchMock } = vi.hoisted(() => ({
  reviveMock: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));
vi.mock("../lib/revive", async (orig) => ({ ...(await orig<typeof import("../lib/revive")>()), revive: reviveMock }));
vi.mock("../api/scopedFetch", async (orig) => ({
  ...(await orig<typeof import("../api/scopedFetch")>()),
  scopedFetch: fetchMock,
}));

import { fakeScope } from "../test/fakeScope";
import {
  ACCESS_DEBOUNCE_MS,
  __resetAccessLiveForTests,
  noteAccessChanged,
  revokedVerdict,
} from "../api/accessLive";
import { onServerSignal, type ServerSignal } from "../api/serverSignals";
import { useServersStore, type ServerEntry } from "../stores/servers";
import { hubState, subscribeAppEvents } from "./ticketEvents";
import { rereadAccess, wireAccessLive, type AccessRereads } from "./accessLive";

class MockWS {
  static instances: MockWS[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let signals: Array<[string, ServerSignal]> = [];
let offSignals: () => void = () => {};

function fakeRereads(): AccessRereads & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    recheck: (id) => void calls.push(`whoami:${id}`),
    identity: (s) => void calls.push(`identity:${s.id}`),
    chatGate: (s) => void calls.push(`chat:${s.id}`),
    scopeOf: (id) => fakeScope({ id }),
  };
}

beforeEach(() => {
  MockWS.instances = [];
  vi.stubGlobal("WebSocket", MockWS);
  vi.useFakeTimers();
  reviveMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ status: 0, ok: false, text: "" });
  signals = [];
  offSignals = onServerSignal((id, s) => void signals.push([id, s]));
  useServersStore.setState({
    hydrated: true,
    servers: [{ id: "host", nickname: "Host", url: "https://host.k2.dev", username: "u", rememberPassword: false } as ServerEntry],
    tokens: { host: "tok" },
    recovery: { host: "connected" },
  });
});
afterEach(() => {
  offSignals();
  __resetAccessLiveForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("access_changed", () => {
  it("one frame on each socket (two copies) is ONE whoami re-read", async () => {
    const rereads = fakeRereads();
    const off = wireAccessLive(rereads);
    const h = subscribeAppEvents(fakeScope({ id: "host", base: "https://host.k2.dev" }), () => false, vi.fn());
    const ws = MockWS.instances[0];
    ws.onopen?.();
    ws.deliver({ kind: "access_changed" });
    // The other socket's copy (the Home chat socket routes it the same way).
    noteAccessChanged("host");
    vi.advanceTimersByTime(ACCESS_DEBOUNCE_MS - 1);
    expect(rereads.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(signals.filter(([, s]) => s === "access")).toEqual([["host", "access"]]);
    expect(rereads.calls).toEqual(["whoami:host", "identity:host", "chat:host"]);
    // A later change is a new re-read.
    ws.deliver({ kind: "access_changed" });
    vi.advanceTimersByTime(ACCESS_DEBOUNCE_MS);
    expect(rereads.calls.filter((c) => c.startsWith("whoami"))).toHaveLength(2);
    h.stop();
    off();
  });

  it("the frame still reaches its own subscribers (the call's recording re-read)", () => {
    const onChange = vi.fn();
    const h = subscribeAppEvents(
      fakeScope({ id: "host", base: "https://host.k2.dev" }),
      (f) => (f as { kind?: string }).kind === "access_changed",
      onChange
    );
    MockWS.instances[0].onopen?.();
    MockWS.instances[0].deliver({ kind: "access_changed" });
    vi.advanceTimersByTime(ACCESS_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("a removed server re-reads nothing but the pool", () => {
    const rereads = fakeRereads();
    rereadAccess("gone", {
      ...rereads,
      scopeOf: () => {
        const s = fakeScope({ id: "gone" });
        s.remove();
        return s;
      },
    });
    expect(rereads.calls).toEqual(["whoami:gone"]);
  });
});

describe("close 4003", () => {
  const scope = () => fakeScope({ id: "host", base: "https://host.k2.dev" });

  it("a dead login: no reconnect, the server says Sign in again", async () => {
    reviveMock.mockResolvedValue("signin-required");
    const h = subscribeAppEvents(scope(), () => false, vi.fn());
    MockWS.instances[0].onopen?.();
    MockWS.instances[0].onclose?.({ code: 4003 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reviveMock).toHaveBeenCalledTimes(1);
    expect(MockWS.instances).toHaveLength(1);
    expect(hubState("host")).toBe("none");
    expect(signals).toContainEqual(["host", "signin"]);
    expect(useServersStore.getState().recovery.host).toBe("signin-required");
    h.stop();
  });

  it("a disabled account (a 403 whoami could not explain): signed out, no loop", async () => {
    reviveMock.mockResolvedValue("unreachable");
    fetchMock.mockResolvedValue({ status: 403, ok: false, text: '{"error":"account_disabled"}' });
    const h = subscribeAppEvents(scope(), () => false, vi.fn());
    MockWS.instances[0].onopen?.();
    MockWS.instances[0].onclose?.({ code: 4003 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledWith(expect.anything(), "/cli/auth/whoami", expect.objectContaining({ revive: false }));
    expect(MockWS.instances).toHaveLength(1);
    expect(signals).toContainEqual(["host", "signin"]);
    expect(useServersStore.getState().recovery.host).toBe("signin-required");
    h.stop();
  });

  it("a login that still stands reconnects once; a second 4003 stops the hub", async () => {
    reviveMock.mockResolvedValue("still-valid");
    const h = subscribeAppEvents(scope(), () => false, vi.fn());
    MockWS.instances[0].onopen?.();
    MockWS.instances[0].onclose?.({ code: 4003 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(MockWS.instances).toHaveLength(2);
    MockWS.instances[1].onopen?.();
    MockWS.instances[1].onclose?.({ code: 4003 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWS.instances).toHaveLength(2);
    expect(hubState("host")).toBe("none");
    expect(signals).not.toContainEqual(["host", "signin"]);
    h.stop();
  });

  it("whoami unreachable (a network blip): reconnect with backoff", async () => {
    reviveMock.mockResolvedValue("unreachable");
    fetchMock.mockRejectedValue(new Error("offline"));
    const h = subscribeAppEvents(scope(), () => false, vi.fn());
    MockWS.instances[0].onopen?.();
    MockWS.instances[0].onclose?.({ code: 4003 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(MockWS.instances).toHaveLength(2);
    expect(signals).not.toContainEqual(["host", "signin"]);
    h.stop();
  });
});

describe("revokedVerdict", () => {
  const one = { repeat: false, paired: false };
  it("follows whoami", () => {
    expect(revokedVerdict("signin-required", null, one)).toBe("signed-out");
    expect(revokedVerdict("not-applicable", null, one)).toBe("signed-out");
    expect(revokedVerdict("still-valid", null, one)).toBe("reconnect");
    expect(revokedVerdict("still-valid", null, { ...one, repeat: true })).toBe("stop");
    expect(revokedVerdict("unreachable", null, one)).toBe("reconnect");
    expect(revokedVerdict("cooldown", { status: 401, text: "" }, one)).toBe("signed-out");
    expect(revokedVerdict("unreachable", { status: 403, text: '{"error":"role_required"}' }, one)).toBe("signed-out");
    expect(revokedVerdict("unreachable", { status: 500, text: "" }, one)).toBe("reconnect");
  });
  it("a paired phone's 401 is a blip; a temporary password is not a sign-out", () => {
    expect(revokedVerdict("unreachable", { status: 401, text: "" }, { repeat: false, paired: true })).toBe("reconnect");
    expect(revokedVerdict("unreachable", { status: 403, text: '{"error":"password_change_required"}' }, one)).toBe(
      "reconnect"
    );
  });
});
