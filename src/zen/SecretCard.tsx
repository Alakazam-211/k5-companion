// A secret-request card in a Thread bubble (`k2 thread secret`): the agent
// asks the person to paste a value (a password, an API key) that goes into
// the server's vault. The desktop's simple card (K2 SecretCard.tsx, 0.46.3+):
// the agent made the choices (where it is kept, which sites it may go to,
// how the agent gets it); the card says them in one plain sentence, and the
// person pastes the value and taps Save once. If the choice is wrong they
// tell the agent in the chat, and the agent cancels the card and asks again.
// The phone has no Advanced: it never changes what the agent chose.
//
// The value: the field is an uncontrolled password input. Its text is read
// from the DOM once, on Save, and handed to `answerSecretCard` (which POSTs
// it to the card's own server); it is never put in React state, a store, the
// chat cache, a draft, a log or an error. The field is emptied after a save,
// on Cancel, on Deny and when the card leaves the screen. A host-mismatch
// warning keeps the field as it is so "Save anyway" resends the same value
// with `confirm`.
//
// Going to the background (the app switcher takes a snapshot) re-masks the
// field: Show turns back to hidden, so a snapshot shows dots, never the
// value. The value itself stays, so a person who switches to a password app
// mid-paste doesn't lose it.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { answerSecretCard } from "../api/secretCard";
import { pool, roleAllowsRoom } from "./multi/pool";
import { cardAuthorLabel, closedCardLine, type SecretInject, type ThreadMessage, type ThreadSecret } from "./threadModel";
import { useZenScope } from "./zenScope";
import { useZenStore } from "./zenStore";

// Inside the agent bubble (--color-bubble-agent): its quieter words.
const MUTED = "var(--color-text-secondary)";
const DANGER = "var(--color-status-error-bright)";
const MONO = "var(--zen-mono, ui-monospace, Menlo, monospace)";

/** Prompt cap (K2 VS13): plain text, at most 200 characters. */
export const SECRET_PROMPT_MAX = 200;

/** The refusal that wants a second click ("Save anyway"). */
export const SECRET_HOST_MISMATCH = "card_host_mismatch";
/** Only from a server older than K2 0.46.3 (it doesn't know `disclosed`):
 *  the card answers it itself, once, with `confirm`. */
export const SECRET_READABLE_DELIVERY = "card_readable_delivery";

type Scope = "workspace" | "server" | "session";
type Delivery = "fetch" | "file" | "env" | "agent";

function normalScope(s: string | null): Scope {
  return s === "server" || s === "session" ? s : "workspace";
}

function normalDelivery(d: string | null): Delivery {
  return d === "file" || d === "env" || d === "agent" ? d : "fetch";
}

/** A site as people read it: `https://api.stripe.com:443` → `api.stripe.com`. */
export function siteLabel(origin: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]+?)(?::(\d+))?\/?$/i.exec(origin.trim());
  if (!m) return origin.trim();
  const [, scheme, host, port] = m;
  const s = scheme.toLowerCase();
  if (s === "https") return port && port !== "443" ? `${host}:${port}` : host;
  if (s === "http") return port && port !== "80" ? `http://${host}:${port}` : `http://${host}`;
  return origin.trim();
}

/** "a, b and c". */
function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The Basic login's user when the format fixes one (`ws123:{}`). */
export function basicUser(inj: SecretInject | null): string | null {
  if (!inj || inj.dst !== "basic") return null;
  const m = /^(.+):\{\}$/.exec(inj.fmt);
  return m && !m[1].includes("{}") ? m[1] : null;
}

/** Can this card show the sending? (`basic`, `header:<Name>`, `query:<param>`.) */
export function injectKnown(inj: SecretInject | null): boolean {
  if (!inj) return true;
  return inj.dst === "basic" || /^header:./.test(inj.dst) || /^query:./.test(inj.dst);
}

/** How K2 sends it, in words (the daemon's `Inject::words`). */
export function injectWords(inj: SecretInject): string {
  const shown = inj.fmt.split("{}").join("‹secret›");
  if (inj.dst === "basic") {
    const user = basicUser(inj);
    if (user) return `as a Basic login for user ${user}`;
    return inj.fmt === "{}" ? "as a Basic login (user:password)" : `as a Basic login of ${shown}`;
  }
  if (inj.dst.startsWith("header:")) {
    const h = inj.dst.slice("header:".length);
    return inj.fmt === "{}" ? `in the ${h} header` : `as ${h}: ${shown}`;
  }
  if (inj.dst.startsWith("query:")) return `in the URL as ?${inj.dst.slice("query:".length)}=${shown}`;
  return "in a way this app can't show";
}

