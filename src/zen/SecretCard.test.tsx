// @vitest-environment jsdom
// Secret-request cards on the phone (`k2 thread secret`): the desktop's
// simple card. The card draws from a served secret item; Save posts the
// desktop's body to /cli/thread/answer on the card's server and the value
// lands nowhere else; Deny voids the card; closed states; the app switcher
// re-mask; and the fallback card for cards this app can't draw.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));
vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    postThread: vi.fn(),
    getThread: vi.fn(),
    voidThreadCard: vi.fn(),
    answerThread: vi.fn(),
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  };
});
vi.mock("./overlayEvents", () => ({
  connectOverlayEvents: vi.fn(() => ({ stop: vi.fn(), setViewing: vi.fn() })),
}));
vi.mock("../stores/notifyPrefs", () => ({
  useNotifyPrefsStore: Object.assign(
    (sel: (s: { threadPush: Record<string, boolean> }) => unknown) => sel({ threadPush: {} }),
    { getState: () => ({ probe: async () => {} }) }
  ),
}));

import { answerThread, voidThreadCard } from "../api/client";
import { secretAnswerBody } from "../api/secretCard";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { blankEntry, pool } from "./multi/pool";
import { cardFallback, normaliseThreadItem, type ThreadMessage } from "./threadModel";
import { rowLastFromMessage, CARD_TEXT } from "./lastAtFetch";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

const T0 = 1_700_000_000;
const VALUE = "sk_live_ZZ-never-anywhere-but-the-body-91";

/** A secret card as `GET /cli/thread` serves it (K2 `SecretBody`). */
function secretItem(id: string, seq: number, secret: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    seq,
    doc: {
      id,
      kind: "secret",
      from: "aspen",
      to: "aspen",
      created_at: T0 + seq,
      body: (secret.prompt as string | undefined) ?? null,
      via: "card",
      secret: { name: "STRIPE_KEY", status: "pending", ...secret },
      ...extra,
    },
  };
}

const card = (id: string, seq: number, secret: Record<string, unknown>, extra?: Record<string, unknown>): ThreadMessage =>
  normaliseThreadItem(secretItem(id, seq, secret, extra) as never, "bob")!;

const fetchCard = (over: Record<string, unknown> = {}) =>
  card("sec1", 4, {
    prompt: "Paste the Stripe restricted key for the billing job.",
    scope: "workspace",
    hosts: ["https://api.stripe.com:443"],
    delivery: "fetch",
    secretKind: "api_key",
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
    inject: { dst: "header:Authorization", fmt: "Bearer {}" },
    envName: "STRIPE_KEY",
    ...over,
  });

function openRoom(thread: ThreadMessage[]) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "aspen",
    threadGroupId: null,
    threadConversationId: "conv-1",
    agentId: "aspen",
    agents: [{ id: "aspen", name: "aspen", initial: "A", path: "/Users/Bob/Aspen", addr: "aspen" }],
    thread,
    outbox: [],
    landedKeys: {},
    sending: false,
    sendError: null,
    answeringId: null,
    answerError: null,
    answerErrorId: null,
  });
}

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
  };
}

/** The answer route answers these in order; any other request gets an
 *  empty 200 (other parts of the pane may fetch too). */
function answerWith(...replies: ReturnType<typeof reply>[]) {
  const queue = [...replies];
  tauriFetch.mockImplementation(async (url: unknown) =>
    String(url).includes("/cli/thread/answer") ? queue.shift() ?? reply(500, {}) : reply(200, {})
  );
}

/** The answer calls (url, parsed body). */
function answers() {
  return tauriFetch.mock.calls
    .filter((c) => String(c[0]).includes("/cli/thread/answer"))
    .map((c) => ({ url: String(c[0]), init: c[1] as RequestInit, body: JSON.parse(String((c[1] as RequestInit).body)) }));
}

function field(): HTMLInputElement {
  return screen.getByTestId("secret-field") as HTMLInputElement;
}

function type(value: string) {
  fireEvent.change(field(), { target: { value } });
}

