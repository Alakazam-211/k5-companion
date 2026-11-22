// A channel's push level in its members sheet (K2 0.46.16
// `home-chat-push-v1`): "All messages" or "@mentions only", two choices
// (no Off: mute stays separate). DMs never show it (they always notify).
// A server that fixed the level shows it read-only; while the server can't
// push every message yet, All messages says it works like @mentions for
// now. Only on a server that lists the feature (the sheet checks).

import { useEffect, useState } from "react";
import { onBootInfo, type DaemonFeature, type ServerScope } from "../../api/scope";
import { HOME_CHAT_PUSH_FEATURE } from "../../api/homeChatPure";
import { convKey } from "./homeChatModel";
import {
  NOTIFY_HEADING,
  notifySettingView,
  pickHomeChatNotify,
  refreshHomeChatNotify,
  useHomeChatNotify,
} from "./homeChatNotify";

/** Does `scope`'s server list `feature` now? From the boot memory only (the
 *  chat's gate read it when the chat opened); follows later reads. */
export function useServerFeature(scope: ServerScope, feature: DaemonFeature): boolean {
  const read = (): boolean => {
    try {
      return scope.supports(feature);
    } catch {
      return false;
    }
  };
  const [on, setOn] = useState(read);
  useEffect(() => {
    setOn(read());
    return onBootInfo((id) => {
      if (id === scope.id) setOn(read());
    });
    // `read` closes over scope and feature only.
  }, [scope, feature]);
  return on;
}

/** Home chat pushes on `scope`'s server (`home-chat-push-v1`). */
export function useHomeChatPushOn(scope: ServerScope): boolean {
  return useServerFeature(scope, HOME_CHAT_PUSH_FEATURE);
}

const SECTION = "text-[12px] font-semibold uppercase tracking-wide px-1 mb-1";

export function HomeChatNotifySetting({ scope, conv }: { scope: ServerScope; conv: string }) {
  const notify = useHomeChatNotify((s) => s.byConv[convKey(scope.id, conv)] ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void refreshHomeChatNotify(scope, conv).then((e) => {
      if (live && e) setError(e);
    });
    return () => {
      live = false;
    };
  }, [scope, conv]);

  // A DM's answer (fixed, convKind dm) never draws here.
  if (notify?.convKind === "dm") return null;
  const view = notifySettingView(notify);
  const pick = (level: "all" | "mentions") => {
    if (view.readOnly || busy || notify?.level === level) return;
    setBusy(true);
    setError(null);
    void pickHomeChatNotify(scope, conv, level).then((e) => {
      setBusy(false);
      if (e) setError(e);
    });
  };

  return (
    <div className="mb-3" data-testid="home-chat-notify">
      <h3 className={SECTION} style={{ color: "var(--color-text-muted)" }} id={`home-chat-notify-${conv}`}>
        {NOTIFY_HEADING}
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={`home-chat-notify-${conv}`}
        aria-readonly={view.readOnly || undefined}
        className="flex k2-tile"
        style={{ borderRadius: 12, padding: 3, gap: 3 }}
      >
        {view.choices.map((c) => (
          <button
            key={c.level}
            type="button"
            role="radio"
            aria-checked={c.checked}
            disabled={view.readOnly || !notify}
            data-testid={`home-chat-notify-${c.level}`}
            className="flex-1 text-[15px] border-0"
            style={{
              minHeight: 38,
              borderRadius: 9,
              background: c.checked ? "var(--color-accent-fill)" : "transparent",
              color: c.checked ? "var(--color-on-accent)" : "var(--color-text-primary)",
              fontWeight: c.checked ? 600 : 400,
              opacity: view.readOnly && !c.checked ? 0.5 : 1,
            }}
            onClick={() => pick(c.level)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="px-1 pt-1.5 text-[12px]" style={{ color: "var(--color-status-error-text)" }} role="alert" data-testid="home-chat-notify-error">
          {error}
        </p>
      ) : view.note ? (
        <p className="px-1 pt-1.5 text-[12px]" style={{ color: "var(--color-text-muted)" }} data-testid="home-chat-notify-note">
          {view.note}
        </p>
      ) : null}
    </div>
  );
}
