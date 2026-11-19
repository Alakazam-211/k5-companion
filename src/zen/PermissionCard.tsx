// A permission card in a Thread bubble (K2 0.46.3 `permission-cards-v1`,
// phone contract v1). The daemon shapes the card for this viewer
// (`permissionCardModel.ts`): an owner/admin gets Allow / Deny (and "Allow all"
// on a batch when nothing needs a confirm), the person who asked gets the
// waiting text and a note box, anyone else gets the status. Answers,
// notes and "Turn off again" go through `api/permissionCards`; the card
// itself changes only when the daemon rewrites the doc (a frame or the
// re-read that follows each write). Confirm actions (App approvals, the
// node root step) take this login's password first (PermissionConfirmSheet).
// Cards that need K2's own form before Allow (`cardForm`): the GitHub
// credential card opens that form here (GitAccessSetupSheet) and sends Allow
// once it's saved, like desktop; any other form card, or an Allow refused
// `*_form_first`, shows "Set this up in K2 on your computer." and Deny.

import { memo, useRef, useState, type ReactNode } from "react";
import type { ServerScope } from "../api/scope";
import { answerPermission, isFormFirstCode, notePermission, undoPermission, type PermissionWrite } from "../api/permissionCards";
import {
  ALLOW,
  ALLOW_ALL,
  CLOSE,
  DENY,
  DENY_ALL,
  DENY_REASON_MAX,
  cardForm,
  noteProblem,
  pendingItems,
  stateLine,
  waitingText,
  type PermissionCardModel,
  type PermissionItem,
} from "./permissionCardModel";
import { PermissionConfirmSheet } from "./PermissionConfirmSheet";
import { GitAccessSetupSheet } from "./GitAccessSetupSheet";

// Inside the agent bubble (--color-bubble-agent): its quieter words.
const MUTED = "var(--color-text-secondary)";
/** Loosens access: the warning's words. */
const AMBER = "var(--color-status-warn-text)";
/** Tightens access: the legible green. */
const GREEN = "var(--color-status-ok-soft)";