const logs = () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k));
  return () => spies.flatMap((s) => s.mock.calls).map((c) => c.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
};

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "bob", base: "https://s1.k2.example" }));
  pool.store.setState({ entries: {} });
});

afterEach(() => {
  cleanup();
  tauriFetch.mockReset();
  vi.mocked(voidThreadCard).mockReset();
  vi.restoreAllMocks();
  // @ts-expect-error test cleanup
  delete window.matchMedia;
});

describe("the secret card model", () => {
  it("keeps every field the card shows, and nothing it doesn't", () => {
    const m = fetchCard({ replaces: true, once: false, ref: null, unknownField: "x" });
    expect(m.secret).toMatchObject({
      name: "STRIPE_KEY",
      status: "pending",
      scope: "workspace",
      hosts: ["https://api.stripe.com:443"],
      delivery: "fetch",
      secretKind: "api_key",
      inject: { dst: "header:Authorization", fmt: "Bearer {}" },
      envName: "STRIPE_KEY",
      replaces: true,
      once: false,
    });
    expect(m.secret).not.toHaveProperty("unknownField");
    expect(m.unsupportedCard).toBeUndefined();
    expect(cardFallback(m)).toBe(false);
  });

  it("a secret card with no prompt is kept (it used to vanish)", () => {
    const m = card("s0", 1, {});
    expect(m).not.toBeNull();
    expect(m.secret?.name).toBe("STRIPE_KEY");
  });
});

