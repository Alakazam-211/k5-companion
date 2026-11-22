import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { scopeFor } from "../../api/scope";
import { fetchRecordingControls } from "./voiceApi";
import { recordingErrorText } from "./voiceWire";

// Record and Stop in a call (K2 0.46.11; tauri-plugin-sew-voice 0.9.1,
// Sew 0.11.1; the owner asked for desktop's). The plugin decides which of
// the two to show:
//   - against a Sew that computes them (Sew 0.10+), from Sew itself: the
//     `recording_controls` event carries `source: "sew"`; both are false
//     until Sew's first value, and a move clears them until the new room's
//     arrives;
//   - otherwise from the rights K2 hands it: the phone reads them (`POST
//     /cli/voice/recording/controls {room}`) and passes them on unchanged
//     (`set_recording_rights`). The phone sends them either way: the
//     plugin keeps them for a Sew that sends none.
// The phone follows the plugin's `recording_controls` event (before its
// first one, the `recording` event's `can_record` / `can_stop`, written only
// when true). K2 adds no rule of its own; no word from the plugin shows
// neither. Record and Stop go back through the plugin (`start_recording` /
// `stop_recording`, no arguments) to the native join provider (voice.rs
// `recording`), which posts them to K2's `/cli/voice/recording/start|stop`
// with the phone's token; the `recording` event follows. A K2 before 0.46.11
// answers the controls read 404: no buttons. A Voice & Chat only login
// never records.
//
// Rights are read again (as desktop's readRecordingPerms): on connecting,
// when the call's room changes (a moderator's move: the plugin forgets the
// old room's rights), whenever the call's recording changes, and on K2's
// `access_changed`. Every read and every controls event goes into the call
// log ("Send call log"), so a missing button can be told apart: no rights
// route, a Voice & Chat login, rights without RECORD_CALLS or with
// recording off, or the plugin (or Sew) saying neither.

const CMD = "plugin:sew-voice|";

export type RecordingButtons = { canRecord: boolean; canStop: boolean };

/** The plugin's `recording_controls` (plugin 0.6.1; `source` and
 *  `recordUnavailable` from 0.7.0). */
export type PluginControls = RecordingButtons & {
  /** `sew`: Sew computed them; `host`: the plugin did, from K2's rights. */
  source: "sew" | "host";
  /** Sew's hint while Record is allowed but would be refused for now
   *  (`recording_capacity`, `recorder_unavailable`). */
  recordUnavailable: string | null;
};

/** The call's active recording (the plugin's `recording` event), as the
 *  call screen shows it. */
export type CallRecordingNow = {
  recordingId: string;
  /** The recorder is in the call's media: recording now. */
  live: boolean;
  /** `manual`, `auto` or `required` (absent: `manual`). */
  trigger: string;
  /** The room requires its recording: no Stop while two or more are in it. */
  required: boolean;
  canRecord: boolean;
  canStop: boolean;
  /** When it started, by Sew's clock (unix ms); `null`: unknown. */
  startedAt: number | null;
  /** Days Sew keeps the audio (0: deleted once transcribed); `null`: unknown. */
  audioKeepDays: number | null;
};

type CallRecording = {
  /** The plugin's last `recording_controls` (null until its first, and
   *  again after a move). */
  controls: PluginControls | null;
  recording: CallRecordingNow | null;
  /** The call's room as the plugin names it (its `state` event's `room`;
   *  a moderator's move changes it). `null` before the first. */
  room: string | null;
  /** People in the call (the plugin's roster). */
  people: number;
  /** No Record or Stop here: an older K2, or a Voice & Chat only login. */
  off: boolean;
  /** Record or Stop on its way. */
  busy: boolean;
  /** A refusal to show, in K2's words. */
  error: string | null;
};

const CLEAN: CallRecording = { controls: null, recording: null, room: null, people: 0, off: false, busy: false, error: null };

export const useCallRecording = create<CallRecording>(() => ({ ...CLEAN }));

/** A call ended or a new one starts: nothing carries over. */
export function resetCallRecording(): void {
  useCallRecording.setState({ ...CLEAN });
}

/** One call-log line (codes only; Rust keeps nothing else). */
function note(words: string[]): void {
  void Promise.resolve()
    .then(() => invoke("voice_note", { words }))
    .catch(() => {});
}

/** The plugin's `recording_controls` payload. */
export function parseRecordingControls(v: unknown): PluginControls | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.can_record !== "boolean" || typeof r.can_stop !== "boolean") return null;
  return {
    canRecord: r.can_record,
    canStop: r.can_stop,
    source: r.source === "sew" ? "sew" : "host",
    recordUnavailable: r.can_record && typeof r.record_unavailable === "string" ? r.record_unavailable : null,
  };
}

/** The plugin's `recording` payload (null: no active recording). Its keys
 *  are snake_case (`recording_id`, `started_at`, …). */
