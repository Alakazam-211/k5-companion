import { beforeEach, describe, expect, it, vi } from "vitest";

const scopedFetch = vi.hoisted(() => vi.fn());
vi.mock("../../api/scopedFetch", () => ({ scopedFetch: (...a: unknown[]) => scopedFetch(...a) }));

import type { ServerScope } from "../../api/scope";
import { fetchRecordingControls, isAccessChanged, isK2CallId, leaveVoiceSession, SESSION_LEAVE_TIMEOUT_MS } from "./voiceApi";

const scope = { id: "s1" } as unknown as ServerScope;

beforeEach(() => scopedFetch.mockReset());

// K2's answers §4: `session/leave {callId}`, K2's id always, never blocking.
describe("leaveVoiceSession", () => {
  it("posts K2's vc_ id, in the background, with its own deadline", async () => {
    scopedFetch.mockResolvedValue({ ok: true, status: 200, text: '{"ok":true,"left":true,"already":true}' });
    expect(await leaveVoiceSession(scope, "vc_1f2e")).toBe(true);
    expect(scopedFetch).toHaveBeenCalledWith(scope, "/cli/voice/session/leave", {
      method: "POST",
      body: JSON.stringify({ callId: "vc_1f2e" }),
      priority: "background",
      timeoutMs: SESSION_LEAVE_TIMEOUT_MS,
    });
  });

  it("never without K2's id: none, empty or Sew's digits send nothing", async () => {
    for (const id of ["", "4455", "vc_", " vc_1"]) expect(await leaveVoiceSession(scope, id)).toBe(false);
    expect(scopedFetch).not.toHaveBeenCalled();
    expect(isK2CallId("vc_abc")).toBe(true);
    expect(isK2CallId(null)).toBe(false);
  });

  it("a refusal or a network error is only false (fire and forget)", async () => {
    scopedFetch.mockResolvedValueOnce({ ok: false, status: 404, text: '{"error":{"code":"call_not_found"}}' });
    expect(await leaveVoiceSession(scope, "vc_1")).toBe(false);
    scopedFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await leaveVoiceSession(scope, "vc_1")).toBe(false);
  });
});

// K2 0.46.11: the person's rights in the room, for Record and Stop.
describe("fetchRecordingControls", () => {
  it("posts {room} to recording/controls and reads the rights", async () => {
    scopedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({
        ok: true,
        room: "standup",
        myPerms: "8192",
        recordCalls: true,
        manageChannels: false,
        rights: { dm: false, recordingEnabled: true, recordingDmEnabled: false, recordCapped: false, agent: false },
      }),
    });
    const r = await fetchRecordingControls(scope, "standup");
    expect(scopedFetch).toHaveBeenCalledWith(scope, "/cli/voice/recording/controls", {
      method: "POST",
      body: JSON.stringify({ room: "standup" }),
      headers: { "Content-Type": "application/json" },
      priority: "user",
    });
    expect(r).toMatchObject({ ok: true, answer: { rights: { room: "standup", my_perms: "8192", recording_enabled: true }, recordCalls: true } });
  });

  it("a K2 before 0.46.11 (404) is unsupported; anything else failed", async () => {
    scopedFetch.mockResolvedValueOnce({ ok: false, status: 404, text: "" });
    expect(await fetchRecordingControls(scope, "standup")).toEqual({ ok: false, code: "unsupported", status: 404 });
    scopedFetch.mockResolvedValueOnce({ ok: false, status: 500, text: "" });
    expect(await fetchRecordingControls(scope, "standup")).toEqual({ ok: false, code: "failed", status: 500 });
    scopedFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchRecordingControls(scope, "standup")).toEqual({ ok: false, code: "failed", status: 0 });
  });

  it("knows K2's access_changed frame", () => {
    expect(isAccessChanged({ kind: "access_changed" })).toBe(true);
    expect(isAccessChanged({ kind: "voice_rooms_changed" })).toBe(false);
    expect(isAccessChanged(null)).toBe(false);
  });
});
