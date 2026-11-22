// Home chat pushes on the wire (K2 0.46.16 `home-chat-push-v1`, daemon
// `home_chat/notify.rs`): the notify and push-prefs routes, their parsers,
// the `notify` frame, and mentions.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("./scopedFetch", () => ({ NOT_CONNECTED: "Not connected", scopedFetch: fetchMock }));

import { fakeScope } from "../test/fakeScope";
import { fetchHomeChatNotify, fetchHomeChatPushPrefs, setHomeChatNotify, setHomeChatPushPrefs } from "./homeChat";
import { parseHomeChatFrame } from "./homeChatEvents";
import {
  applyHomeChatNotifyFrame,
  homeChatMentionsMe,
  parseHomeChatMessage,
  parseHomeChatNotify,
  parseHomeChatPushPrefs,
  parseHomeChatRefusal,
  textMentions,
  type HomeChatMessage,
} from "./homeChatPure";

const answer = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: JSON.stringify(body),
});
type Opts = { method?: string; query?: Record<string, string>; body?: string };
const sent = () =>
  fetchMock.mock.calls.map(([, path, o]) => {
    const opts = (o ?? {}) as Opts;
    return { path: path as string, method: opts.method ?? "GET", query: opts.query, body: opts.body ? JSON.parse(opts.body) : undefined };
  });

const NOTIFY = { ok: true, conv: "902", convKind: "channel", level: "mentions", effective: "mentions", inherited: true, fixed: false, muted: false, allMessagesLive: false };
const PREFS = { ok: true, on: true, previews: true, agents: false, serverPreviews: true, bell: true, devices: 2, allMessagesLive: false };

beforeEach(() => fetchMock.mockReset());

describe("routes", () => {
  it("GET notify?conv and POST notify/set {conv, level}", async () => {
    const scope = fakeScope({ id: "s1" });
    fetchMock.mockResolvedValueOnce(answer(200, NOTIFY)).mockResolvedValueOnce(answer(200, { ...NOTIFY, level: "all", effective: "all", inherited: false }));
    const r = await fetchHomeChatNotify(scope, "902");
    expect(r.ok && r.notify).toEqual({ conv: "902", convKind: "channel", level: "mentions", effective: "mentions", inherited: true, fixed: false, muted: false, allMessagesLive: false });
    const s = await setHomeChatNotify(scope, "902", "all");
    expect(s.ok && s.notify.level).toBe("all");
    expect(sent()).toEqual([
      { path: "/cli/home-chat/notify", method: "GET", query: { conv: "902" }, body: undefined },
      { path: "/cli/home-chat/notify/set", method: "POST", query: undefined, body: { conv: "902", level: "all" } },
    ]);
  });

  it("a DM's set answers 409 dm_always_notifies (a conflict)", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(409, { ok: false, code: "dm_always_notifies", hint: "DMs always notify; there is no level to set", error: { code: "dm_always_notifies", hint: "x" } })
    );
    const r = await setHomeChatNotify(fakeScope(), "901", "mentions");
    expect(!r.ok && r.kind).toBe("conflict");
    expect(!r.ok && r.code).toBe("dm_always_notifies");
  });

  it("bad ids and levels never leave the phone", async () => {
    expect((await fetchHomeChatNotify(fakeScope(), "c-1")).ok).toBe(false);
    expect((await setHomeChatNotify(fakeScope(), "902", "none" as unknown as "all")).ok).toBe(false);
    expect((await setHomeChatPushPrefs(fakeScope(), {})).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("push-prefs: GET, and set sends only what changes", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, PREFS)).mockResolvedValueOnce(answer(200, { ...PREFS, previews: false }));
    const g = await fetchHomeChatPushPrefs(fakeScope());
    expect(g.ok && g.prefs).toEqual({ on: true, previews: true, agents: false, serverPreviews: true, bell: true, devices: 2, allMessagesLive: false });
    const s = await setHomeChatPushPrefs(fakeScope(), { previews: false });
    expect(s.ok && s.prefs.previews).toBe(false);
    expect(sent()[1]).toEqual({ path: "/cli/home-chat/push-prefs/set", method: "POST", query: undefined, body: { previews: false } });
  });

  it("an answer without a level is not a guess", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { ok: true, conv: "902" }));
    const r = await fetchHomeChatNotify(fakeScope(), "902");
    expect(!r.ok && r.kind).toBe("bad_response");
  });
});

