import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const controls = vi.hoisted(() => vi.fn());
vi.mock("./voiceApi", async (orig) => ({ ...(await orig<typeof import("./voiceApi")>()), fetchRecordingControls: controls }));
vi.mock("../../api/scope", () => ({ scopeFor: (id: string) => ({ id }) }));

import {
  onPluginParticipants,
  onPluginState,
  onRecordingControls,
  onRecordingEvent,
  parseCallRecording,
  parseRecordingControls,
  readRecordingRights,
  recordingButtons,
  recordingCommand,
  resetCallRecording,
  useCallRecording,
} from "./callRecording";
import { parseRecordingControlsAnswer, recordingErrorText, recordingNoticeText, recordUnavailableText } from "./voiceWire";

const answer = (rights: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  ok: true,
  answer: { rights, voiceChatOnly: false, agentReaders: false, recordCalls: true, manageChannels: false, ...extra },
});
const RIGHTS = { room: "standup", my_perms: "8192", dm: false, recording_enabled: true, record_capped: false, agent: false };
const cmds = (name: string) => invoke.mock.calls.filter(([c]) => c === name).map(([, a]) => a);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetCallRecording();
  invoke.mockReset().mockResolvedValue(null);
  controls.mockReset();
});

describe("Record and Stop (K2 0.46.11, plugin 0.9.1)", () => {
  it("reads the controls answer's rights exactly, nulls left out (K2 hasn't seen Sew's policies)", () => {
    const a = parseRecordingControlsAnswer(
      {
        ok: true,
        room: "standup",
        channelId: "48831765147549720",
        myPerms: "8192",
        recordCalls: true,
        manageChannels: false,
        agentReaders: true,
        rights: { dm: false, recordingEnabled: null, recordingDmEnabled: false, recordCapped: true, agent: false },
      },
      "standup"
    );
    expect(a).toEqual({
      rights: { room: "standup", my_perms: "8192", dm: false, recording_dm_enabled: false, record_capped: true, agent: false },
      voiceChatOnly: false,
      agentReaders: true,
      recordCalls: true,
      manageChannels: false,
    });
    // A Voice & Chat only login: no rights to hand over.
    expect(parseRecordingControlsAnswer({ ok: true, voiceChatOnly: true, recordCalls: false }, "standup")).toMatchObject({
      rights: null,
      voiceChatOnly: true,
    });
    expect(() => parseRecordingControlsAnswer(null, "standup")).toThrow();
  });

  it("reads the plugin's payloads: controls with Sew's source and hint, the recording's snake_case keys", () => {
    expect(parseRecordingControls({ can_record: true, can_stop: false })).toEqual({
      canRecord: true,
      canStop: false,
      source: "host",
      recordUnavailable: null,
    });
    expect(parseRecordingControls({ can_record: true, can_stop: false, source: "sew", record_unavailable: "recording_capacity" })).toEqual({
      canRecord: true,
      canStop: false,
      source: "sew",
      recordUnavailable: "recording_capacity",
    });
    // The hint only while Record is allowed.
    expect(parseRecordingControls({ can_record: false, can_stop: false, record_unavailable: "recording_capacity" })?.recordUnavailable).toBeNull();
    expect(parseRecordingControls({ can_record: "yes" })).toBeNull();
    const r = parseCallRecording({
      recording_id: "r1",
      recorder_present: true,
      can_stop: true,
      my_consent: "granted",
      trigger: "required",
      required: true,
      started_at: "2026-11-02T09:58:00.000Z",
      audio_keep_days: 30,
    });
    expect(r).toEqual({
      recordingId: "r1",
      live: true,
      trigger: "required",
      required: true,
      canRecord: false,
      canStop: true,
      startedAt: Date.parse("2026-11-02T09:58:00.000Z"),
      audioKeepDays: 30,
    });
    // Absent fields read as unknown, never 0.
    expect(parseCallRecording({ recording_id: "auto" })).toMatchObject({ trigger: "manual", startedAt: null, audioKeepDays: null });
    // Never camelCase: that's Rust's own sheet, not the plugin's event.
    expect(parseCallRecording({ recordingId: "r1" })).toBeNull();
    expect(parseCallRecording(null)).toBeNull();
  });

  it("shows only what the plugin says: its controls, else the recording's own, else nothing", () => {
    const recording = parseCallRecording({ recording_id: "r1", recorder_present: true, can_stop: true, my_consent: "granted" });
    const none = { controls: null, recording: null, off: false, people: 1 };
    expect(recordingButtons(none)).toEqual({ canRecord: false, canStop: false, recordUnavailable: null });
    expect(recordingButtons({ ...none, recording })).toMatchObject({ canRecord: false, canStop: true });
    const controls = parseRecordingControls({ can_record: true, can_stop: false });
    expect(recordingButtons({ ...none, controls, recording })).toMatchObject({ canRecord: true, canStop: false });
    expect(recordingButtons({ ...none, controls, recording, off: true })).toMatchObject({ canRecord: false, canStop: false });
  });

  it("never offers Stop for a recording the room requires while two or more are in the call", () => {
    const required = parseCallRecording({ recording_id: "r1", trigger: "required", required: true, can_stop: true });
    const controls = parseRecordingControls({ can_record: false, can_stop: true });
    expect(recordingButtons({ controls, recording: required, off: false, people: 1 }).canStop).toBe(true);
    expect(recordingButtons({ controls, recording: required, off: false, people: 2 }).canStop).toBe(false);
    onRecordingEvent({ recording_id: "r1", trigger: "required", required: true, can_stop: true });
    onPluginParticipants([{ member_id: "a" }, { member_id: "b" }]);
    expect(recordingButtons(useCallRecording.getState()).canStop).toBe(false);
  });

  it("follows the plugin: a move clears the controls, the call's end clears everything", () => {
    onPluginState({ state: "connected", room: "standup" });
    onRecordingControls({ can_record: true, can_stop: false, source: "sew" });
    expect(useCallRecording.getState().controls?.canRecord).toBe(true);
    onPluginState({ state: "connected", room: "standup" });
    expect(useCallRecording.getState().controls).not.toBeNull();
    onPluginState({ state: "connected", room: "4999" });
    expect(useCallRecording.getState()).toMatchObject({ room: "4999", controls: null });
    onRecordingEvent({ recording_id: "r1" });
    onPluginState({ state: "ended", reason: "left" });
    expect(useCallRecording.getState()).toMatchObject({ room: null, controls: null, recording: null, off: false });
  });

  it("reads the rights and hands them to the plugin unchanged, for the plugin's own name of the room", async () => {
    controls.mockResolvedValue(answer(RIGHTS));
    await readRecordingRights("s1", "standup", "4999");
    expect(controls).toHaveBeenCalledWith({ id: "s1" }, "standup");
    expect(cmds("plugin:sew-voice|set_recording_rights")).toEqual([{ ...RIGHTS, room: "4999" }]);
    await flush();
    expect(cmds("voice_note")).toContainEqual({
      words: ["recording", "rights", "ok", "record_calls:true", "enabled:true", "capped:false"],
    });
  });

  it("a K2 before 0.46.11 (404): no buttons, nothing handed over", async () => {
    controls.mockResolvedValue({ ok: false, code: "unsupported", status: 404 });
    await readRecordingRights("s1", "standup");
    expect(useCallRecording.getState().off).toBe(true);
    onRecordingControls({ can_record: true, can_stop: true });
    expect(recordingButtons(useCallRecording.getState())).toMatchObject({ canRecord: false, canStop: false });
    expect(cmds("plugin:sew-voice|set_recording_rights")).toEqual([]);
    await flush();
    expect(cmds("voice_note")).toContainEqual({ words: ["recording", "rights", "unsupported", "http_404"] });
  });

  it("a failed read leaves the buttons as the plugin says", async () => {
    controls.mockResolvedValue({ ok: false, code: "failed", status: 500 });
    await readRecordingRights("s1", "standup");
    expect(useCallRecording.getState().off).toBe(false);
  });

  it("a Voice & Chat only login never records", async () => {
    controls.mockResolvedValue(answer(null, { voiceChatOnly: true, recordCalls: false }));
    await readRecordingRights("s1", "standup");
    onRecordingControls({ can_record: true, can_stop: true });
    expect(recordingButtons(useCallRecording.getState())).toMatchObject({ canRecord: false, canStop: false });
    expect(cmds("plugin:sew-voice|set_recording_rights")).toEqual([]);
  });

  it("Record → start_recording, Stop → stop_recording (no arguments); a refusal in K2's words", async () => {
    await recordingCommand("start");
    expect(invoke).toHaveBeenLastCalledWith("plugin:sew-voice|start_recording");
    await recordingCommand("stop");
    expect(invoke).toHaveBeenLastCalledWith("plugin:sew-voice|stop_recording");
    invoke.mockRejectedValueOnce({ code: "recording_active" });
    await recordingCommand("start");
    expect(useCallRecording.getState()).toMatchObject({ busy: false, error: "This call is already being recorded." });
  });

  it("words K2's notice for its rooms as desktop does", () => {
    const facts = { startedByName: null, required: true, audioKeepDays: 1, appReaders: ["Notes"], agentReaders: false };
    const join = recordingNoticeText("Standup", { ask: "join", ...facts }, true);
    expect(join).toEqual({
      title: "Standup is being recorded",
      lines: [
        "This room records every call with more than one person.",
        "Everyone's voice is recorded and transcribed. The transcript is kept in this room's chat.",
        "The audio is kept for 1 day.",
        "Notes can read the transcript.",
        "Agents on this server may read the transcript.",
        "Joining means being recorded.",
      ],
      ok: "OK",
      leave: "Don't join",
    });
    const inCall = recordingNoticeText("Standup", { ask: "in_call", ...facts, required: false, appReaders: [] }, false);
    expect(inCall.title).toBe("This call is being recorded");
    expect(inCall.lines[0]).toBe("This room records its calls.");
    expect(inCall.lines).not.toContain("Agents on this server may read the transcript.");
    expect(inCall.lines[inCall.lines.length - 1]).toBe("Staying in the call means being recorded.");
    expect(inCall.leave).toBe("Leave call");
  });

  it("says a refusal and Sew's hint in plain words", () => {
    expect(recordingErrorText("start", "recording_active")).toBe("This call is already being recorded.");
    expect(recordingErrorText("start", "recording_disabled")).toBe("Recording is off on this server.");
    expect(recordingErrorText("stop", "recording_required")).toMatch(/keeps going while two or more are here/);
    expect(recordingErrorText("stop", "boom")).toBe("K2 couldn't stop the recording.");
    expect(recordUnavailableText(null)).toBeNull();
    expect(recordUnavailableText("recording_capacity")).toMatch(/busy/);
    expect(recordUnavailableText("recorder_unavailable")).toMatch(/recorder isn't available/);
  });
});
