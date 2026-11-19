// Permission cards' writes (K2 0.46.3 phone contract v1 §3, §5): answer
// (Allow / Deny / Allow all / Deny all / Close, a batch item, a Deny
// reason, a confirm token), the waiting person's note, and "Turn off
// again". Answers say `client:"phone"` (the card's `answer.via`; without
// it a login's answer reads "web"). Responses carry no doc: the rewritten card arrives as a frame or
// in `changed[]`. Errors come back as words a person can act on.

import type { ServerScope } from "./scope";
import { scopedFetch } from "./scopedFetch";

export type PermissionWrite = { ok: true } | { ok: false; status: number | null; code: string; text: string };

type ParsedError = { code: string; reason: string; required: string; message: string };

/** The daemon's refusal: `{ok:false, error:{code, hint, …}}` (`answer::err`,
 *  compute's `refusal_response`). The words are `error.hint`; `message`
 *  (inside `error` or at the top) is read too, for routes that say it so. */
export function parseError(text: string): ParsedError {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error;
    const top = s(j.message) || s(j.hint);
    if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      return {
        code: s(o.code),
        reason: s(o.reason) || s(j.reason),
        required: s(o.required) || s(j.required),
        message: s(o.hint) || s(o.message) || top,
      };
    }
    if (typeof e === "string") return { code: e, reason: "", required: "", message: top };
    return { code: s(j.code), reason: "", required: "", message: top };
  } catch {
    /* plain text */
  }
  return { code: "", reason: "", required: "", message: "" };
}

/** A refusal that means "do this in K2's own form first" (e.g.
 *  `git_access_setup_form_first`): Allow can't work from here yet. */
export function isFormFirstCode(code: string): boolean {
  return /_form_first$/.test(code);
}

/** What a person reads for a refused write. */
export function permissionErrorText(status: number | null, code: string, reason = "", required = "", message = ""): string {
  switch (code) {
    case "card_not_pending":
    case "request_not_pending":
      return "Someone already answered this, or it closed.";
    case "action_card_person_only":
      return required === "owner" ? "Only the owner can answer this." : "Only an owner or admin can answer this.";
    case "vault_confirm_required":
      return "This needs your password to approve.";
    case "rate_limited":
      return "Too many tries. Wait a minute, then try again.";
    case "undo_expired":
      return "It's too late to turn this off here. Use Settings.";
    case "note_not_allowed":
      return "You can't leave a note on this.";
    case "bad_note":
      return reason === "too_long"
        ? "That note is too long."
        : reason === "newline"
          ? "Keep the note to one paragraph."
          : reason === "link"
            ? "Notes can't contain links."
            : reason === "secret"
              ? "That looks like a secret. Leave it out."
              : "That note can't be sent.";
    case "usage":
      return "This card changed. Pull to refresh.";
    default:
      // The daemon's own words, when it sent some.
      if (message) return message;
      return status == null ? "Could not reach the server." : `Could not send (HTTP ${status}).`;
  }
}

async function post(scope: ServerScope, path: string, body: Record<string, unknown>): Promise<PermissionWrite> {
  try {
    const r = await scopedFetch(scope, path, { method: "POST", body: JSON.stringify(body), timeoutMs: 20_000 });
    if (r.ok) return { ok: true };
    const e = parseError(r.text);
    return { ok: false, status: r.status, code: e.code, text: permissionErrorText(r.status, e.code, e.reason, e.required, e.message) };
  } catch {
    return { ok: false, status: null, code: "network", text: permissionErrorText(null, "network") };
  }
}

export function answerPermission(
  scope: ServerScope,
  addr: string,
  id: string,
  answer: string,
  opts: { item?: string; reason?: string; confirmToken?: string } = {}
): Promise<PermissionWrite> {
  return post(scope, "/cli/thread/answer", {
    addr,
    id,
    answer,
    client: "phone",
    ...(opts.item ? { item: opts.item } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.confirmToken ? { confirmToken: opts.confirmToken } : {}),
  });
}

export function notePermission(scope: ServerScope, addr: string, id: string, text: string): Promise<PermissionWrite> {
  return post(scope, "/cli/thread/permission-note", { addr, id, text });
}

export function undoPermission(scope: ServerScope, addr: string, id: string): Promise<PermissionWrite> {
  return post(scope, "/cli/thread/permission-undo", { addr, id });
}

/** This server's GitHub credential for compute jobs (K2 0.46.10): a GitHub
 *  App (its numeric App ID + the private key PEM) or a fine-grained token. */
export type GitAccessSetup = { kind: "app"; appId: string; keyPem: string } | { kind: "token"; token: string };

/** The setup route, the one `k2 compute git-access setup` uses. */
export const GIT_ACCESS_SETUP_ROUTE = "/cli/compute/git-access/setup";

/** The route's body: `{app_id, key_pem}` or `{token}`. */
export function gitAccessBody(v: GitAccessSetup): Record<string, string> {
  return v.kind === "app" ? { app_id: v.appId.trim(), key_pem: v.keyPem } : { token: v.token.trim() };
}

/** `POST /cli/compute/git-access/setup` as this person (owner or admin):
 *  the key or token goes straight into the server's vault, never through
 *  the card, the Thread or the agent. Nothing here logs or keeps it. */
export function setupGitAccess(scope: ServerScope, v: GitAccessSetup): Promise<PermissionWrite> {
  return post(scope, GIT_ACCESS_SETUP_ROUTE, gitAccessBody(v));
}
