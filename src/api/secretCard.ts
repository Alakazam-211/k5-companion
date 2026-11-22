// Answering a secret-request card (`k2 thread secret`) from the phone: the
// desktop's SecretCard wire, byte for byte.
//
//   POST /cli/thread/answer
//   { addr, id, secret: <value>, inject?: {dst, fmt}, disclosed: "1", confirm?: "1" }
//
// The same JSON body the desktop builds (`threadAnswerBody` in K2's
// overlayThread.ts): `disclosed` because the card showed the agent's choice
// in a plain sentence before Save, `inject` echoed when the card named how
// K2 sends it (the daemon refuses an answer without it), `confirm` only for
// the second click after `card_host_mismatch` / `card_readable_delivery`.
// The phone never changes scope, sites or delivery (no Advanced), so those
// keys are never sent and the agent's proposal stands.
//
// The value rides this request body only. Nothing here keeps, logs or
// returns it: a refusal comes back as the daemon's code and words, which
// never echo the value. The success keeps only `status` and `ref`.

import type { ServerScope } from "./scope";
import { scopedFetch } from "./scopedFetch";
import { parseError } from "./permissionCards";
import type { SecretInject } from "../zen/threadModel";

export const SECRET_ANSWER_ROUTE = "/cli/thread/answer";

export type SecretAnswerResult =
  | { ok: true; status: string; ref: string | null }
  | { ok: false; status: number | null; code: string; text: string };

/** The answer body (K2 `threadAnswerBody` for a secret payload). */
export function secretAnswerBody(
  addr: string,
  id: string,
  value: string,
  opts: { inject: SecretInject | null; confirm: boolean }
): Record<string, unknown> {
  return {
    addr,
    id,
    secret: value,
    ...(opts.inject ? { inject: { dst: opts.inject.dst, fmt: opts.inject.fmt } } : {}),
    disclosed: "1",
    ...(opts.confirm ? { confirm: "1" } : {}),
  };
}

/** One answer on the card's own server (that server's login). */
export async function answerSecretCard(
  scope: ServerScope,
  addr: string,
  id: string,
  value: string,
  opts: { inject: SecretInject | null; confirm: boolean }
): Promise<SecretAnswerResult> {
  let r;
  try {
    r = await scopedFetch(scope, SECRET_ANSWER_ROUTE, {
      method: "POST",
      body: JSON.stringify(secretAnswerBody(addr, id, value, opts)),
      timeoutMs: 20_000,
    });
  } catch {
    return { ok: false, status: null, code: "network", text: "Could not reach the server." };
  }
  if (r.ok) {
    let status = "set";
    let ref: string | null = null;
    try {
      const j = JSON.parse(r.text) as { status?: unknown; ref?: unknown };
      if (typeof j.status === "string" && j.status.trim()) status = j.status.trim();
      if (typeof j.ref === "string" && j.ref.trim()) ref = j.ref.trim();
    } catch {
      /* an answer without a body still saved */
    }
    return { ok: true, status, ref };
  }
  const e = parseError(r.text);
  return {
    ok: false,
    status: r.status,
    code: e.code,
    text: e.message || e.code || `Could not save (HTTP ${r.status}).`,
  };
}
