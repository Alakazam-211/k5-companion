import { useRef } from "react";
import { authorHue } from "../lib/authorTint";
import { skinInitials } from "./agentRow";
import type { StubAgent } from "./stubData";

// Profile pictures in a Thread (the owner's rule, agreed with K2 Design
// 2026-11-09, desktop the same): on once the messages loaded in the Thread
// (every fetched page and sends in flight) come from two or more senders
// other than me (`mine`, so my other devices are me; system and bot lines
// count). Once on they stay on while that Thread is open, and reset on a
// switch. Every bubble from someone else gets the column, so they line up;
// the picture draws once per run, on its LAST bubble, at the bottom left,
// level with the tail (Riley 2026-11-18, the phone-chat place; K2
// a096cbc1d2). The name line stays over the first bubble. A run ends
// where the tail does (another sender, you, a 120 s gap, a deleted line:
// chatReceipt.ts); a deleted line draws no picture. A new message from the
// same sender takes the picture down to it (no animation: it just moves;
// pictureRows, chatReceipt.ts).
// The picture sits against the bubble, so files or reactions under it never
// push it down. The column eases in and out as K2's does (chatBubbles.css,
// K2 threadSenders.tsx).
//
// Home chat (homeChatRows, HomeChatMessageRow): always on in a channel,
// never in a DM (only one other person); same place and size.

export const THREAD_PICTURE_PX = 28;
export const THREAD_PICTURE_GAP = 8;

export function otherSenderCount(rows: readonly { mine: boolean; from: string }[]): number {
  const seen = new Set<string>();
  for (const r of rows) if (!r.mine) seen.add(r.from.trim().toLowerCase());
  return seen.size;
}

/** On at two other senders, staying on for this Thread (`threadKey`). */
export function useThreadPicturesOn(threadKey: string, others: number): boolean {
  const held = useRef<{ key: string; on: boolean }>({ key: threadKey, on: false });
  if (held.current.key !== threadKey) held.current = { key: threadKey, on: false };
  if (others >= 2) held.current.on = true;
  return held.current.on;
}

export type SenderPicture = { initial: string; color: string | null; iconUrl: string | null };

/** A sender's picture: the agent of that name or handle on this server, or
 *  initials on the same per-name hue the cards use. */
export function senderPicture(from: string, agents: readonly StubAgent[]): SenderPicture {
  const key = from.trim().toLowerCase();
  const agent = agents.find(
    (a) => a.kind !== "group" && (a.name.trim().toLowerCase() === key || (a.addr || "").trim().toLowerCase() === key)
  );
  if (agent) return { initial: agent.initial, color: agent.color ?? null, iconUrl: agent.iconUrl ?? null };
  return { initial: skinInitials(from || "?"), color: `hsl(${authorHue(key || "?")}, 38%, 42%)`, iconUrl: null };
}

/** The name above someone else's bubble: the agent whose handle (`addr`)
 *  is `from`, by that row's display name, since a handle can change while
 *  the name stays (K2 2026-11-10: the review box's re-hired demo agent).
 *  No match (a person, a bot, an agent not on this server): `from` as is. */
export function senderLabel(from: string, agents: readonly StubAgent[]): string {
  const key = from.trim().toLowerCase();
  if (!key) return from;
  const agent = agents.find((a) => a.kind !== "group" && (a.addr || "").trim().toLowerCase() === key);
  return agent?.name.trim() || from;
}
