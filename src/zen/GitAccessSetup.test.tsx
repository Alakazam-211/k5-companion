// @vitest-environment jsdom
// The GitHub credential card (K2 0.46.10 `compute.git-access-setup`) and
// cards whose Allow waits on K2's own form: the phone draws the setup form
// on the card, posts it to /cli/compute/git-access/setup, then sends Allow
// (desktop's order); any other form card says to set it up on a computer.
// Refusals read the daemon's own words.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));

import { __resetScopesForTests, scopeFor } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { gitAccessBody, isFormFirstCode, parseError, permissionErrorText } from "../api/permissionCards";
import { FORM_ELSEWHERE_TEXT, PermissionCard } from "./PermissionCard";
import { gitAccessProblem } from "./GitAccessSetupSheet";
import { cardForm, parsePermissionCard } from "./permissionCardModel";
import approverClick from "../test/fixtures/permission-cards-0463/approver-click__pending__cards2.json";
import batchApprover from "../test/fixtures/permission-cards-0463/batch-approver__pending__cards2.json";

type Doc = { id: string; choice: { action: { form?: string; view: Record<string, unknown> } } & Record<string, unknown> };

const ID = "7f3a2c90-4f1e-4c2a-9b0d-3e5f6a7b8c90";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n";
const FORM_FIRST_HINT =
  "Set it up first, in K2's own form on this card (K2 on your computer or the web), or from a terminal outside K2: k2 compute git-access setup --github-app <app id> --key-file <app.pem> (or --github-token-file <file>)";

const res = (status: number, body: unknown) => ({ status, ok: status < 300, text: async () => JSON.stringify(body), json: async () => body });
const calls = () =>
  tauriFetch.mock.calls.map(([u, init]) => ({ path: new URL(u as string).pathname, body: JSON.parse((init as { body?: string })?.body || "{}") }));

/** The click card as another action, with view/action extras. */
function cardDoc(action: string, extra: { view?: Record<string, unknown>; form?: string } = {}): Doc {
  const d = JSON.parse(JSON.stringify(approverClick)) as Doc;
  d.choice.action.view = { ...d.choice.action.view, action, ...(extra.view ?? {}) };
  if (extra.form) d.choice.action.form = extra.form;
  return d;
}

function draw(d: Doc, onWritten = vi.fn()) {
  const card = parsePermissionCard(d.choice)!;
  render(<PermissionCard card={card} id={d.id} addr="billing" scope={scopeFor("s1")} enabled onWritten={onWritten} />);
  return onWritten;
}

/** Route → answer; anything else 200 ok. */
function routes(map: Record<string, () => unknown>) {
  tauriFetch.mockImplementation(async (u: string) => {
    const p = new URL(u).pathname;
    return (map[p]?.() as ReturnType<typeof res>) ?? res(200, { ok: true });
  });
}

beforeEach(() => {
  tauriFetch.mockReset();
  routes({});
  __resetScopesForTests();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "riley", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "tok1" },
    recovery: {},
  });
});
afterEach(() => cleanup());

describe("refusals read the daemon's words", () => {
  it("parseError reads error.hint, error.message or a top-level message", () => {
    expect(parseError(JSON.stringify({ ok: false, error: { code: "git_access_setup_form_first", hint: FORM_FIRST_HINT } }))).toMatchObject({
      code: "git_access_setup_form_first",
      message: FORM_FIRST_HINT,
    });
    expect(parseError(JSON.stringify({ error: { code: "x", message: "In words." } })).message).toBe("In words.");
    expect(parseError(JSON.stringify({ error: "x", message: "Top words." }))).toMatchObject({ code: "x", message: "Top words." });
    expect(parseError("<html>bad gateway</html>")).toEqual({ code: "", reason: "", required: "", message: "" });
  });

  it("the message beats the HTTP number; known codes keep their words", () => {
    expect(permissionErrorText(409, "git_access_setup_form_first", "", "", FORM_FIRST_HINT)).toBe(FORM_FIRST_HINT);
    expect(permissionErrorText(409, "card_not_pending", "", "", "someone answered first")).toBe("Someone already answered this, or it closed.");
    expect(permissionErrorText(409, "", "", "", "")).toBe("Could not send (HTTP 409).");
    expect(permissionErrorText(null, "network")).toBe("Could not reach the server.");
  });

  it("an unknown refusal on Allow shows the daemon's message on the card", async () => {
    routes({ "/cli/thread/answer": () => res(409, { ok: false, error: { code: "something_new", hint: "The node is busy. Try again later." } }) });
    draw(cardDoc("compute.use"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-allow"));
    });
    expect((await screen.findByTestId("permission-error")).textContent).toBe("The node is busy. Try again later.");
  });

  it("no message at all: Could not send (HTTP n)", async () => {
    routes({ "/cli/thread/answer": () => ({ status: 502, ok: false, text: async () => "", json: async () => ({}) }) });
    draw(cardDoc("compute.use"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-allow"));
    });
    expect((await screen.findByTestId("permission-error")).textContent).toBe("Could not send (HTTP 502).");
  });
});

