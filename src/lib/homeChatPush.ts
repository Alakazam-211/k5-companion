import { invoke, isTauri } from "@tauri-apps/api/core";
import { compareSewIds, isSewId } from "../api/homeChatPure";
import type { HomeChatTarget } from "../zen/homeChat/homeChatModel";

// Home chat pushes on the phone (K2 0.46.16 `home-chat-push-v1`; K2's Home
// chat push rules, 0.46.16). The pure rules
// the native side keeps too, so they are tested here:
//
//   - The notification group: `hc:<server>:<conversationId>`, so the same
//     channel id on two servers never merges. The NSE
//     (NotificationService.swift `homeChatServerKey`) picks the server the
//     same way: the push's `badgeKey` (stable per person per server), else
//     the saved server that opened it (`k2ServerId`), else its tunnel label,
//     else its `instanceId` (last: a daemon mints a new one on every start,
//     so a restart would split a conversation's banners).
//   - Read-clear: the badge nudge's `data.read` carries
//     `h:<conversationId>:<messageId>`; that conversation's notifications at
//     or below the id go. Sew ids are decimal strings that fit i64; they are
//     compared as numbers (length, then digits), never as JS numbers (a
//     double loses digits past 2^53). K2DeliveredClear.swift parses them to
//     Int (64-bit on every iOS device), the same order.
//   - A tap: a DM or a channel on the push's own server; the generic lane
//     (no conversation) opens Home.
//   - The open chat: the native side hears which one is on screen, so a push
//     for it that slips through shows no banner (the viewing lease should
//     stop it at the daemon).

/** Push `data.kind` for a Home chat message. */
export const HOME_CHAT_PUSH_KIND = "home_chat";

function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** The server part of a Home chat notification's group (see above). */
export function homeChatServerKey(info: Record<string, unknown>): string | null {
  const badgeKey = str(info.badgeKey);
  if (badgeKey) return badgeKey;
  const saved = str(info.k2ServerId);
  if (saved) return saved;
  const sub = str(info.subdomain).toLowerCase();
  if (sub) return sub;
  const iid = str(info.instanceId);
  return iid || null;
}

/** `hc:<server>:<conversationId>`; null without a conversation (the generic
 *  lane) or a server. */
export function homeChatThreadId(info: Record<string, unknown>): string | null {
  if (str(info.kind) !== HOME_CHAT_PUSH_KIND) return null;
  const conv = str(info.conversationId);
  const server = homeChatServerKey(info);
  if (!isSewId(conv) || !server) return null;
  return `hc:${server}:${conv}`;
}

export type ReadHint = { kind: "thread" | "project" | "home"; id: string; upTo: string };

/** `t:<conv>:<seq>,p:<group>:<seq>,h:<conv>:<message id>` (K2 0.46.8
 *  `push-read-hints-v1`; `h:` from 0.46.16): the kind before the first ':',
 *  the number after the last. Junk parts are dropped. */
export function parseReadHints(raw: unknown): ReadHint[] {
  if (typeof raw !== "string") return [];
  const out: ReadHint[] = [];
  for (const p of raw.split(",")) {
    const first = p.indexOf(":");
    const last = p.lastIndexOf(":");
    if (first < 0 || first >= last) continue;
    const k = p.slice(0, first);
    const kind = k === "t" ? "thread" : k === "p" ? "project" : k === "h" ? "home" : null;
    const id = p.slice(first + 1, last);
    const upTo = p.slice(last + 1);
    if (!kind || !id || !/^\d+$/.test(upTo)) continue;
    // A Sew id is 1-20 digits; K2 refuses anything longer for the "seq".
    if (kind === "home" && !isSewId(upTo)) continue;
    out.push({ kind, id, upTo });
  }
  return out;
}

/** Is a Home chat notification for message `noteId` read by a hint up to
 *  `readUpTo`? Both Sew ids; no id on the note (the generic lane) is never
 *  covered by a read (only the count reaching 0 clears it). */
export function homeNoteCovered(noteId: string | null | undefined, readUpTo: string): boolean {
  const n = str(noteId).replace(/^0+(?=\d)/, "");
  const r = readUpTo.replace(/^0+(?=\d)/, "");
  if (!isSewId(n) || !isSewId(r)) return false;
  return compareSewIds(n, r) <= 0;
}

/** What a badge push does to Home chat notifications: the hinted ones, and
 *  all of them once the person's unread Home count reaches 0. */
export function homeClearPlan(hints: readonly ReadHint[], homeUnread: unknown): { read: ReadHint[]; clearAll: boolean } {
  const n = str(homeUnread);
  return { read: hints.filter((h) => h.kind === "home"), clearAll: n !== "" && /^\d+$/.test(n) && Number(n) === 0 };
}

/** A Home chat notification's tap fields (all strings). */
export interface HomeChatTap {
  kind?: string;
  conversationId?: string;
  convKind?: string;
  senderExt?: string;
  senderName?: string;
  channelName?: string;
}

/** The chat a Home chat tap opens on `serverId`; null for the generic lane
 *  (no conversation: open Home). */
export function homeChatTapTarget(tap: HomeChatTap, serverId: string): HomeChatTarget | null {
  const conv = str(tap.conversationId);
  if (!serverId || !isSewId(conv)) return null;
  if (str(tap.convKind) === "dm") {
    const ext = str(tap.senderExt);
    return { serverId, kind: "dm", conversationId: conv, title: str(tap.senderName), ext: ext || null };
  }
  return { serverId, kind: "channel", conversationId: conv, title: str(tap.channelName), inviteOnly: null };
}

/** Tell the native side which Home chat is on screen (null: none), so a
 *  push for it shows no banner while the app is in front. iOS only; quiet
 *  everywhere else. */
export function setNativeHomeChatViewing(serverId: string | null, conv: string | null): void {
  try {
    if (!isTauri()) return;
    void invoke("plugin:k2-push|notification_op", {
      op: "homeChatViewing",
      server: serverId && conv ? serverId : "",
      conv: serverId && conv ? conv : "",
    }).catch(() => {});
  } catch {
    /* no native side */
  }
}