function shortTime(secs: number | null): string {
  if (!secs) return "";
  try {
    return new Date(secs * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

type Props = {
  card: PermissionCardModel;
  /** The card's doc id and the Thread address it is answered on. */
  id: string;
  addr: string;
  scope: ServerScope;
  /** Writes allowed now (a live Thread that can answer, not cached-only). */
  enabled: boolean;
  /** After a write: re-read so the rewritten doc shows. */
  onWritten: () => void;
};

type Confirm = { action: string; secretId: string; headline: string; item?: string };

/** The card's key for per-request state: the batch item, or the card. */
const CARD_KEY = "";

/** Instead of Allow, for a card that needs K2's own form first. */
export const FORM_ELSEWHERE_TEXT = "Set this up in K2 on your computer.";

export const PermissionCard = memo(function PermissionCard({ card, id, addr, scope, enabled, onWritten }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /** The GitHub setup form is open. */
  const [gitForm, setGitForm] = useState(false);
  /** This session set the GitHub credential: plain Allow is the way on. */
  const [gitSet, setGitSet] = useState(false);
  const gitSetRef = useRef(false);
  /** Requests whose Allow came back `*_form_first` (K2's form first). */
  const [formFirst, setFormFirst] = useState<ReadonlySet<string>>(() => new Set());

  async function write(run: () => Promise<PermissionWrite>, key = CARD_KEY): Promise<string | null> {
    setBusy(true);
    setError(null);
    const r = await run();
    setBusy(false);
    if (!r.ok) {
      // "Set it up in K2's own form first": Allow can't work from here, so
      // the card says where instead of showing a refusal (unless this card
      // has the form here and the credential was just set).
      if (isFormFirstCode(r.code) && !gitSetRef.current) {
        setFormFirst((s) => new Set(s).add(key));
        return r.text;
      }
      setError(r.text);
      return r.text;
    }
    onWritten();
    return null;
  }

  const answer = (label: string, opts: { item?: string; reason?: string; confirmToken?: string } = {}) =>
    write(() => answerPermission(scope, addr, id, label, opts), opts.item ?? CARD_KEY);

  /** What stands in for Allow: the GitHub form, "set it up on your
   *  computer", or nothing (plain Allow). */
  const allowMode = (item: PermissionItem, key: string): "git" | "elsewhere" | null => {
    const form = cardForm(item);
    if (form === "elsewhere") return "elsewhere";
    if (form === "git-access-setup" && !gitSet) return key === CARD_KEY ? "git" : "elsewhere";
    if (formFirst.has(key)) return "elsewhere";
    return null;
  };

  function allow(item: PermissionItem, batchItem?: string) {
    if (item.proof.kind === "confirm") {
      setConfirm({ action: item.proof.action, secretId: item.proof.secretId, headline: item.whatChanges, item: batchItem });
      return;
    }
    void answer(ALLOW, batchItem ? { item: batchItem } : {});
  }

  return (
    <div className="flex flex-col" style={{ gap: 8 }} data-testid="permission-card" data-state={card.kind === "permission" ? card.state : card.state}>
      {card.kind === "permission" ? (
        <Single card={card} enabled={enabled && !busy} allowMode={allowMode(card.item, CARD_KEY)} onSetUp={() => setGitForm(true)} onAllow={() => allow(card.item)} onDeny={(reason) => void answer(DENY, reason ? { reason } : {})} onClose={() => void answer(CLOSE)} onUndo={() => void write(() => undoPermission(scope, addr, id))} onNote={(text) => write(() => notePermission(scope, addr, id, text))} />
      ) : (
        <Batch
          card={card}
          enabled={enabled && !busy}
          allowMode={(it) => allowMode(it, it.requestId)}
          onAllow={(it) => allow(it, it.requestId)}
          onDeny={(it) => void answer(DENY, { item: it.requestId })}
          onAllowAll={() => void answer(ALLOW_ALL)}
          onDenyAll={() => void answer(DENY_ALL)}
        />
      )}
      {busy ? <Muted>Sending…</Muted> : null}
      {error ? (
        <p
          className="text-[12px] leading-snug"
          role="alert"
          style={{ color: "var(--color-status-error-bright)", overflowWrap: "anywhere" }}
          data-testid="permission-error"
        >
          {error}
        </p>
      ) : null}
      {gitForm ? (
        <GitAccessSetupSheet
          scope={scope}
          onCancel={() => setGitForm(false)}
          onDone={() => {
            // Desktop's pattern: the credential is in the vault, so Allow
            // now goes through (the daemon sees it's set).
            setGitForm(false);
            gitSetRef.current = true;
            setGitSet(true);
            setFormFirst(new Set());
            void answer(ALLOW);
          }}
        />
      ) : null}
      {confirm ? (
        <PermissionConfirmSheet
          scope={scope}
          action={confirm.action}
          requestId={confirm.secretId}
          headline={confirm.headline}
          onCancel={() => setConfirm(null)}
          onConfirmed={async (token) => {
            const failed = await answer(ALLOW, { confirmToken: token, ...(confirm.item ? { item: confirm.item } : {}) });
            if (!failed) setConfirm(null);
            return failed;
          }}
        />
      ) : null}
    </div>
  );
});

function Muted({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="text-[12px] leading-snug" style={{ color: MUTED }} data-testid={testId}>
      {children}
    </p>
  );
}

function Button({ label, onClick, primary, disabled, testId }: { label: string; onClick: () => void; primary?: boolean; disabled?: boolean; testId: string }) {
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

/** What it is: headline, direction, setting · scope · duration, effect, values. */
function Details({ item, compact }: { item: PermissionItem; compact?: boolean }) {
  return (
    <div className="flex flex-col" style={{ gap: 4 }}>
      <div className="flex items-center" style={{ gap: 6 }}>
        <span className="text-[11px] uppercase tracking-wide" style={{ color: MUTED }}>
          Permission
        </span>
        {item.direction ? (
          <span
            className="text-[11px] rounded-full px-1.5"
            style={{ color: item.direction === "loosen" ? AMBER : GREEN, border: `1px solid ${item.direction === "loosen" ? AMBER : GREEN}` }}
            data-testid="permission-direction"
          >
            {item.direction === "loosen" ? "Loosens access" : "Tightens access"}
          </span>
        ) : null}
        {item.proof.kind === "confirm" ? (
          <span className="text-[11px]" style={{ color: MUTED }} data-testid="permission-needs-password">
            · Needs your password
          </span>
        ) : null}
      </div>
      <p className="text-[16px] font-semibold leading-snug" data-testid="permission-headline">
        {item.whatChanges || item.setting}
      </p>
      <Muted>{[item.setting, item.scope, item.duration].filter(Boolean).join(" · ")}</Muted>
      {!compact && item.consequences ? <Muted>{item.consequences}</Muted> : null}
      {!compact && item.values.length ? (
        <div className="flex flex-col text-[12px]" style={{ fontFamily: "var(--zen-mono, ui-monospace, monospace)", color: MUTED }} data-testid="permission-values">
          {item.values.map((v, i) => (
            <span key={i} className="break-all">
              {v.key}: {v.value}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Single({
  card,
  enabled,
  allowMode,
  onSetUp,
  onAllow,
  onDeny,
  onClose,
  onUndo,
  onNote,
}: {
  card: Extract<PermissionCardModel, { kind: "permission" }>;
  enabled: boolean;
  /** What stands in for Allow (see PermissionCard's `allowMode`). */
  allowMode: "git" | "elsewhere" | null;
  onSetUp: () => void;
  onAllow: () => void;
  onDeny: (reason: string) => void;
  onClose: () => void;
  onUndo: () => void;
  onNote: (text: string) => Promise<string | null>;
}) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const item = card.item;
  const approver = card.viewer.mode === "approve";
  const pending = card.state === "pending";
  const line = stateLine(card, shortTime);
  return (
    <>
      <Details item={item} />
      {item.why ? (
        <p className="text-[14px] leading-snug" data-testid="permission-why">
          <span style={{ color: MUTED }}>{item.why.by} says: </span>
          {item.why.text}
        </p>
      ) : null}
      {item.askers && item.askers.count > 1 ? <Muted>{item.askers.count} people asked</Muted> : null}
      {approver && item.notes.length ? (
        <div className="flex flex-col" style={{ gap: 2 }} data-testid="permission-notes">
          {item.notes.map((n, i) => (
            <p key={i} className="text-[13px] leading-snug">
              <span style={{ color: MUTED }}>{n.by}: </span>
              {n.text}
            </p>
          ))}
        </div>
      ) : null}

      {pending && approver && card.viewer.canAnswer ? (
        denying ? (
          <div className="flex flex-col" style={{ gap: 6 }}>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, DENY_REASON_MAX))}
              placeholder="Reason (optional)"
              className="rounded-lg px-2.5 py-1.5 text-[15px]"
              style={{ background: "var(--color-bg-elevated)", color: "var(--color-text-primary)", border: "1px solid var(--color-border-strong)" }}
              data-testid="permission-deny-reason"
            />
            <div className="flex flex-wrap" style={{ gap: 6 }}>
              <Button label={DENY} onClick={() => onDeny(reason.trim())} disabled={!enabled} testId="permission-deny-send" />
              <Button label="Cancel" onClick={() => setDenying(false)} testId="permission-deny-cancel" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 6 }}>
            <div className="flex flex-wrap items-center" style={{ gap: 6 }}>
              {allowMode === "git" ? (
                <Button label="Set up GitHub access" primary onClick={onSetUp} disabled={!enabled} testId="permission-git-setup" />
              ) : allowMode === null ? (
                <Button label={ALLOW} primary onClick={onAllow} disabled={!enabled} testId="permission-allow" />
              ) : null}
              <Button label={DENY} onClick={() => setDenying(true)} disabled={!enabled} testId="permission-deny" />
            </div>
            {allowMode === "git" ? <Muted testId="permission-git-note">You enter the key or token in K2's form. The agent never sees it.</Muted> : null}
            {allowMode === "elsewhere" ? <Muted testId="permission-form-elsewhere">{FORM_ELSEWHERE_TEXT}</Muted> : null}
          </div>
        )
      ) : null}

      {pending && !approver ? <Muted testId="permission-waiting">{waitingText(card)}</Muted> : null}
      {pending && card.noteBox.allowed ? <NoteBox max={card.noteBox.max} mine={card.noteBox.mine} enabled={enabled} onNote={onNote} /> : null}

      {line ? (
        <p className="text-[13px]" style={{ color: MUTED }} data-testid="permission-state">
          {line}
        </p>
      ) : null}
      {card.state === "already_done" && card.options.includes(CLOSE) && card.viewer.canAnswer && card.resultMessage == null ? (
        <div>
          <Button label={CLOSE} onClick={onClose} disabled={!enabled} testId="permission-close" />
        </div>
      ) : null}
      {card.state === "approved" && card.resultMessage ? <Muted testId="permission-result">{card.resultMessage}</Muted> : null}
      {card.state === "denied" && item.answer?.reason ? <Muted testId="permission-reason">“{item.answer.reason}”</Muted> : null}
      {card.state === "already_done" && card.resultMessage ? <Muted testId="permission-result">{card.resultMessage}</Muted> : null}
      {card.state === "approved" && item.undo && approver ? (
        <div>
          <Button label={item.undo.label} onClick={onUndo} disabled={!enabled} testId="permission-undo" />
        </div>
      ) : null}
    </>
  );
}

function NoteBox({ max, mine, enabled, onNote }: { max: number; mine: string | null; enabled: boolean; onNote: (text: string) => Promise<string | null> }) {
  const [text, setText] = useState(mine ?? "");
  const [saved, setSaved] = useState(false);
  const problem = noteProblem(text, max);
  const changed = text.trim() !== (mine ?? "");
  return (
    <div className="flex flex-col" style={{ gap: 6 }} data-testid="permission-note-box">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        rows={2}
        placeholder="Add a note for the approver"
        className="rounded-lg px-2.5 py-1.5 text-[15px] resize-none"
        style={{ background: "var(--color-bg-elevated)", color: "var(--color-text-primary)", border: "1px solid var(--color-border-strong)" }}
        data-testid="permission-note-input"
      />
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span className="text-[11px]" style={{ color: problem ? "var(--color-status-error-bright)" : MUTED }}>
          {problem ?? (saved ? "Note sent" : `${text.length}/${max}`)}
        </span>
        <Button
          label={mine && !text.trim() ? "Remove note" : "Send note"}
          onClick={async () => {
            const failed = await onNote(text.trim());
            if (!failed) setSaved(true);
          }}
          disabled={!enabled || !!problem || !changed}
          testId="permission-note-send"
        />
      </div>
    </div>
  );
}

function Batch({
  card,
  enabled,
  allowMode,
  onAllow,
  onDeny,
  onAllowAll,
  onDenyAll,
}: {
  card: Extract<PermissionCardModel, { kind: "batch" }>;
  enabled: boolean;
  allowMode: (it: PermissionItem) => "git" | "elsewhere" | null;
  onAllow: (it: PermissionItem) => void;
  onDeny: (it: PermissionItem) => void;
  onAllowAll: () => void;
  onDenyAll: () => void;
}) {
  const approver = card.viewer.mode === "approve" && card.viewer.canAnswer;
  const pending = pendingItems(card);
  const by = card.items.find((i) => i.why)?.why?.by;
  return (
    <>
      <p className="text-[15px] font-semibold" data-testid="permission-batch-title">
        {by ? `${by} asks for ${card.items.length} permissions` : `${card.items.length} permission requests`}
      </p>
      {approver && card.viewer.canAnswerAll && pending.length > 0 && !pending.some((it) => allowMode(it) !== null) ? (
        <div className="flex flex-wrap" style={{ gap: 6 }}>
          <Button label={`${ALLOW_ALL} (${pending.length})`} primary onClick={onAllowAll} disabled={!enabled} testId="permission-allow-all" />
          <Button label={DENY_ALL} onClick={onDenyAll} disabled={!enabled} testId="permission-deny-all" />
        </div>
      ) : null}
      <div className="flex flex-col" style={{ gap: 10 }}>
        {card.items.map((it) => (
          <div key={it.requestId} className="flex flex-col" style={{ gap: 6, paddingTop: 8, borderTop: "1px solid var(--color-wash-2)" }} data-testid="permission-batch-item" data-state={it.state}>
            <Details item={it} compact />
            {it.state === "pending" && approver ? (
              <div className="flex flex-col" style={{ gap: 6 }}>
                <div className="flex flex-wrap" style={{ gap: 6 }}>
                  {allowMode(it) === null ? (
                    <Button label={ALLOW} primary onClick={() => onAllow(it)} disabled={!enabled} testId="permission-item-allow" />
                  ) : null}
                  <Button label={DENY} onClick={() => onDeny(it)} disabled={!enabled} testId="permission-item-deny" />
                </div>
                {allowMode(it) !== null ? <Muted testId="permission-form-elsewhere">{FORM_ELSEWHERE_TEXT}</Muted> : null}
              </div>
            ) : it.state !== "pending" ? (
              <Muted>{it.state === "approved" ? `Allowed${it.answer?.by ? ` by ${it.answer.by}` : ""}` : it.state === "denied" ? `Denied${it.answer?.by ? ` by ${it.answer.by}` : ""}` : it.state.replace("_", " ")}</Muted>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
