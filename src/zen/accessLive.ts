// K2 0.46.17: what one `access_changed` re-reads on its server (the
// `access` server signal, one per burst: api/accessLive.ts).
//
//   - the pool: a full check (`GET /cli/auth/whoami` even on the active
//     server): role (a Voice & Chat only login reads `voice_chat`, which
//     opens no agent room), username, and `mustChangePassword`, which turns
//     the row to "Change password" and opens the existing set-password step;
//   - the session identity (who "You" is, the role on Server settings),
//     when a surface has read it;
//   - the Home chat gate (the chat grant), forced past its freshness.
// In a call the recording rights are read again by their own subscriber
// (voice/kit/KitCall.tsx). The owner link and "Can clone" have no phone
// surface yet: whoami is re-read, nothing else holds them.

import { refreshHomeChatGate } from "../api/homeChat";
import { scopeFor, type ServerScope } from "../api/scope";
import { onServerSignal } from "../api/serverSignals";
import { refreshIdentity } from "../lib/sessionAuthor";
import { pool } from "./multi/pool";

export interface AccessRereads {
  recheck: (serverId: string) => unknown;
  identity: (scope: ServerScope) => unknown;
  chatGate: (scope: ServerScope) => unknown;
  scopeOf: (serverId: string) => ServerScope;
}

const LIVE: AccessRereads = {
  recheck: (id) => pool.check(id, { fresh: true }),
  identity: (scope) => refreshIdentity(scope),
  chatGate: (scope) => refreshHomeChatGate(scope, { force: true }),
  scopeOf: (id) => scopeFor(id),
};

/** One re-read of `serverId`'s access. Never throws. */
export function rereadAccess(serverId: string, deps: AccessRereads = LIVE): void {
  const run = (fn: () => unknown) => {
    try {
      const out = fn();
      if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(() => {});
    } catch {
      /* one read never stops the others */
    }
  };
  run(() => deps.recheck(serverId));
  let scope: ServerScope;
  try {
    scope = deps.scopeOf(serverId);
    scope.httpBase(); // a removed server has nothing to read
  } catch {
    return;
  }
  run(() => deps.identity(scope));
  run(() => deps.chatGate(scope));
}

let wired: (() => void) | null = null;

/** Boot (main.tsx): follow the `access` signal. Idempotent. */
export function wireAccessLive(deps: AccessRereads = LIVE): () => void {
  if (wired) return wired;
  const off = onServerSignal((id, signal) => {
    if (signal === "access") rereadAccess(id, deps);
  });
  wired = () => {
    off();
    wired = null;
  };
  return wired;
}
