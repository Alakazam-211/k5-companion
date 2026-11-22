// @vitest-environment jsdom
// A channel's push level (K2 0.46.16): two choices, a pick shows at once and
// goes back on a refusal, read-only when fixed, the quiet note while All
// messages works like @mentions, and the `notify` frame keeping it in step.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  fetchHomeChatNotify: vi.fn(),
  setHomeChatNotify: vi.fn(),
  fetchHomeChatPushPrefs: vi.fn(),
  setHomeChatPushPrefs: vi.fn(),
}));
vi.mock("../../api/homeChat", () => ({ ...api, HOME_CHAT_PAGE_DEFAULT: 50, HOME_CHAT_PAGE_MAX: 100 }));

import { fakeScope } from "../../test/fakeScope";
import type { HomeChatNotify } from "../../api/homeChatPure";
import { HomeChatNotifySetting } from "./HomeChatNotifySetting";
import {
  NOTIFY_ALL_PENDING,
  NOTIFY_FIXED,
  NOTIFY_OFF_ELSEWHERE,
  __resetHomeChatNotifyForTests,
  applyHomeChatNotifyFrame,
  notifySettingView,
  refreshHomeChatPushPrefs,
  setHomeChatTextPref,
  useHomeChatNotify,
} from "./homeChatNotify";

const n = (over: Partial<HomeChatNotify> = {}): HomeChatNotify => ({
  conv: "902",
  convKind: "channel",
  level: "mentions",
  effective: "mentions",
  inherited: true,
  fixed: false,
  muted: false,
  allMessagesLive: true,
  ...over,
});
const refused = (code: string, hint: string, status = 409) => ({ ok: false, kind: "conflict", code, hint, status });

beforeEach(() => {
  __resetHomeChatNotifyForTests();
  for (const f of Object.values(api)) f.mockReset();
});
afterEach(() => cleanup());

describe("the view model", () => {
  it("two choices, the level checked", () => {
    const v = notifySettingView(n());
    expect(v.choices.map((c) => [c.label, c.checked])).toEqual([
      ["All messages", false],
      ["@mentions only", true],
    ]);
    expect(v.readOnly).toBe(false);
    expect(v.note).toBeNull();
  });

  it("All messages before the server can push every message: the note", () => {
    expect(notifySettingView(n({ level: "all", allMessagesLive: false })).note).toBe(NOTIFY_ALL_PENDING);
    expect(notifySettingView(n({ level: "mentions", allMessagesLive: false })).note).toBeNull();
  });

  it("fixed is read-only; none set elsewhere checks neither", () => {
    expect(notifySettingView(n({ fixed: true })).readOnly).toBe(true);
    expect(notifySettingView(n({ fixed: true })).note).toBe(NOTIFY_FIXED);
    const off = notifySettingView(n({ level: "none" }));
    expect(off.choices.every((c) => !c.checked)).toBe(true);
    expect(off.note).toBe(NOTIFY_OFF_ELSEWHERE);
  });

  it("still reading: nothing checked", () => {
    expect(notifySettingView(null).choices.some((c) => c.checked)).toBe(false);
  });
});