describe("a waiting secret card", () => {
  it("draws the header, the plain sentence, the prompt and the expiry", () => {
    openRoom([fetchCard({ replaces: true })]);
    render(<ThreadPane />);
    expect(screen.getByTestId("secret-header").textContent).toBe("aspen asks for a secret: STRIPE_KEY");
    expect(screen.getByTestId("secret-prompt").textContent).toBe(
      "aspen says: Paste the Stripe restricted key for the billing job."
    );
    expect(screen.getByTestId("secret-plan").textContent).toBe(
      "K2 will add this to calls to api.stripe.com as Authorization: Bearer ‹secret›, for this workspace; aspen never sees it."
    );
    expect(screen.getByTestId("secret-expiry").textContent).toBe("Expires in 7 days");
    expect(screen.getByTestId("secret-replaces").textContent).toContain("This replaces the STRIPE_KEY already saved");
    expect(screen.getByTestId("secret-hint").textContent).toBe(
      "Not right? Tell aspen in the chat; it can cancel this and ask again."
    );
    const el = field();
    expect(el.type).toBe("password");
    expect(el.getAttribute("autocomplete")).toBe("off");
    expect(el.getAttribute("autocorrect")).toBe("off");
    expect(el.getAttribute("autocapitalize")).toBe("off");
    expect(el.getAttribute("spellcheck")).toBe("false");
    expect((screen.getByTestId("secret-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says file and env deliveries (with the env name) and a one-time code", () => {
    openRoom([
      card("f1", 1, { delivery: "file", scope: "session", once: true }),
      card("e1", 2, { name: "HETZNER_ROBOT", delivery: "env", envName: "HETZNER_ROBOT" }),
    ]);
    render(<ThreadPane />);
    const plans = screen.getAllByTestId("secret-plan").map((p) => p.textContent);
    expect(plans[0]).toBe("aspen will get this as a file it can read, for this session only.");
    expect(plans[1]).toBe("aspen will get this as an environment variable it can read ($HETZNER_ROBOT), for this workspace.");
    expect(screen.getByTestId("secret-once").textContent).toBe("Used once, then deleted.");
  });

  it("Save sends exactly the desktop's body to the card's server, once; the value lands nowhere else", async () => {
    const logged = logs();
    openRoom([fetchCard()]);
    answerWith(reply(200, { ok: true, id: "sec1", status: "set", name: "STRIPE_KEY", ref: "k2v://ws/aspen/STRIPE_KEY", trimmed: false, agentCanSee: false }));
    render(<ThreadPane />);
    type(VALUE);
    await act(async () => {
      fireEvent.click(screen.getByTestId("secret-save"));
    });
    const sent = answers();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://s1.k2.example/cli/thread/answer");
    expect(sent[0].init.method).toBe("POST");
    // K2 threadAnswerBody for {secret, inject, disclosed: true}.
    expect(sent[0].body).toEqual({
      addr: "aspen",
      id: "sec1",
      secret: VALUE,
      inject: { dst: "header:Authorization", fmt: "Bearer {}" },
      disclosed: "1",
    });
    expect(sent[0].url).not.toContain(VALUE);
    // Closed as saved, with the reference.
    await waitFor(() =>
      expect(screen.getByTestId("secret-closed").textContent).toBe("STRIPE_KEY saved by You as k2v://ws/aspen/STRIPE_KEY")
    );
    const s = useZenStore.getState().thread[0].secret!;
    expect(s.status).toBe("set");
    expect(s.ref).toBe("k2v://ws/aspen/STRIPE_KEY");
    // Nowhere but that one body: the store, the thread (what the chat
    // cache keeps), browser storage, the page, the logs.
    expect(JSON.stringify(useZenStore.getState().thread)).not.toContain(VALUE);
    expect(JSON.stringify(useZenStore.getState(), (_k, v) => (typeof v === "function" ? undefined : v))).not.toContain(VALUE);
    expect(JSON.stringify({ ...localStorage })).not.toContain(VALUE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(VALUE);
    expect(document.body.innerHTML).not.toContain(VALUE);
    expect(logged().join("\n")).not.toContain(VALUE);
  });

  it("a card that names no sending sends no inject", () => {
    expect(secretAnswerBody("aspen", "c", "v", { inject: null, confirm: false })).toEqual({
      addr: "aspen",
      id: "c",
      secret: "v",
      disclosed: "1",
    });
  });

  it("a host mismatch warns; Save anyway resends the same value with confirm", async () => {
    const logged = logs();
    openRoom([fetchCard()]);
    answerWith(
      reply(409, { ok: false, error: { code: "card_host_mismatch", hint: "this looks like an OpenAI key; confirm to save anyway" } }),
      reply(200, { ok: true, status: "set", ref: "k2v://ws/aspen/STRIPE_KEY" })
    );
    render(<ThreadPane />);
    type(VALUE);
    await act(async () => {
      fireEvent.click(screen.getByTestId("secret-save"));
    });
    expect(screen.getByTestId("secret-warning").textContent).toContain(
      "This looks like a OpenAI key, but it would be sent to api.stripe.com. Save it only if that's right."
    );
    expect(field().value).toBe(VALUE); // kept for the second click
    expect(screen.getByTestId("secret-save").textContent).toBe("Save anyway");
    expect(useZenStore.getState().thread[0].secret!.status).toBe("pending");
    await act(async () => {
      fireEvent.click(screen.getByTestId("secret-save"));
    });
    const sent = answers();
    expect(sent).toHaveLength(2);
    expect(sent[0].body.confirm).toBeUndefined();
    expect(sent[1].body).toEqual({ ...sent[0].body, confirm: "1" });
    expect(sent[1].body.secret).toBe(VALUE);
    await waitFor(() => expect(screen.getByTestId("secret-closed").textContent).toContain("saved"));
    expect(document.body.innerHTML).not.toContain(VALUE);
    expect(logged().join("\n")).not.toContain(VALUE);
  });

  it("an older server's readable-delivery click is answered once with confirm", async () => {
    openRoom([card("f1", 1, { delivery: "file" })]);
    answerWith(
      reply(409, { ok: false, error: { code: "card_readable_delivery", hint: "the agent can read this; confirm" } }),
      reply(200, { ok: true, status: "set" })
    );
    render(<ThreadPane />);
    type(VALUE);
    await act(async () => {
      fireEvent.click(screen.getByTestId("secret-save"));
    });
    const sent = answers();
    expect(sent.map((s) => s.body.confirm)).toEqual([undefined, "1"]);
    expect(sent[0].body.inject).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId("secret-closed").textContent).toBe("STRIPE_KEY saved by You"));
  });

  it("any other refusal shows the daemon's words and keeps the card waiting", async () => {
    openRoom([fetchCard()]);
    answerWith(reply(403, { ok: false, error: { code: "role_required", hint: "a member answers cards" } }));
    render(<ThreadPane />);
    type(VALUE);
    await act(async () => {
      fireEvent.click(screen.getByTestId("secret-save"));
    });
    expect(screen.getByTestId("secret-error").textContent).toBe("a member answers cards");
    expect(screen.getByTestId("secret-error").textContent).not.toContain(VALUE);
    expect(useZenStore.getState().thread[0].secret!.status).toBe("pending");
  });

  it("a sending this app can't show turns Save off with Update K2", () => {
    openRoom([fetchCard({ inject: { dst: "cookie:sid", fmt: "{}" } })]);
    render(<ThreadPane />);
    expect(screen.getByTestId("secret-update").textContent).toContain("Update K2 to answer this card.");
    type(VALUE);
    expect((screen.getByTestId("secret-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Deny voids the card (POST /cli/thread/void, as the desktop's decline) and empties the field", async () => {
    openRoom([fetchCard()]);
    vi.mocked(voidThreadCard).mockResolvedValue({ ok: true, data: {} } as never);
    render(<ThreadPane />);
    type(VALUE);
    await act(async () => {
      fireEvent.click(screen.getByTestId("secret-deny"));
    });
    expect(voidThreadCard).toHaveBeenCalledWith(expect.anything(), "aspen", "sec1", undefined);
    expect(answers()).toHaveLength(0);
    expect(answerThread).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("secret-closed").textContent).toBe("STRIPE_KEY not given"));
    expect(screen.getByTestId("secret-closed-why").textContent).toBe("Dismissed by You");
    expect(JSON.stringify(useZenStore.getState().thread)).not.toContain(VALUE);
  });

  it("Cancel empties the field and folds the card without answering", () => {
    openRoom([fetchCard()]);
    render(<ThreadPane />);
    type(VALUE);
    fireEvent.click(screen.getByTestId("secret-cancel"));
    expect(screen.queryByTestId("secret-field")).toBeNull();
    expect(screen.getByTestId("secret-collapsed").textContent).toBe("Not answered yet.");
    expect(answers()).toHaveLength(0);
    expect(voidThreadCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("secret-reopen"));
    expect(field().value).toBe("");
  });

  it("Show reveals; going to the background masks it again", () => {
    openRoom([fetchCard()]);
    render(<ThreadPane />);
    type(VALUE);
    fireEvent.click(screen.getByTestId("secret-show"));
    expect(field().type).toBe("text");
    expect(screen.getByTestId("secret-show").textContent).toBe("Hide");
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(field().type).toBe("password");
    expect(screen.getByTestId("secret-show").textContent).toBe("Show");
    expect(field().value).toBe(VALUE); // masked, not lost
    vis.mockRestore();
    fireEvent.click(screen.getByTestId("secret-show"));
    expect(field().type).toBe("text");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(field().type).toBe("password");
  });

  it("a cached copy (not yet confirmed) can't be saved", () => {
    openRoom([fetchCard()]);
    useZenStore.setState({ threadCached: true } as never);
    render(<ThreadPane />);
    expect(screen.getByTestId("secret-card")).not.toBeNull();
    expect(field().disabled).toBe(true);
    expect((screen.getByTestId("secret-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a Voice & Chat login sees the fallback, not the field", () => {
    pool.store.setState({ entries: { s1: { ...blankEntry("s1", "s1.k2.example"), role: "voice_chat" } } });
    openRoom([fetchCard()]);
    render(<ThreadPane />);
    expect(screen.queryByTestId("secret-field")).toBeNull();
    expect(screen.getByTestId("card-fallback").textContent).toBe(
      "aspen sent a card this app can't show yet. Open it in the K2 desktop app."
    );
  });
});

describe("closed secret cards", () => {
  it("saved, expired, dismissed and withdrawn", () => {
    openRoom([
      card("a", 1, { status: "set", ref: "k2v://ws/aspen/A", answeredBy: { kind: "user", login: "jamie" } }),
      card("b", 2, { status: "expired" }),
      card("c", 3, { status: "voided", closedAs: "dismissed", closeReason: "Not this one", answeredBy: { kind: "user", login: "bob" } }),
      card("d", 4, { status: "voided", closedAs: "withdrawn" }),
    ]);
    render(<ThreadPane />);
    const lines = screen.getAllByTestId("secret-closed").map((p) => p.textContent);
    expect(lines).toEqual([
      "STRIPE_KEY saved by jamie as k2v://ws/aspen/A",
      "STRIPE_KEY request expired",
      "STRIPE_KEY not given",
      "STRIPE_KEY not given",
    ]);
    expect(screen.getAllByTestId("secret-closed-why").map((p) => p.textContent)).toEqual([
      "Dismissed by You: Not this one",
      "Withdrawn by aspen",
    ]);
    expect(screen.queryByTestId("secret-field")).toBeNull();
  });
});

describe("cards this app can't draw", () => {
  it("an unknown kind with no words shows the fallback card (it used to vanish)", () => {
    const m = normaliseThreadItem(
      { id: "w1", seq: 9, doc: { id: "w1", kind: "survey.v9", from: "aspen", created_at: T0 } } as never,
      "bob"
    )!;
    expect(m).not.toBeNull();
    expect(cardFallback(m)).toBe(true);
    expect(rowLastFromMessage(m, "aspen", "bob").text).toBe(CARD_TEXT);
    openRoom([m]);
    render(<ThreadPane />);
    expect(screen.getByTestId("card-fallback").textContent).toBe(
      "aspen sent a card this app can't show yet. Open it in the K2 desktop app."
    );
  });

  it("a handoff card shows its plain line and the fallback", () => {
    const m = normaliseThreadItem(
      {
        id: "h1",
        seq: 10,
        doc: {
          id: "h1",
          kind: "handoff",
          from: "sales",
          created_at: T0,
          body: "sales sent you a secret: STRIPE_KEY",
          handoff: { deliveryId: "d1", name: "STRIPE_KEY", from: "sales", kind: "api_key", hosts: [], note: "", clash: false, status: "pending" },
        },
      } as never,
      "bob"
    )!;
    expect(m.unsupportedCard).toBe(true);
    openRoom([m]);
    render(<ThreadPane />);
    expect(screen.getByText("sales sent you a secret: STRIPE_KEY")).not.toBeNull();
    expect(screen.getByTestId("card-fallback").textContent).toBe(
      "sales sent a card this app can't show yet. Open it in the K2 desktop app."
    );
  });

  it("plain text, choice and stash cards draw as before (no fallback)", () => {
    const text = normaliseThreadItem({ id: "t", seq: 1, doc: { id: "t", kind: "text", from: "aspen", body: "hi" } } as never, "bob")!;
    const choice = normaliseThreadItem(
      { id: "c", seq: 2, doc: { id: "c", kind: "choice", from: "aspen", choice: { prompt: "Ship?", options: ["Yes"] } } } as never,
      "bob"
    )!;
    const stash = normaliseThreadItem(
      { id: "o", seq: 3, doc: { id: "o", kind: "stash.offer", from: "aspen", body: "x", stash: { text: "Prompt" } } } as never,
      "bob"
    )!;
    const changes = normaliseThreadItem(
      { id: "g", seq: 4, doc: { id: "g", kind: "changes", from: "k2", body: "3 files changed" } } as never,
      "bob"
    )!;
    for (const m of [text, choice, stash, changes]) expect(cardFallback(m)).toBe(false);
    expect(normaliseThreadItem({ id: "e", seq: 5, doc: { id: "e", kind: "text", from: "aspen", body: "" } } as never, "bob")).toBeNull();
    openRoom([text, choice, stash, changes]);
    render(<ThreadPane />);
    expect(screen.queryByTestId("card-fallback")).toBeNull();
  });
});
