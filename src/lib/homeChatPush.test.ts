// Home chat pushes' pure rules (K2 0.46.16): the notification group the NSE
// sets, the read hints and the id compare K2DeliveredClear.swift keeps, the
// clear plan, and a tap's chat.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ ok: true })), isTauri: () => false }));

import {
  homeChatServerKey,
  homeChatTapTarget,
  homeChatThreadId,
  homeClearPlan,
  homeNoteCovered,
  parseReadHints,
  setNativeHomeChatViewing,
} from "./homeChatPush";

describe("the notification group", () => {
  const base = { kind: "home_chat", conversationId: "901", badgeKey: "bk-1", k2ServerId: "srv-a", subdomain: "Alice", instanceId: "a1b2" };

  it("is hc:<server>:<conversation>, by the stable badgeKey first", () => {
    expect(homeChatThreadId(base)).toBe("hc:bk-1:901");
  });

  it("falls back to the saved server, the label, then the instance id", () => {
    expect(homeChatServerKey({ ...base, badgeKey: "" })).toBe("srv-a");
    expect(homeChatServerKey({ ...base, badgeKey: "", k2ServerId: "" })).toBe("alice");
    expect(homeChatServerKey({ instanceId: "a1b2" })).toBe("a1b2");
    expect(homeChatServerKey({})).toBeNull();
  });

  it("the same channel id on two servers never merges", () => {
    expect(homeChatThreadId({ ...base, badgeKey: "bk-1" })).not.toBe(homeChatThreadId({ ...base, badgeKey: "bk-2" }));
  });

  it("none for the generic lane, another kind or a bad id", () => {
    expect(homeChatThreadId({ kind: "home_chat", badgeKey: "bk-1" })).toBeNull();
    expect(homeChatThreadId({ ...base, kind: "thread" })).toBeNull();
    expect(homeChatThreadId({ ...base, conversationId: "c-1" })).toBeNull();
  });
});

describe("read hints", () => {
  it("parse t:, p: and h: (K2's wire)", () => {
    expect(parseReadHints("t:c-77:418,p:pg-9:7,h:901:880011")).toEqual([
      { kind: "thread", id: "c-77", upTo: "418" },
      { kind: "project", id: "pg-9", upTo: "7" },
      { kind: "home", id: "901", upTo: "880011" },
    ]);
  });

  it("drop junk", () => {
    expect(parseReadHints("h::5,h:901:x,q:1:2,h:901,,h:901:123456789012345678901")).toEqual([]);
    expect(parseReadHints(undefined)).toEqual([]);
  });

  it("compare Sew ids as numbers, past 2^53 too", () => {
    expect(homeNoteCovered("880011", "880011")).toBe(true);
    expect(homeNoteCovered("880010", "880011")).toBe(true);
    expect(homeNoteCovered("880012", "880011")).toBe(false);
    // Not as strings: "99" < "100".
    expect(homeNoteCovered("99", "100")).toBe(true);
    expect(homeNoteCovered("100", "99")).toBe(false);
    // As doubles these two are equal; as numbers they are not.
    expect(homeNoteCovered("9007199254740993", "9007199254740992")).toBe(false);
    expect(homeNoteCovered("9007199254740992", "9007199254740993")).toBe(true);
    expect(homeNoteCovered("007", "7")).toBe(true);
  });

  it("a note with no message id (the generic lane) is never read by a hint", () => {
    expect(homeNoteCovered(undefined, "5")).toBe(false);
    expect(homeNoteCovered("", "5")).toBe(false);
  });

  it("homeUnread 0 clears all of them; unknown or more leaves them", () => {
    const hints = parseReadHints("t:c:1,h:901:5");
    expect(homeClearPlan(hints, "0")).toEqual({ read: [{ kind: "home", id: "901", upTo: "5" }], clearAll: true });
    expect(homeClearPlan(hints, "2").clearAll).toBe(false);
    expect(homeClearPlan(hints, undefined).clearAll).toBe(false);
    expect(homeClearPlan([], "").clearAll).toBe(false);
  });
});

describe("a tap", () => {
  it("a DM opens that DM with the sender", () => {
    expect(
      homeChatTapTarget({ kind: "home_chat", conversationId: "901", convKind: "dm", senderExt: "k2:connect:ana", senderName: "Ana" }, "s1")
    ).toEqual({ serverId: "s1", kind: "dm", conversationId: "901", title: "Ana", ext: "k2:connect:ana" });
  });

  it("a channel opens that channel by name", () => {
    expect(homeChatTapTarget({ conversationId: "902", convKind: "channel", channelName: "standup" }, "s2")).toEqual({
      serverId: "s2",
      kind: "channel",
      conversationId: "902",
      title: "standup",
      inviteOnly: null,
    });
  });

  it("the generic lane (no conversation) opens nothing over Home", () => {
    expect(homeChatTapTarget({ kind: "home_chat" }, "s1")).toBeNull();
    expect(homeChatTapTarget({ conversationId: "901" }, "")).toBeNull();
  });
});

it("telling the native side is quiet off the app", () => {
  expect(() => setNativeHomeChatViewing("s1", "901")).not.toThrow();
  expect(() => setNativeHomeChatViewing(null, null)).not.toThrow();
});
