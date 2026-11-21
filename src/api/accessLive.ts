// Live access changes (K2 0.46.17).
//
//   - `{"kind":"access_changed"}` arrives on this login's own app sockets
//     (`/cli/sessions/events`, `/cli/ops/stream`: a copy on each) for a role
//     change, "Can clone", Voice & Chat only shares, a forced password
//     change, the owner link and the chat grant. No details: the client
//     reads its access again (`GET /cli/auth/whoami`, and in a call the
//     recording controls). The phone opens only sessions/events of the two,
//     plus the Home chat socket, which carries the frame too if K2 sends it
//     there. Copies within ACCESS_DEBOUNCE_MS make ONE re-read per server:
//     the `access` server signal (`zen/accessLive.ts` does the reads).
//   - Removal, disable or a sign-out role change CLOSES those sockets with
//     4003. `checkAfterRevoked` decides what a socket does then: whoami on
//     that server (revive, background: the token is never deleted from
//     here, MA22); a dead login, or a 401/403 that whoami could not explain
//     (a disabled account), is signed out on that server ("Sign in again"),
//     never a reconnect loop. A login that still stands reconnects once; a
//     second 4003 before the socket stayed open stops it.
//
// Call-log lines ("Send call log"): `access access_changed` once per
// re-read, `access closed 4003` per close.

import { revive, type ReviveOutcome } from "../lib/revive";
import { callLogNote } from "../lib/callLog";
import { scopedFetch } from "./scopedFetch";
import { emitServerSignal } from "./serverSignals";
import type { ServerScope } from "./scope";
import { isPairedServer, useServersStore } from "../stores/servers";

/** Copies of one change (one per socket) within this window: one re-read. */
export const ACCESS_DEBOUNCE_MS = 300;

/** The daemon's close for a removed, disabled or signed-out login. */
export const ACCESS_CLOSE_REVOKED = 4003;

/** `{"kind":"access_changed"}` (any extra fields ignored). */
export function isAccessChangedFrame(frame: unknown): boolean {
  return !!frame && typeof frame === "object" && (frame as { kind?: unknown }).kind === "access_changed";
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** A socket of `serverId` heard `access_changed`: one `access` signal per
 *  burst (both sockets send a copy). */
export function noteAccessChanged(serverId: string): void {
  if (!serverId) return;
  const was = pending.get(serverId);
  if (was) clearTimeout(was);
  pending.set(
    serverId,
    setTimeout(() => {
      pending.delete(serverId);
      callLogNote(["access", "access_changed"]);
      emitServerSignal(serverId, "access");
    }, ACCESS_DEBOUNCE_MS)
  );
}

/** What a socket closed 4003 does next. */
export type RevokedVerdict =
  /** The login is gone here: stop, and the server says "Sign in again". */
  | "signed-out"
  /** The login stands (or whoami could not be reached): reconnect. */
  | "reconnect"
  /** The login stands but this socket is refused again and again: stop
   *  quietly (no loop); a new subscriber or the foreground tries again. */
  | "stop";

/** The pure rule. `whoami` is the status of one extra read, made only
 *  when revive could not settle it (null: no answer). `repeat`: this
 *  socket was closed 4003 before without staying open since. */
export function revokedVerdict(
  outcome: ReviveOutcome,
  whoami: { status: number; text: string } | null,
  opts: { repeat: boolean; paired: boolean }
): RevokedVerdict {
  if (outcome === "signin-required" || outcome === "not-applicable") return "signed-out";
  if (outcome === "still-valid") return opts.repeat ? "stop" : "reconnect";
  if (!whoami) return "reconnect";
  if (whoami.status === 403) {
    // A temporary password: the login stands, the set-password step shows.
    return /password_change_required/i.test(whoami.text) ? (opts.repeat ? "stop" : "reconnect") : "signed-out";
  }
  // A paired phone's 401 is a blip (only 403 `device_session_ended` ends it).
  if (whoami.status === 401 && !opts.paired) return "signed-out";
  return "reconnect";
}

async function whoamiStatus(scope: ServerScope): Promise<{ status: number; text: string } | null> {
  try {
    const res = await scopedFetch(scope, "/cli/auth/whoami", { revive: false, timeoutMs: 8_000 });
    return res.status > 0 ? { status: res.status, text: res.text } : null;
  } catch {
    return null;
  }
}

/** A socket of `scope`'s server closed 4003. Whoami there first (revive,
 *  background); when that cannot settle it, one more read: a 401/403 after
 *  a 4003 is access removed (a disabled account answers so). A signed-out
 *  verdict marks the server `signin-required` and emits `signin`; the
 *  caller stops its socket. */
export async function checkAfterRevoked(scope: ServerScope, opts: { repeat: boolean }): Promise<RevokedVerdict> {
  callLogNote(["access", "closed", String(ACCESS_CLOSE_REVOKED)]);
  const outcome = await revive(scope, { background: true });
  let extra: { status: number; text: string } | null = null;
  if (outcome === "unreachable" || outcome === "cooldown") extra = await whoamiStatus(scope);
  const s = useServersStore.getState();
  const server = s.servers.find((x) => x.id === scope.id);
  const verdict = revokedVerdict(outcome, extra, { repeat: opts.repeat, paired: isPairedServer(server) });
  if (verdict === "signed-out") {
    if (server && s.recovery[scope.id] !== "signin-required") s.setRecovery(scope.id, "signin-required");
    emitServerSignal(scope.id, "signin");
  }
  return verdict;
}

/** Tests: drop pending re-reads. */
export function __resetAccessLiveForTests(): void {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}