describe("parsers", () => {
  it("notify: a DM is fixed; none (set elsewhere) passes; junk is null", () => {
    expect(parseHomeChatNotify({ conv: 901, convKind: "dm", level: "all", fixed: true })).toMatchObject({ conv: "901", convKind: "dm", fixed: true, effective: "all" });
    expect(parseHomeChatNotify({ conv: "902", level: "none" })?.level).toBe("none");
    expect(parseHomeChatNotify({ conv: "902", level: "loud" })).toBeNull();
    expect(parseHomeChatNotify(null)).toBeNull();
  });

  it("push prefs need previews", () => {
    expect(parseHomeChatPushPrefs({ on: true })).toBeNull();
    expect(parseHomeChatPushPrefs({ previews: false, devices: -3 })).toMatchObject({ previews: false, devices: 0, serverPreviews: false });
  });

  it("dm_always_notifies maps to conflict", () => {
    expect(parseHomeChatRefusal(409, JSON.stringify({ code: "dm_always_notifies", hint: "x" })).kind).toBe("conflict");
  });
});

describe("the notify frame", () => {
  it("parses from the events socket", () => {
    expect(parseHomeChatFrame({ type: "notify", conv: "902", level: "all", effective: "all", inherited: false, muted: true })).toEqual({
      type: "notify",
      conv: "902",
      level: "all",
      effective: "all",
      inherited: false,
      muted: true,
    });
    expect(parseHomeChatFrame({ type: "notify", level: "all" })).toBeNull();
  });

  it("merges over what was held, keeping fixed and allMessagesLive", () => {
    const held = parseHomeChatNotify({ ...NOTIFY, allMessagesLive: true })!;
    expect(applyHomeChatNotifyFrame(held, { conv: "902", level: "all", effective: "all", inherited: false, muted: false })).toEqual({
      ...held,
      level: "all",
      effective: "all",
      inherited: false,
    });
    // An inherited level: the one in effect.
    expect(applyHomeChatNotifyFrame(held, { conv: "902", level: null, effective: "mentions", inherited: true, muted: true })).toMatchObject({
      level: "mentions",
      muted: true,
    });
    expect(applyHomeChatNotifyFrame(held, { conv: "902", level: null, effective: null, inherited: true, muted: false })).toBeNull();
  });
});

describe("mentions", () => {
  const me = { memberId: "1", names: ["alice", "Alice Stone"] };
  const m = (over: Partial<HomeChatMessage>): HomeChatMessage => ({
    id: "5",
    conv: "902",
    authorId: "2",
    body: "",
    createdAtMs: 0,
    seq: 0,
    reactions: [],
    replyTo: null,
    edited: false,
    editedAtMs: null,
    deleted: false,
    nonce: null,
    call: null,
    ...over,
  });

  it("Sew's mentions: my member id, @channel, @here", () => {
    const parsed = parseHomeChatMessage({ id: "5", channel_id: "902", author_id: "2", body: "hey", mentions: { members: [1, "3"], channel: false } });
    expect(parsed?.mentions).toEqual({ members: ["1", "3"], channel: false, here: false });
    expect(homeChatMentionsMe(parsed!, me)).toBe(true);
    expect(homeChatMentionsMe(m({ mentions: { members: [], channel: true, here: false } }), me)).toBe(true);
    expect(homeChatMentionsMe(m({ mentions: { members: ["3"], channel: false, here: false } }), me)).toBe(false);
    expect(parseHomeChatMessage({ id: "5", channel_id: "902", body: "x", mentions: { members: [] } })?.mentions).toBeUndefined();
  });

  it("@me in the words, by username or name, whole names only", () => {
    expect(homeChatMentionsMe(m({ body: "thanks @Alice!" }), me)).toBe(true);
    expect(homeChatMentionsMe(m({ body: "cc @alice stone" }), me)).toBe(true);
    expect(homeChatMentionsMe(m({ body: "@alicex is new" }), me)).toBe(false);
    expect(homeChatMentionsMe(m({ body: "mail z@example.com" }), me)).toBe(false);
    expect(textMentions("no at sign", ["alice"])).toBe(false);
    expect(textMentions("@a.b+c", ["a.b+c"])).toBe(true);
  });

  it("never my own message or a deleted one", () => {
    expect(homeChatMentionsMe(m({ authorId: "1", body: "@alice" }), me)).toBe(false);
    expect(homeChatMentionsMe(m({ deleted: true, body: "@alice" }), me)).toBe(false);
  });
});