describe("HomeChatNotifySetting", () => {
  const scope = fakeScope({ id: "s1" });

  it("reads the level, then a pick shows at once and saves", async () => {
    api.fetchHomeChatNotify.mockResolvedValue({ ok: true, notify: n() });
    let done: (v: unknown) => void = () => {};
    api.setHomeChatNotify.mockReturnValue(new Promise((r) => (done = r)));
    render(<HomeChatNotifySetting scope={scope} conv="902" />);
    await waitFor(() => expect(screen.getByTestId("home-chat-notify-mentions").getAttribute("aria-checked")).toBe("true"));
    expect(api.fetchHomeChatNotify).toHaveBeenCalledWith(scope, "902");
    fireEvent.click(screen.getByTestId("home-chat-notify-all"));
    expect(screen.getByTestId("home-chat-notify-all").getAttribute("aria-checked")).toBe("true");
    expect(api.setHomeChatNotify).toHaveBeenCalledWith(scope, "902", "all");
    await act(async () => done({ ok: true, notify: n({ level: "all", effective: "all", inherited: false }) }));
    expect(screen.getByTestId("home-chat-notify-all").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("home-chat-notify-error")).toBeNull();
  });

  it("a refusal puts the last level back, with the server's words", async () => {
    api.fetchHomeChatNotify.mockResolvedValue({ ok: true, notify: n() });
    api.setHomeChatNotify.mockResolvedValue(refused("not_a_member", "You're not in this channel", 422));
    render(<HomeChatNotifySetting scope={scope} conv="902" />);
    await waitFor(() => expect(screen.getByTestId("home-chat-notify-mentions").getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByTestId("home-chat-notify-all"));
    await waitFor(() => expect(screen.getByTestId("home-chat-notify-error").textContent).toBe("You're not in this channel"));
    expect(screen.getByTestId("home-chat-notify-mentions").getAttribute("aria-checked")).toBe("true");
  });

  it("All messages while it isn't live yet says so", async () => {
    api.fetchHomeChatNotify.mockResolvedValue({ ok: true, notify: n({ level: "all", allMessagesLive: false }) });
    render(<HomeChatNotifySetting scope={scope} conv="902" />);
    await waitFor(() => expect(screen.getByTestId("home-chat-notify-note").textContent).toBe(NOTIFY_ALL_PENDING));
  });

  it("fixed: read-only, nothing sent", async () => {
    api.fetchHomeChatNotify.mockResolvedValue({ ok: true, notify: n({ fixed: true }) });
    render(<HomeChatNotifySetting scope={scope} conv="902" />);
    await waitFor(() => expect(screen.getByTestId("home-chat-notify-all").hasAttribute("disabled")).toBe(true));
    fireEvent.click(screen.getByTestId("home-chat-notify-all"));
    expect(api.setHomeChatNotify).not.toHaveBeenCalled();
  });

  it("a DM's answer draws nothing (DMs always notify)", async () => {
    api.fetchHomeChatNotify.mockResolvedValue({ ok: true, notify: n({ convKind: "dm", fixed: true, level: "all" }) });
    render(<HomeChatNotifySetting scope={scope} conv="901" />);
    await waitFor(() => expect(api.fetchHomeChatNotify).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("home-chat-notify")).toBeNull());
  });

  it("the notify frame from another device moves it", async () => {
    api.fetchHomeChatNotify.mockResolvedValue({ ok: true, notify: n() });
    render(<HomeChatNotifySetting scope={scope} conv="902" />);
    await waitFor(() => expect(screen.getByTestId("home-chat-notify-mentions").getAttribute("aria-checked")).toBe("true"));
    act(() => applyHomeChatNotifyFrame("s1", { conv: "902", level: "all", effective: "all", inherited: false, muted: false }));
    expect(screen.getByTestId("home-chat-notify-all").getAttribute("aria-checked")).toBe("true");
    // Another server's frame for the same channel id: not this one.
    act(() => applyHomeChatNotifyFrame("s2", { conv: "902", level: "mentions", effective: "mentions", inherited: false, muted: false }));
    expect(screen.getByTestId("home-chat-notify-all").getAttribute("aria-checked")).toBe("true");
  });
});

describe("Show message text", () => {
  const scope = fakeScope({ id: "s1" });
  const prefs = { on: true, previews: true, agents: false, serverPreviews: true, bell: true, devices: 1, allMessagesLive: false };

  it("reads, then flips at once and back on a refusal", async () => {
    api.fetchHomeChatPushPrefs.mockResolvedValue({ ok: true, prefs });
    expect(await refreshHomeChatPushPrefs(scope)).toBeNull();
    expect(useHomeChatNotify.getState().prefs.s1?.previews).toBe(true);
    let done: (v: unknown) => void = () => {};
    api.setHomeChatPushPrefs.mockReturnValue(new Promise((r) => (done = r)));
    const p = setHomeChatTextPref(scope, false);
    expect(useHomeChatNotify.getState().prefs.s1?.previews).toBe(false);
    expect(api.setHomeChatPushPrefs).toHaveBeenCalledWith(scope, { previews: false });
    done({ ok: false, kind: "server", code: "chat_unavailable", hint: "Chat isn't reachable", status: 503 });
    expect(await p).toBe("Chat isn't reachable");
    expect(useHomeChatNotify.getState().prefs.s1?.previews).toBe(true);
  });
});