describe("which cards need a form", () => {
  it("cardForm: the action, a known form id, an unknown one, publish.pin", () => {
    expect(cardForm({ action: "compute.git-access-setup", form: null })).toBe("git-access-setup");
    expect(cardForm({ action: "anything", form: "git-access-setup" })).toBe("git-access-setup");
    expect(cardForm({ action: "compute.git-access-setup", form: "site-pin" })).toBe("elsewhere");
    expect(cardForm({ action: "publish.pin", form: null })).toBe("elsewhere");
    expect(cardForm({ action: "compute.use", form: null })).toBeNull();
    expect(isFormFirstCode("git_access_setup_form_first")).toBe(true);
    expect(isFormFirstCode("pin_form_first")).toBe(true);
    expect(isFormFirstCode("form_firstly")).toBe(false);
  });

  it("the form marker is read from the view or the action", () => {
    expect(parsePermissionCard(cardDoc("x", { view: { form: "git-access-setup" } }).choice)!.kind === "permission").toBe(true);
    const v = parsePermissionCard(cardDoc("x", { view: { form: "git-access-setup" } }).choice);
    const a = parsePermissionCard(cardDoc("x", { form: "other-form" }).choice);
    expect(v?.kind === "permission" && v.item.form).toBe("git-access-setup");
    expect(a?.kind === "permission" && a.item.form).toBe("other-form");
  });

  it("the GitHub card: Set up GitHub access and Deny, no Allow", () => {
    draw(cardDoc("compute.git-access-setup"));
    expect(screen.queryByTestId("permission-allow")).toBeNull();
    expect(screen.getByTestId("permission-git-setup").textContent).toBe("Set up GitHub access");
    expect(screen.getByTestId("permission-deny")).toBeTruthy();
  });

  it("form: git-access-setup on the card opens the same form", () => {
    draw(cardDoc("compute.something", { view: { form: "git-access-setup" } }));
    expect(screen.queryByTestId("permission-allow")).toBeNull();
    fireEvent.click(screen.getByTestId("permission-git-setup"));
    expect(screen.getByTestId("git-access-form")).toBeTruthy();
  });

  it("an unknown form: the quiet line and Deny, no Allow", () => {
    draw(cardDoc("compute.something", { view: { form: "some-new-form" } }));
    expect(screen.queryByTestId("permission-allow")).toBeNull();
    expect(screen.queryByTestId("permission-git-setup")).toBeNull();
    expect(screen.getByTestId("permission-form-elsewhere").textContent).toBe(FORM_ELSEWHERE_TEXT);
    expect(screen.getByTestId("permission-deny")).toBeTruthy();
  });

  it("publish.pin: the quiet line and Deny", () => {
    draw(cardDoc("publish.pin"));
    expect(screen.queryByTestId("permission-allow")).toBeNull();
    expect(screen.getByTestId("permission-form-elsewhere").textContent).toBe(FORM_ELSEWHERE_TEXT);
  });

  it("Allow refused *_form_first: Allow gives way to the quiet line; Deny stays", async () => {
    routes({ "/cli/thread/answer": () => res(409, { ok: false, error: { code: "pin_form_first", hint: "Set a PIN first" } }) });
    draw(cardDoc("compute.use"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-allow"));
    });
    expect(await screen.findByTestId("permission-form-elsewhere")).toBeTruthy();
    expect(screen.queryByTestId("permission-allow")).toBeNull();
    expect(screen.queryByTestId("permission-error")).toBeNull();
    expect(screen.getByTestId("permission-deny")).toBeTruthy();
  });

  it("batch: an item that needs a form has no Allow and no Allow all", () => {
    const d = JSON.parse(JSON.stringify(batchApprover)) as Doc;
    const view = d.choice.action.view;
    const items = view.items as Record<string, unknown>[];
    // Three pending items; Allow all on offer.
    view.viewer = { ...(view.viewer as Record<string, unknown>), canAnswerAll: true };
    draw(d);
    expect(screen.queryAllByTestId("permission-item-allow")).toHaveLength(3);
    expect(screen.getByTestId("permission-allow-all")).toBeTruthy();
    cleanup();
    items[0] = { ...items[0], form: "some-new-form" };
    draw(d);
    expect(screen.queryAllByTestId("permission-item-allow")).toHaveLength(2);
    expect(screen.queryByTestId("permission-allow-all")).toBeNull();
    expect(screen.getAllByTestId("permission-form-elsewhere").length).toBe(1);
  });
});