export function parseCallRecording(v: unknown): CallRecordingNow | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.recording_id !== "string" || !r.recording_id) return null;
  const at = typeof r.started_at === "string" ? Date.parse(r.started_at) : NaN;
  return {
    recordingId: r.recording_id,
    live: r.recorder_present === true,
    trigger: typeof r.trigger === "string" ? r.trigger : "manual",
    required: r.required === true,
    canRecord: r.can_record === true,
    canStop: r.can_stop === true,
    startedAt: Number.isFinite(at) ? at : null,
    audioKeepDays: typeof r.audio_keep_days === "number" && r.audio_keep_days >= 0 ? r.audio_keep_days : null,
  };
}

/** Which of Record and Stop to show (desktop's `recordingButtons`), and
 *  Sew's hint for Record. A recording the room requires never offers Stop
 *  while two or more are in the call (Sew refuses it `recording_required`). */
export function recordingButtons(
  s: Pick<CallRecording, "controls" | "recording" | "off" | "people">
): RecordingButtons & { recordUnavailable: string | null } {
  if (s.off) return { canRecord: false, canStop: false, recordUnavailable: null };
  const held = s.recording?.trigger === "required" && s.people >= 2;
  if (s.controls) {
    return {
      canRecord: s.controls.canRecord,
      canStop: s.controls.canStop && !held,
      recordUnavailable: s.controls.canRecord ? s.controls.recordUnavailable : null,
    };
  }
  return {
    canRecord: s.recording?.canRecord === true,
    canStop: s.recording?.canStop === true && !held,
    recordUnavailable: null,
  };
}

export function onRecordingControls(v: unknown): void {
  const c = parseRecordingControls(v);
  if (!c) return;
  note([
    "recording",
    "controls",
    `record:${c.canRecord}`,
    `stop:${c.canStop}`,
    `source:${c.source}`,
    `unavailable:${c.recordUnavailable ?? "none"}`,
  ]);
  useCallRecording.setState({ controls: c });
}

export function onRecordingEvent(v: unknown): void {
  useCallRecording.setState({ recording: parseCallRecording(v) });
}

/** The plugin's `state` event: the call's end clears everything (the
 *  call screen may close and open again mid-call, so this follows the
 *  call, not the screen); a new room (a moderator's move) clears the
 *  controls until the new room's arrive, as the plugin does. */
export function onPluginState(v: unknown): void {
  const p = v && typeof v === "object" ? (v as { room?: unknown; state?: unknown }) : {};
  if (p.state === "ended" || p.state === "idle") {
    resetCallRecording();
    return;
  }
  const room = p.room;
  if (typeof room !== "string" || !room) return;
  const was = useCallRecording.getState().room;
  if (was === room) return;
  useCallRecording.setState(was === null ? { room } : { room, controls: null });
}

/** The plugin's roster: how many are in the call. */
export function onPluginParticipants(rows: unknown): void {
  if (Array.isArray(rows)) useCallRecording.setState({ people: rows.length });
}

/** Read this person's rights in the room and hand them to the plugin.
 *  `askRoom` is what K2's route is asked about (the room's slug when the
 *  phone knows it); `pluginRoom` is the room as the plugin names it, which
 *  the rights must carry for the plugin to use them. A failed read leaves
 *  the buttons as they are; the plugin still decides. */
export async function readRecordingRights(serverId: string, askRoom: string, pluginRoom: string = askRoom): Promise<void> {
  const r = await fetchRecordingControls(scopeFor(serverId), askRoom);
  if (!r.ok) {
    note(["recording", "rights", r.code, `http_${r.status}`]);
    if (r.code === "unsupported") useCallRecording.setState({ off: true });
    return;
  }
  const a = r.answer;
  if (a.voiceChatOnly || !a.rights) {
    note(["recording", "rights", a.voiceChatOnly ? "voice_chat_only" : "no_rights"]);
    useCallRecording.setState({ off: a.voiceChatOnly });
    return;
  }
  const rights = { ...a.rights, room: pluginRoom };
  note([
    "recording",
    "rights",
    "ok",
    `record_calls:${a.recordCalls}`,
    `enabled:${rights.recording_enabled ?? "unknown"}`,
    `capped:${rights.record_capped}`,
  ]);
  useCallRecording.setState({ off: false });
  try {
    await invoke(`${CMD}set_recording_rights`, { ...rights });
  } catch (err) {
    // The plugin refused them (not in that room any more): the next read
    // after the move or the recording's change tries again.
    note(["recording", "rights_set", "refused", codeOf(err)]);
  }
}

function codeOf(err: unknown): string {
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return "failed";
}

/** Record or Stop, the person's own act (Sew decides who may). */
export async function recordingCommand(what: "start" | "stop"): Promise<void> {
  if (useCallRecording.getState().busy) return;
  useCallRecording.setState({ busy: true, error: null });
  try {
    await invoke(`${CMD}${what === "start" ? "start_recording" : "stop_recording"}`);
    useCallRecording.setState({ busy: false });
  } catch (err) {
    const code = codeOf(err);
    note(["recording", what, "refused", code]);
    useCallRecording.setState({ busy: false, error: recordingErrorText(what, code) });
  }
}
