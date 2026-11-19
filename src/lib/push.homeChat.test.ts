// @vitest-environment jsdom
// A Home chat notification's tap (K2 0.46.16 push kind `home_chat`): Home
// first, then that DM or channel on the push's own server; the generic lane
// stays on Home; the active server never changes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const servers = vi.hoisted(() => ({
  list: [] as Array<{ id: string; url: string; username?: string }>,
  active: "s1" as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), addPluginListener: vi.fn(), isTauri: () => false }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("../api/cliAuth", () => ({ cliAuthHeaders: vi.fn(() => ({})) }));
vi.mock("../stores/servers", () => ({
  useServersStore: { getState: () => ({ servers: servers.list, tokens: {}, activeServerId: servers.active, setActive: vi.fn() }) },
  getActiveServer: vi.fn(() => null),
  onServerForget: vi.fn(() => () => {}),
  onServerLeave: vi.fn(),
}));
vi.mock("../api/client", () => ({ FEATURE_THREAD_PUSH: "thread-push-v1", getBootStatus: vi.fn(async () => null) }));
vi.mock("./revive", () => ({ connectServer: vi.fn() }));
vi.mock("../zen/calls/dmCall", () => ({ routeCallTap: vi.fn() }));
vi.mock("../zen/approvals", () => ({ openApproval: vi.fn() }));

import { routeHomeChatTap, routeTap } from "./push";
import type { HomeChatTarget } from "../zen/homeChat/homeChatModel";

beforeEach(() => {
  servers.list = [
    { id: "s1", url: "https://riley.k2.dev" },
    { id: "s2", url: "https://team.k2.dev" },
  ];
  servers.active = "s1";
});

describe("a Home chat tap", () => {
  it("a sealed DM opens that DM on the server whose key opened it", async () => {
    const nav = vi.fn();
    const open = vi.fn<(t: HomeChatTarget) => void>();
    await routeHomeChatTap(
      { kind: "home_chat", conversationId: "901", convKind: "dm", senderExt: "k2:owner", senderName: "Riley", k2ServerId: "s2", subdomain: "team" },
      nav,
      open
    );
    expect(nav).toHaveBeenCalledWith("/zen");
    expect(open).toHaveBeenCalledWith({ serverId: "s2", kind: "dm", conversationId: "901", title: "Riley", ext: "k2:owner" });
  });

  it("without a saved key, its label names the server", async () => {
    const open = vi.fn<(t: HomeChatTarget) => void>();
    await routeHomeChatTap({ kind: "home_chat", conversationId: "902", convKind: "channel", channelName: "standup", subdomain: "team" }, vi.fn(), open);
    expect(open).toHaveBeenCalledWith({ serverId: "s2", kind: "channel", conversationId: "902", title: "standup", inviteOnly: null });
  });

  it("the generic lane opens Home only", async () => {
    const nav = vi.fn();
    const open = vi.fn();
    await routeHomeChatTap({ kind: "home_chat", subdomain: "riley" }, nav, open);
    expect(nav).toHaveBeenCalledWith("/zen");
    expect(open).not.toHaveBeenCalled();
  });

  it("a server this phone doesn't hold stays on Home", async () => {
    const open = vi.fn();
    await routeHomeChatTap({ kind: "home_chat", conversationId: "901", convKind: "dm", subdomain: "stranger", k2ServerId: "gone" }, vi.fn(), open);
    expect(open).not.toHaveBeenCalled();
  });

  it("routeTap sends home_chat here (Home first)", async () => {
    const nav = vi.fn();
    await routeTap({ kind: "home_chat" }, nav);
    expect(nav).toHaveBeenCalledWith("/zen");
  });
});
