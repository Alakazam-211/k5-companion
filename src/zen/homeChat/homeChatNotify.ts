// What this person's phone gets for a Home chat (K2 0.46.16
// `home-chat-push-v1`): a channel's push level (All messages or @mentions
// only; Riley: two choices, no Off, mute stays separate; DMs always
// notify) and the person's push prefs on a server (Show message text).
//
// The levels live in Sew; the daemon reads and writes them
// (`/cli/home-chat/notify*`) and its `notify` frame keeps every device in
// step (`applyHomeChatNotifyFrame`, from the chat view's events). A pick
// shows at once and goes back, with the server's words, when it's refused.
// Memory only: the setting reads the server again when it opens.

import { create } from "zustand";
import type { ServerScope } from "../../api/scope";
import { fetchHomeChatNotify, fetchHomeChatPushPrefs, setHomeChatNotify, setHomeChatPushPrefs } from "../../api/homeChat";
import {
  applyHomeChatNotifyFrame as mergeFrame,
  type HomeChatNotify,
  type HomeChatNotifyChoice,
  type HomeChatNotifyFrame,
  type HomeChatPushPrefs,
} from "../../api/homeChatPure";
import { convKey } from "./homeChatModel";
import { refusalText } from "./homeChatActions";

// ─── Copy (short, plain) ───

export const NOTIFY_HEADING = "Notifications";
export const NOTIFY_ALL = "All messages";
export const NOTIFY_MENTIONS = "@mentions only";
/** All messages picked while the server can't push every message yet. */
export const NOTIFY_ALL_PENDING = "For now this works like @mentions only.";
/** A level of `none`, set in another chat app. */
export const NOTIFY_OFF_ELSEWHERE = "Off (set elsewhere).";
/** The server fixed it (a DM; nothing to pick). */
export const NOTIFY_FIXED = "Set by the server.";
export const NOTIFY_MUTED = "This channel is muted.";

// ─── The view model (pure) ───

export interface NotifyChoiceView {
  level: HomeChatNotifyChoice;
  label: string;
  checked: boolean;
}

export interface NotifySettingView {
  choices: NotifyChoiceView[];
  /** Read-only (`fixed`): the choices show, none can be picked. */
  readOnly: boolean;
  /** One quiet line under the choices, or null. */
  note: string | null;
}

/** What the setting draws for `n` (null: still reading, nothing checked). */
export function notifySettingView(n: HomeChatNotify | null): NotifySettingView {
  const level = n?.level ?? null;
  const choices: NotifyChoiceView[] = [
    { level: "all", label: NOTIFY_ALL, checked: level === "all" },
    { level: "mentions", label: NOTIFY_MENTIONS, checked: level === "mentions" },
  ];
  let note: string | null = null;
  if (n) {
    if (level === "none") note = NOTIFY_OFF_ELSEWHERE;
    else if (level === "all" && !n.allMessagesLive) note = NOTIFY_ALL_PENDING;
    else if (n.fixed) note = NOTIFY_FIXED;
    if (n.muted) note = note ? `${note} ${NOTIFY_MUTED}` : NOTIFY_MUTED;
  }
  return { choices, readOnly: !!n?.fixed, note };
}

// ─── The store ───

interface NotifyState {
  /** convKey → the level as last read (or picked). */
  byConv: Record<string, HomeChatNotify>;
  /** serverId → this person's push prefs there. */
  prefs: Record<string, HomeChatPushPrefs>;
}

export const useHomeChatNotify = create<NotifyState>(() => ({ byConv: {}, prefs: {} }));

const put = (key: string, n: HomeChatNotify | null): void =>
  useHomeChatNotify.setState((s) => {
    const byConv = { ...s.byConv };
    if (n) byConv[key] = n;
    else delete byConv[key];
    return { byConv };
  });

/** Read a conversation's level. The refusal's words, or null. */
export async function refreshHomeChatNotify(scope: ServerScope, conv: string): Promise<string | null> {
  const r = await fetchHomeChatNotify(scope, conv);
  if (!r.ok) return refusalText(r);
  put(convKey(scope.id, conv), r.notify);
  return null;
}

const pickGen = new Map<string, number>();

/** Pick a channel's level: at once, then the server's answer; a refusal
 *  puts the last one back. The refusal's words, or null. */
export async function pickHomeChatNotify(scope: ServerScope, conv: string, level: HomeChatNotifyChoice): Promise<string | null> {
  const key = convKey(scope.id, conv);
  const before = useHomeChatNotify.getState().byConv[key] ?? null;
  if (before?.fixed) return null;
  const gen = (pickGen.get(key) ?? 0) + 1;
  pickGen.set(key, gen);
  if (before) put(key, { ...before, level, effective: level, inherited: false });
  const r = await setHomeChatNotify(scope, conv, level);
  // A newer pick owns the row now.
  if (pickGen.get(key) !== gen) return r.ok ? null : refusalText(r);
  if (!r.ok) {
    put(key, before);
    return refusalText(r);
  }
  put(key, r.notify);
  return null;
}

/** The events socket's `notify` frame: a level changed on any device. A
 *  frame for a conversation never read here is read from the route when
 *  its setting opens. */
export function applyHomeChatNotifyFrame(serverId: string, f: HomeChatNotifyFrame): void {
  const key = convKey(serverId, f.conv);
  const held = useHomeChatNotify.getState().byConv[key];
  if (!held) return;
  const next = mergeFrame(held, f);
  if (next) put(key, next);
}

/** Read this person's push prefs on a server. The refusal's words, or null. */
export async function refreshHomeChatPushPrefs(scope: ServerScope): Promise<string | null> {
  const r = await fetchHomeChatPushPrefs(scope);
  if (!r.ok) return refusalText(r);
  useHomeChatNotify.setState((s) => ({ prefs: { ...s.prefs, [scope.id]: r.prefs } }));
  return null;
}

/** Show message text on or off: at once, then the server's answer; a
 *  refusal puts it back. The refusal's words, or null. */
export async function setHomeChatTextPref(scope: ServerScope, on: boolean): Promise<string | null> {
  const before = useHomeChatNotify.getState().prefs[scope.id] ?? null;
  if (before) useHomeChatNotify.setState((s) => ({ prefs: { ...s.prefs, [scope.id]: { ...before, previews: on } } }));
  const r = await setHomeChatPushPrefs(scope, { previews: on });
  if (!r.ok) {
    useHomeChatNotify.setState((s) => {
      const prefs = { ...s.prefs };
      if (before) prefs[scope.id] = before;
      else delete prefs[scope.id];
      return { prefs };
    });
    return refusalText(r);
  }
  useHomeChatNotify.setState((s) => ({ prefs: { ...s.prefs, [scope.id]: r.prefs } }));
  return null;
}

/** Tests only. */
export function __resetHomeChatNotifyForTests(): void {
  pickGen.clear();
  useHomeChatNotify.setState({ byConv: {}, prefs: {} });
}