describe("the GitHub setup form", () => {
  it("validates like desktop", () => {
    expect(gitAccessProblem("app", "abc", PEM, "")).toMatch(/App ID/);
    expect(gitAccessProblem("app", "123", "nope", "")).toMatch(/private key/);
    expect(gitAccessProblem("app", " 123 ", PEM, "")).toBeNull();
    expect(gitAccessProblem("token", "", "", "  ")).toMatch(/fine-grained token/);
    expect(gitAccessProblem("token", "", "", "github_pat_x")).toBeNull();
    expect(gitAccessBody({ kind: "app", appId: " 123 ", keyPem: PEM })).toEqual({ app_id: "123", key_pem: PEM });
    expect(gitAccessBody({ kind: "token", token: " github_pat_x\n" })).toEqual({ token: "github_pat_x" });
  });

  it("App: posts {app_id, key_pem} as this person, then Allow; fields emptied", async () => {
    routes({ "/cli/compute/git-access/setup": () => res(200, { credential: { kind: "app", appId: "123", app: "k2-reader" } }) });
    const onWritten = draw(cardDoc("compute.git-access-setup"));
    fireEvent.click(screen.getByTestId("permission-git-setup"));
    const appId = screen.getByTestId("git-access-app-id") as HTMLInputElement;
    const key = screen.getByTestId("git-access-key") as HTMLTextAreaElement;
    for (const el of [appId, key]) {
      expect(el.getAttribute("autocomplete")).toBe("off");
      expect(el.getAttribute("autocapitalize")).toBe("off");
      expect(el.getAttribute("spellcheck")).toBe("false");
    }
    fireEvent.change(appId, { target: { value: "123" } });
    fireEvent.change(key, { target: { value: PEM } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-access-save"));
    });
    await waitFor(() => expect(onWritten).toHaveBeenCalled());
    const c = calls();
    expect(c[0]).toEqual({ path: "/cli/compute/git-access/setup", body: { app_id: "123", key_pem: PEM } });
    expect((tauriFetch.mock.calls[0][1] as { headers?: Record<string, string> }).headers?.Authorization ?? "").toContain("tok1");
    expect(c[1]).toEqual({ path: "/cli/thread/answer", body: { addr: "billing", id: ID, answer: "Allow", client: "phone" } });
    expect(appId.value).toBe("");
    expect(key.value).toBe("");
    expect(screen.queryByTestId("git-access-form")).toBeNull();
  });

  it("Token: a password field; posts {token}, then Allow", async () => {
    routes({ "/cli/compute/git-access/setup": () => res(200, { credential: { kind: "token" } }) });
    draw(cardDoc("compute.git-access-setup"));
    fireEvent.click(screen.getByTestId("permission-git-setup"));
    fireEvent.click(screen.getByTestId("git-access-kind-token"));
    const token = screen.getByTestId("git-access-token") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.getAttribute("autocomplete")).toBe("off");
    expect(token.getAttribute("autocapitalize")).toBe("off");
    expect(token.getAttribute("spellcheck")).toBe("false");
    fireEvent.change(token, { target: { value: "github_pat_11ABC" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-access-save"));
    });
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[0]).toEqual({ path: "/cli/compute/git-access/setup", body: { token: "github_pat_11ABC" } });
    expect(calls()[1].body.answer).toBe("Allow");
    expect(token.value).toBe("");
  });

  it("a bad value: nothing is sent; the route's refusal reads as its words; no Allow", async () => {
    routes({
      "/cli/compute/git-access/setup": () =>
        res(400, { error: { code: "git_access_bad_credential", hint: "a classic token (ghp_…) is refused: make a fine-grained one" } }),
    });
    draw(cardDoc("compute.git-access-setup"));
    fireEvent.click(screen.getByTestId("permission-git-setup"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-access-save"));
    });
    expect(screen.getByTestId("git-access-error").textContent).toMatch(/App ID/);
    expect(tauriFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("git-access-kind-token"));
    fireEvent.change(screen.getByTestId("git-access-token"), { target: { value: "ghp_classic" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-access-save"));
    });
    expect((await screen.findByTestId("git-access-error")).textContent).toBe("a classic token (ghp_…) is refused: make a fine-grained one");
    expect(calls().map((c) => c.path)).toEqual(["/cli/compute/git-access/setup"]);
  });

  it("Cancel empties the fields and closes; Allow stays hidden", () => {
    draw(cardDoc("compute.git-access-setup"));
    fireEvent.click(screen.getByTestId("permission-git-setup"));
    const appId = screen.getByTestId("git-access-app-id") as HTMLInputElement;
    const key = screen.getByTestId("git-access-key") as HTMLTextAreaElement;
    fireEvent.change(appId, { target: { value: "123" } });
    fireEvent.change(key, { target: { value: PEM } });
    fireEvent.click(screen.getByTestId("git-access-cancel"));
    expect(appId.value).toBe("");
    expect(key.value).toBe("");
    expect(screen.queryByTestId("git-access-form")).toBeNull();
    expect(screen.queryByTestId("permission-allow")).toBeNull();
    expect(tauriFetch).not.toHaveBeenCalled();
  });

  it("switching to Token empties the App fields", () => {
    draw(cardDoc("compute.git-access-setup"));
    fireEvent.click(screen.getByTestId("permission-git-setup"));
    const key = screen.getByTestId("git-access-key") as HTMLTextAreaElement;
    fireEvent.change(key, { target: { value: PEM } });
    fireEvent.click(screen.getByTestId("git-access-kind-token"));
    expect(key.value).toBe("");
  });

  it("a chosen .pem goes straight into the key field", async () => {
    draw(cardDoc("compute.git-access-setup"));
    fireEvent.click(screen.getByTestId("permission-git-setup"));
    const file = new File([PEM], "app.pem", { type: "application/x-pem-file" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("git-access-key-file"), { target: { files: [file] } });
    });
    await waitFor(() => expect((screen.getByTestId("git-access-key") as HTMLTextAreaElement).value).toBe(PEM));
  });

  it("setup saved but Allow fails: the error shows and plain Allow comes back", async () => {
    routes({
      "/cli/compute/git-access/setup": () => res(200, { credential: { kind: "token" } }),
      "/cli/thread/answer": () => res(503, { error: { code: "busy", hint: "K2 is restarting. Try again." } }),
    });
    draw(cardDoc("compute.git-access-setup"));
    fireEvent.click(screen.getByTestId("permission-git-setup"));
    fireEvent.click(screen.getByTestId("git-access-kind-token"));
    fireEvent.change(screen.getByTestId("git-access-token"), { target: { value: "github_pat_x" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-access-save"));
    });
    expect((await screen.findByTestId("permission-error")).textContent).toBe("K2 is restarting. Try again.");
    expect(screen.getByTestId("permission-allow")).toBeTruthy();
    expect(screen.queryByTestId("permission-git-setup")).toBeNull();
  });
});