/** Where the secret is kept, in the plain sentence. */
const SCOPE_WORDS: Record<Scope, string> = {
  workspace: "this workspace",
  server: "this server (other agents get it when you share it)",
  session: "this session only",
};

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "expires in 3 days" for a pending card with a time frame (K2
 *  `cardExpiryLabel`); "expired" once it passed. Null without one. */
export function cardExpiryLabel(expiresAt: number | null, nowSec: number): string | null {
  if (typeof expiresAt !== "number") return null;
  const left = expiresAt - nowSec;
  if (left <= 0) return "expired";
  if (left < 3600) return `expires in ${plural(Math.max(1, Math.ceil(left / 60)), "minute")}`;
  if (left < 2 * 86400) return `expires in ${plural(Math.round(left / 3600), "hour")}`;
  return `expires in ${plural(Math.round(left / 86400), "day")}`;
}

/** The host-mismatch warning in plain words (K2 `mismatchText`). */
export function mismatchText(hint: string, sites: readonly string[]): string {
  const provider = /looks like an? (.+?) key/i.exec(hint)?.[1];
  const to = sites.length > 0 ? listWords(sites.map(siteLabel)) : "another site";
  if (provider) return `This looks like a ${provider} key, but it would be sent to ${to}. Save it only if that's right.`;
  const h = hint.trim() || "Check this before saving.";
  return h.charAt(0).toUpperCase() + h.slice(1);
}

/** The plain sentence: what the agent chose, as the person reads it. */
export function SecretPlan({ agent, secret }: { agent: string; secret: ThreadSecret }) {
  const b = (t: string): ReactNode => <strong className="font-semibold">{t}</strong>;
  const delivery = normalDelivery(secret.delivery);
  const where = SCOPE_WORDS[normalScope(secret.scope)];
  const sites = secret.hosts;
  const inject = delivery === "fetch" ? secret.inject : null;
  let body: ReactNode;
  if (delivery === "file" || delivery === "env") {
    body = (
      <>
        {b(agent)} will get this as {delivery === "file" ? "a " : "an "}
        {b(delivery === "file" ? "file it can read" : "environment variable it can read")}
        {delivery === "env" && secret.envName ? (
          <>
            {" "}
            (<span style={{ fontFamily: MONO }}>${secret.envName}</span>)
          </>
        ) : null}
        , for {b(where)}.
      </>
    );
  } else if (delivery === "agent") {
    body = (
      <>
        K2 will sign with this {b("ssh key")} for {b(agent)} (ssh and git, from its next session), for {b(where)};{" "}
        {b(agent)} never sees it.
      </>
    );
  } else if (sites.length > 0) {
    body = (
      <>
        K2 will add this to calls to {b(listWords(sites.map(siteLabel)))}
        {inject ? <> {b(injectWords(inject))}</> : null}, for {b(where)}; {b(agent)} never sees it.
        {inject?.dst.startsWith("query:") ? " Sites can log URLs." : null}
      </>
    );
  } else {
    body = <>{agent} didn't say which site this is for, so K2 can't use it yet.</>;
  }
  return (
    <p className="text-[14px] leading-snug" style={{ overflowWrap: "anywhere" }} data-testid="secret-plan" data-delivery={delivery}>
      {body}
    </p>
  );
}

