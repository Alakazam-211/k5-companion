import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emitServerSignal } from "../../api/serverSignals";
import { scopeFor } from "../../api/scope";
import { callLogNote } from "../../lib/callLog";
import { revive, type ReviveOutcome } from "../../lib/revive";

// The call's event feed (K2 0.46.17; native: src-tauri/src/voice/feed.rs):
// `GET /_k2/voice/sew/feed` on the call's server, opened only while the
// phone is connected to a call there. RECORD_CALLS is a Sew permission
// (K2 never sees a moderator grant it), so a `perms_changed` for the
// call's channel or space re-reads the recording rights (`onPerms`:
// readRecordingRights, handed to the plugin as today). Where the phone is
// comes from the feed itself (READY's own voice state, then its own
// `voice_state_updated`); before that every perms change counts.
//
// Any person's own Connect login (a paired phone's device session too) may
// read the feed; a Voice & Chat only login's is narrowed to its room. A
// refusal (403 for a login it is not for, 404 on a K2 without it) logs
// "recording feed unavailable <code>" once and the call carries on with
// today's reads (connect, room change, recording change, access_changed).
// Closes: 4000 (CLOSE_RESET) reconnects at once (a fresh READY follows);
// 4001 (CLOSE_LOGIN_ENDED) is the login gone: whoami on that server
// (revive, background) and "Sign in again" when it is dead; a drop
// reconnects with backoff while the call lasts.

export const FEED_EVENT = "k2-voice://feed";
export const FEED_CLOSE_RESET = 4000;
export const FEED_CLOSE_LOGIN_ENDED = 4001;
/** Several perms changes in a row: one re-read. */
export const FEED_PERMS_DEBOUNCE_MS = 300;
/** Reconnect pauses after a drop; the last repeats. */
export const FEED_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;

export type FeedEvent =
  | { kind: "open" }
  | { kind: "ready" | "mine"; channel: string | null; space: string | null }
  | { kind: "perms"; channels: string[]; space: string | null }
  | { kind: "refused" | "closed"; code: number };

type Tagged = FeedEvent & { server: string; n: number };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** One `k2-voice://feed` payload, or null. */
export function parseFeedEvent(v: unknown): Tagged | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const server = str(r.server);
  const n = typeof r.n === "number" ? r.n : null;
  if (!server || n === null) return null;
  switch (r.kind) {
    case "open":
      return { kind: "open", server, n };
    case "ready":
    case "mine":
      return { kind: r.kind as "ready" | "mine", channel: str(r.channel), space: str(r.space), server, n };
    case "perms":
      return {
        kind: "perms",
        channels: Array.isArray(r.channels) ? r.channels.filter((c): c is string => typeof c === "string") : [],
        space: str(r.space),
        server,
        n,
      };
    case "refused":
    case "closed":
      return { kind: r.kind as "refused" | "closed", code: typeof r.code === "number" ? r.code : 0, server, n };
    default:
      return null;
  }
}

/** Does a perms change concern the call (pure)? Unknown whereabouts: yes. */
export function permsConcernCall(
  ev: { channels: string[]; space: string | null },
  mine: { channel: string | null; space: string | null }
): boolean {
  if (!mine.channel) return true;
  if (ev.channels.includes(mine.channel)) return true;
  return !!ev.space && ev.space === mine.space;
}

export interface FeedDeps {
  open: (serverId: string) => Promise<number | null>;
  close: () => void;
  listen: (fn: (payload: unknown) => void) => Promise<() => void>;
  note: (words: string[]) => void;
  revive: (serverId: string) => Promise<ReviveOutcome>;
  signin: (serverId: string) => void;
}

const LIVE: FeedDeps = {
  open: async (server) => {
    try {
      const n = await invoke<number | null>("voice_feed_open", { server });
      return typeof n === "number" ? n : null;
    } catch {
      return null;
    }
  },
  close: () => void invoke("voice_feed_close").catch(() => {}),
  listen: (fn) => listen(FEED_EVENT, (e) => fn(e.payload)),
  note: callLogNote,
  revive: (id) => revive(scopeFor(id), { background: true }),
  signin: (id) => emitServerSignal(id, "signin"),
};