function Button({
  label,
  onClick,
  primary,
  disabled,
  testId,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-full px-3.5 py-1.5 text-[15px] leading-none border"
      style={{
        borderColor: primary ? "var(--color-accent-fill)" : "var(--color-control-edge)",
        background: primary ? "var(--color-accent-fill)" : "transparent",
        color: primary ? "var(--color-on-accent)" : "var(--color-text-primary)",
        opacity: disabled ? 0.5 : 1,
      }}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

/** The fallback for a card this app can't draw or this login can't answer. */
export function CardFallback({ agent }: { agent: string }) {
  return (
    <div
      className="mt-1 rounded-xl px-3 py-2 text-[14px] leading-snug"
      style={{ border: "1px solid var(--color-control-edge)", color: "var(--color-text-primary)" }}
      data-testid="card-fallback"
      role="note"
    >
      {agent || "The agent"} sent a card this app can't show yet. Open it in the K2 desktop app.
    </div>
  );
}

/** Closed: saved, expired, or not given (dismissed / withdrawn). */
function ClosedSecret({ secret, agent, who }: { secret: ThreadSecret; agent: string; who: string | null }) {
  const closed =
    secret.status === "voided" && secret.closedAs ? closedCardLine(secret.closedAs, who, agent, secret.closeReason) : null;
  return (
    <div className="flex flex-col" style={{ gap: 4 }} data-testid="secret-card" data-status={secret.status}>
      <p className="text-[14px] leading-snug" style={{ overflowWrap: "anywhere" }} data-testid="secret-closed">
        <span style={{ fontFamily: MONO }}>{secret.name}</span>{" "}
        {secret.status === "set" ? (
          <>
            saved{who ? ` by ${who}` : ""}
            {secret.ref ? (
              <>
                {" "}
                as <span style={{ fontFamily: MONO, userSelect: "text", WebkitUserSelect: "text" }}>{secret.ref}</span>
              </>
            ) : null}
          </>
        ) : secret.status === "expired" ? (
          "request expired"
        ) : (
          "not given"
        )}
      </p>
      {closed ? (
        <p
          className="pt-1.5 text-[12px] leading-snug"
          style={{ color: MUTED, borderTop: "0.5px solid var(--color-border-strong)" }}
          data-testid="secret-closed-why"
        >
          {closed}
        </p>
      ) : null}
    </div>
  );
}

export function SecretCard({
  m,
  canAnswer,
  agentLabel,
}: {
  m: ThreadMessage & { secret: ThreadSecret };
  /** A live Thread that can answer now (not cached-only, not a stub). */
  canAnswer: boolean;
  /** Who asked, as people read it (falls back to `m.from`). */
  agentLabel?: string;
}) {
  const secret = m.secret;
  const agent = (agentLabel || m.from || "").trim() || "the agent";
  const scope = useZenScope();
  const addr = useZenStore((s) => s.threadAddr) ?? "";
  const role = useStore(pool.store, (s) => s.entries[scope.id]?.role ?? null);
  const who = cardAuthorLabel(secret.answeredBy, scope.username());

  const fieldRef = useRef<HTMLInputElement>(null);
  const [hasValue, setHasValue] = useState(false);
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = secret.status === "pending";

  // Leaving the screen (scrolled out of the window, another chat) drops
  // whatever was typed. A layout cleanup runs while the ref is attached.
  useLayoutEffect(
    () => () => {
      if (fieldRef.current) fieldRef.current.value = "";
    },
    []
  );

  // The app switcher's snapshot: never a revealed value.
  useEffect(() => {
    if (!pending) return;
    const mask = () => {
      const el = fieldRef.current;
      if (el) el.type = "password";
      setShown(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") mask();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", mask);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", mask);
    };
  }, [pending]);

  if (!pending) return <ClosedSecret secret={secret} agent={agent} who={who} />;
  // A Voice & Chat login can't answer cards (the route is Member-level).
  if (role !== null && !roleAllowsRoom(role)) return <CardFallback agent={agent} />;

  const delivery = normalDelivery(secret.delivery);
  const inject = secret.inject;
  const unknownInject = !injectKnown(inject);
  const needsSite = delivery === "fetch" && secret.hosts.length === 0;
  const blocked = !canAnswer || !addr || unknownInject || needsSite;
  const basicLogin = delivery === "fetch" && inject?.dst === "basic";
  const placeholder = basicLogin
    ? basicUser(inject)
      ? `Paste the password for ${basicUser(inject)}`
      : "Paste it as user:password"
    : "Paste the value";
  const prompt = (secret.prompt ?? "").slice(0, SECRET_PROMPT_MAX);
  const expiry = cardExpiryLabel(secret.expiresAt, Math.floor(Date.now() / 1000));

  const clearField = () => {
    const el = fieldRef.current;
    if (el) {
      el.value = "";
      el.type = "password";
    }
    setHasValue(false);
    setShown(false);
  };

  const save = async () => {
    const el = fieldRef.current;
    if (!el || busy || blocked) return;
    const confirm = warning !== null;
    // Read once from the field; nothing keeps it past this call.
    const value = el.value;
    if (!value) return;
    setBusy(true);
    setError(null);
    const send = (withConfirm: boolean) => answerSecretCard(scope, addr, m.id, value, { inject, confirm: withConfirm });
    let r = await send(confirm);
    if (!r.ok && !confirm && r.code === SECRET_READABLE_DELIVERY) r = await send(true);
    setBusy(false);
    if (r.ok) {
      clearField();
      setWarning(null);
      useZenStore.getState().secretCardSaved(m.id, r.status, r.ref);
      return;
    }
    if (r.code === SECRET_HOST_MISMATCH && !confirm) {
      setWarning(r.text);
    } else {
      setWarning(null);
      setError(r.text);
    }
  };

  const deny = async () => {
    if (busy) return;
    clearField();
    setBusy(true);
    setError(null);
    const err = await useZenStore.getState().dismissCard(m.id);
    setBusy(false);
    if (err) setError(err);
  };

  const cancel = () => {
    clearField();
    setWarning(null);
    setError(null);
    setOpen(false);
  };

  return (
    <div className="flex flex-col" style={{ gap: 8 }} data-testid="secret-card" data-status="pending" data-warning={warning ? "" : undefined}>
      <div>
        <p className="text-[16px] font-semibold leading-snug" style={{ overflowWrap: "anywhere" }} data-testid="secret-header">
          {agent} asks for a secret:{" "}
          <span className="font-normal" style={{ fontFamily: MONO }} data-testid="secret-name">
            {secret.name}
          </span>
        </p>
        {expiry ? (
          <p className="text-[12px]" style={{ color: MUTED }} data-testid="secret-expiry">
            {expiry[0].toUpperCase() + expiry.slice(1)}
          </p>
        ) : null}
      </div>
      {prompt ? (
        <p className="text-[14px] leading-snug whitespace-pre-wrap" style={{ overflowWrap: "anywhere" }} data-testid="secret-prompt">
          <span style={{ color: MUTED }}>{agent} says: </span>
          {prompt}
        </p>
      ) : null}
      <SecretPlan agent={agent} secret={secret} />
      {secret.once ? (
        <p className="text-[14px]" data-testid="secret-once">
          Used once, then deleted.
        </p>
      ) : null}
      {secret.replaces ? (
        <p className="text-[14px] leading-snug" data-testid="secret-replaces">
          This replaces the <span style={{ fontFamily: MONO }}>{secret.name}</span> already saved, with what this card says.
        </p>
      ) : null}
      {unknownInject ? (
        <p className="text-[13px] leading-snug" role="alert" style={{ color: DANGER }} data-testid="secret-update">
          Update K2 to answer this card. {agent} asked K2 to send this secret in a way this app can't show.
        </p>
      ) : null}
      {open ? (
        <>
          <div className="flex items-center" style={{ gap: 6 }}>
            <input
              ref={fieldRef}
              type={shown ? "text" : "password"}
              // Not a login: no AutoFill, no suggestions, no keychain save.
              // ("new-password" would offer a generated password; "one-time-
              // code" would offer texted codes.)
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="done"
              aria-label={`Value for ${secret.name}`}
              placeholder={placeholder}
              disabled={busy || blocked}
              onChange={(e) => {
                setHasValue(e.currentTarget.value !== "");
                setWarning(null);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              className="flex-1 min-w-0 rounded-lg px-2.5 py-1.5 outline-none"
              // 16px: iOS zooms into a smaller field.
              style={{
                fontSize: 16,
                fontFamily: MONO,
                color: "var(--color-text-primary)",
                background: "var(--color-bg-elevated)",
                border: `1px solid ${warning ? DANGER : "var(--color-border-strong)"}`,
              }}
              data-testid="secret-field"
            />
            <button
              type="button"
              aria-pressed={shown}
              aria-label={shown ? "Hide the value" : "Show the value"}
              onClick={() => setShown((v) => !v)}
              className="shrink-0 px-1.5 py-1 text-[13px] leading-none"
              style={{ color: MUTED }}
              data-testid="secret-show"
            >
              {shown ? "Hide" : "Show"}
            </button>
          </div>
          <p className="text-[12px] leading-snug" style={{ color: MUTED }} data-testid="secret-hint">
            Not right? Tell {agent} in the chat; it can cancel this and ask again.
          </p>
          {warning ? (
            <p className="text-[13px] leading-snug" role="alert" style={{ color: DANGER, overflowWrap: "anywhere" }} data-testid="secret-warning">
              <strong>Check this first.</strong> {mismatchText(warning, secret.hosts)} If {agent} set this up wrong, tell it in the chat
              instead.
            </p>
          ) : null}
          {error ? (
            <p className="text-[13px] leading-snug" role="alert" style={{ color: DANGER, overflowWrap: "anywhere" }} data-testid="secret-error">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center" style={{ gap: 6 }}>
            <Button
              label={busy ? "Saving…" : warning ? "Save anyway" : "Save"}
              primary
              disabled={!hasValue || busy || blocked}
              onClick={() => void save()}
              testId="secret-save"
            />
            <Button label="Deny" disabled={busy || !canAnswer} onClick={() => void deny()} testId="secret-deny" />
            <Button label="Cancel" disabled={busy} onClick={cancel} testId="secret-cancel" />
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between" style={{ gap: 8 }}>
          <p className="text-[13px]" style={{ color: MUTED }} data-testid="secret-collapsed">
            Not answered yet.
          </p>
          <Button label="Answer" disabled={!canAnswer} onClick={() => setOpen(true)} testId="secret-reopen" />
        </div>
      )}
    </div>
  );
}