export type FeedHandle = { stop: () => void };

/** Follow `serverId`'s feed while the call lasts; `onPerms` re-reads the
 *  recording rights. Never throws. */
export function startRecordingFeed(serverId: string, onPerms: () => void, deps: FeedDeps = LIVE): FeedHandle {
  let stopped = false;
  let current: number | null = null;
  let attempt = 0;
  let mine: { channel: string | null; space: string | null } = { channel: null, space: null };
  let retry: ReturnType<typeof setTimeout> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let unlisten: (() => void) | null = null;
  /** An open is on its way: its events may beat its number here. */
  let dialing = false;
  let early: Tagged[] = [];
  /** A READY was seen: the next one follows a reconnect. */
  let seenReady = false;

  const reread = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (!stopped) onPerms();
    }, FEED_PERMS_DEBOUNCE_MS);
  };

  const end = () => {
    current = null;
    if (retry) clearTimeout(retry);
    retry = null;
  };

  const dial = async () => {
    retry = null;
    if (stopped) return;
    dialing = true;
    early = [];
    const n = await deps.open(serverId);
    dialing = false;
    const held = early;
    early = [];
    if (stopped) {
      if (n !== null) deps.close();
      return;
    }
    if (n === null) return; // no address or token here (or off iOS): today's reads
    current = n;
    for (const ev of held) if (ev.n === n) handle(ev);
  };

  const later = (ms: number) => {
    if (stopped || retry) return;
    retry = setTimeout(() => void dial(), ms);
  };

  const onEvent = (payload: unknown) => {
    const ev = parseFeedEvent(payload);
    if (stopped || !ev || ev.server !== serverId) return;
    if (dialing && current === null) {
      early.push(ev);
      return;
    }
    if (ev.n === current) handle(ev);
  };

  const handle = (ev: Tagged) => {
    switch (ev.kind) {
      case "open":
        return;
      case "ready":
        attempt = 0;
        mine = { channel: ev.channel, space: ev.space };
        // Back after a drop: a perms change may have gone by meanwhile.
        if (seenReady) reread();
        seenReady = true;
        return;
      case "mine":
        mine = { channel: ev.channel, space: ev.space };
        return;
      case "perms":
        if (!permsConcernCall(ev, mine)) return;
        deps.note(["recording", "perms_changed"]);
        reread();
        return;
      case "refused":
        end();
        if (ev.code === 429 || ev.code >= 500) {
          later(FEED_RETRY_MS[Math.min(attempt++, FEED_RETRY_MS.length - 1)]);
          return;
        }
        deps.note(["recording", "feed", "unavailable", String(ev.code)]);
        return;
      case "closed":
        end();
        if (ev.code === FEED_CLOSE_LOGIN_ENDED) {
          deps.note(["recording", "feed", "login_ended"]);
          void deps
            .revive(serverId)
            .then((outcome) => {
              if (outcome === "signin-required" || outcome === "not-applicable") deps.signin(serverId);
            })
            .catch(() => {});
          return;
        }
        // Reset: at once after a READY (the READY that follows re-reads);
        // resets in a row without one back off.
        if (ev.code === FEED_CLOSE_RESET) {
          const ms = attempt === 0 ? 0 : FEED_RETRY_MS[Math.min(attempt - 1, FEED_RETRY_MS.length - 1)];
          attempt += 1;
          later(ms);
          return;
        }
        later(FEED_RETRY_MS[Math.min(attempt++, FEED_RETRY_MS.length - 1)]);
        return;
    }
  };

  void deps
    .listen(onEvent)
    .then((un) => {
      if (stopped) un();
      else unlisten = un;
    })
    .catch(() => {})
    .then(() => dial());

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (debounce) clearTimeout(debounce);
      debounce = null;
      const was = current;
      end();
      unlisten?.();
      unlisten = null;
      if (was !== null) deps.close();
    },
  };
}
