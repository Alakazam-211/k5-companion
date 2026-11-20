// One message in a Home chat, in the Thread's look (ThreadPane's
// `ThreadRow` / `Bubble`): your bubble on the accent fill, theirs on the
// agent bubble, iMessage tails on a run's last, the name and time over
// someone else's run, the status line under yours. What differs (brief
// §2.9; desktop `HomeChatMessageRow.tsx`):
//   - a reply's quote strip inside the bubble ("Ana: first line"); a tap
//     jumps to the original ("Original message deleted" / "Original not
//     loaded" when it can't be shown);
//   - reaction chips under the bubble;
//   - a message just jumped to wears a fading accent wash (1.2 s);
//   - a call's record is a LINE, never a bubble, with "Call back";
//   - in a channel, the sender column (never in a DM): every bubble of
//     someone else's sits past it, and their picture sits beside the tail
//     of their run's last bubble (threadPictures.ts, K2 a096cbc1d2).
// The hold menu (React, Reply, Copy) is the view's: a bubble carries
// MESSAGE_HOLD_ATTR and `useMessageHold` on the list does the rest.

import { memo, type CSSProperties } from "react";
import type { HomeChatMessage } from "../../api/homeChatPure";
import { callRecordLine } from "../../api/homeChatCallsPure";
import { ChatMessageBody } from "../../components/ChatMessage";
import { MESSAGE_HOLD_ATTR } from "../stash/useMessageHold";
import { SENDING_OPACITY } from "../../kit/mobileChat/useDeliverBrighten";
import { DELETED_TEXT, mountainTime } from "../threadModel";
import { bubbleBodyStyle } from "../ThreadPane";
import { PhoneIcon } from "../icons";
import { zenTextPx } from "../zenFont";
import type { RunPos } from "../chatReceipt";
import { THREAD_PICTURE_GAP, THREAD_PICTURE_PX } from "../threadPictures";
import { quoteText, type HomeChatFace, type ReplyPreview } from "./homeChatModel";
import { ReactionChips } from "./HomeChatReactions";
import { PersonAvatar } from "./HomeChatGlyphs";
import "../chatBubbles.css";
import "./homeChat.css";

const NO_SELECT: CSSProperties = { userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" };
const SELECTABLE: CSSProperties = { userSelect: "text", WebkitUserSelect: "text", WebkitTouchCallout: "default" };
/** The sender column: the row's left margin (the bubble keeps its width). */
const COLUMN_STYLE: CSSProperties = { marginLeft: THREAD_PICTURE_PX + THREAD_PICTURE_GAP };
/** The picture, in the column at the bubble's bottom: level with its tail. */
const PICTURE_STYLE: CSSProperties = { left: -(THREAD_PICTURE_PX + THREAD_PICTURE_GAP) };

/** A sender's picture beside their run's last bubble. `data-lift-skip`:
 *  the hold menu lifts the bubble alone (AgentMenu's liftCopy). */
const HomeChatSenderPicture = memo(function HomeChatSenderPicture({ face }: { face: HomeChatFace }) {
  return (
    <span
      className="absolute bottom-0"
      style={PICTURE_STYLE}
      aria-hidden
      data-thread-picture=""
      data-lift-skip=""
      data-testid="home-chat-msg-picture"
    >
      <PersonAvatar username={face.username} name={face.name} picture={face.picture} pictureOf={face.pictureOf} size={THREAD_PICTURE_PX} fontSize={12} glass />
    </span>
  );
});

export interface HomeChatRowActions {
  toggleReaction: (msgId: string, emoji: string) => void;
  whoReacted: (msgId: string, emoji: string) => Promise<string[] | null>;
  jump: (msgId: string) => void;
  retry: (nonce: string) => void;
  edit: (nonce: string) => void;
}

/** A send's state on its optimistic bubble. */
export type RowSend = { status: "sending" | "failed"; error: string | null; final?: boolean } | null;

function QuoteStrip({ preview, onJump }: { preview: ReplyPreview; onJump: () => void }) {
  const q = quoteText(preview);
  return (
    <button
      type="button"
      // The bubble's own word colour, faded (the Thread's quote line): no
      // color-mix on iOS 15, so the fade is opacity on currentColor.
      className="relative flex items-center gap-1.5 min-w-0 max-w-full mb-1 text-[13px] leading-snug text-left bg-transparent border-0 p-0"
      style={{ paddingLeft: 8, color: "inherit" }}
      data-testid="home-chat-quote"
      data-state={preview.state}
      aria-label={preview.state === "loaded" ? `Replying to ${q.from}: ${q.line}. Tap to see it` : q.line}
      onClick={(e) => {
        e.stopPropagation();
        onJump();
      }}
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0" style={{ width: 2, background: "currentColor", opacity: 0.35 }} />
      <span className="flex-1 min-w-0 truncate" style={{ opacity: 0.65, fontStyle: preview.state === "loaded" ? undefined : "italic" }}>
        {q.from ? <span className="font-semibold">{q.from}: </span> : null}
        {q.line}
      </span>
    </button>
  );
}

export const HomeChatMessageRow = memo(function HomeChatMessageRow({
  m,
  mine,
  name,
  run,
  reply,
  flash,
  mention = false,
  held,
  send,
  readOnly,
  canEdit,
  actions,
  column = false,
  face = null,
}: {
  m: HomeChatMessage;
  mine: boolean;
  /** The name over this run (its first, someone else's); null: none. */
  name: string | null;
  run: RunPos;
  /** The original, when this is a reply. */
  reply: ReplyPreview | null;
  /** Just jumped to: the accent wash. */
  flash: boolean;
  /** Someone else's message that mentions you: a quiet accent ring. */
  mention?: boolean;
  /** Its hold menu is open: the ring that follows the bubble. */
  held: boolean;
  send: RowSend;
  /** No reactions or replies (an archived channel, a read-only DM). */
  readOnly: boolean;
  /** A "Not sent" bubble can go back into the (empty) box. */
  canEdit: boolean;
  actions: HomeChatRowActions;
  /** Someone else's in a channel: the sender column (homeChatRows). */
  column?: boolean;
  /** The last of their run: the picture beside the tail (one object per
   *  person, so this memoized row compares it by identity). */
  face?: HomeChatFace | null;
}) {
  const optimistic = m.id.startsWith("~");
  const spaced = run.first;
  const side = mine ? "self-end items-end" : "self-start items-start";
  if (m.deleted) {
    return (
      <div
        data-home-chat-msg={m.id}
        data-testid="home-chat-msg-deleted"
        className={`relative flex flex-col max-w-[78%] min-w-0 ${side}${spaced ? " mt-1.5" : ""}`}
        style={column ? COLUMN_STYLE : undefined}
        data-sender-column={column ? "on" : undefined}
      >
        {flash ? <span aria-hidden className="k2-hc-wash" data-testid="home-chat-wash" /> : null}
        <span className="px-3 py-0.5 text-[13px] italic text-[var(--color-text-muted)] select-none">{DELETED_TEXT}</span>
      </div>
    );
  }
  const holdable = !optimistic && Boolean(m.body.trim());
  const tail = run.last ? (mine ? "mine" : "theirs") : null;
  const pending = send?.status === "sending";
  const failed = send?.status === "failed";
  const nonce = optimistic ? m.id.slice(1) : null;
  const bubble = (
    <div
      className={`relative px-3 py-2 leading-snug break-words min-w-0 max-w-full${tail ? " zen-tail" : ""}${held ? " zen-outlined" : mention && !mine ? " k2-hc-mention" : ""}`}
      data-testid="home-chat-bubble"
      data-tail={tail || undefined}
      data-mention={mention && !mine ? "" : undefined}
      {...{ [MESSAGE_HOLD_ATTR]: holdable ? m.id : undefined }}
      aria-haspopup={holdable ? "menu" : undefined}
      aria-description={holdable ? "Hold the bubble to react, reply or copy" : undefined}
      style={{
        ...(holdable ? NO_SELECT : null),
        fontSize: zenTextPx(17),
        borderRadius: 18,
        background: mine ? "var(--color-accent-fill)" : "var(--color-bubble-agent)",
        ["--k2-bubble" as string]: mine ? "var(--color-accent-fill)" : "var(--color-bubble-agent)",
        color: mine ? "var(--color-on-accent)" : "var(--color-text-primary)",
        opacity: pending ? SENDING_OPACITY : 1,
      }}
    >
      <div className="min-w-0 max-w-full overflow-hidden" data-bubble-body="" style={SELECTABLE}>
        {m.replyTo && reply ? <QuoteStrip preview={reply} onJump={() => actions.jump(m.replyTo!)} /> : null}
        <ChatMessageBody text={m.body} className="!p-0" style={bubbleBodyStyle()} />
      </div>
    </div>
  );
  return (
    <div
      data-home-chat-msg={m.id}
      data-testid="home-chat-msg"
      data-mine={mine ? "" : undefined}
      data-run={run.first && run.last ? "solo" : run.first ? "first" : run.last ? "last" : "middle"}
      data-flash={flash ? "" : undefined}
      className={`relative flex flex-col max-w-[78%] min-w-0 ${side}${spaced ? " mt-1.5" : ""}`}
      style={column ? COLUMN_STYLE : undefined}
      data-sender-column={column ? "on" : undefined}
    >
      {flash ? <span aria-hidden className="k2-hc-wash" data-testid="home-chat-wash" /> : null}
      {name ? (
        <span
          className="relative flex items-baseline gap-1.5 text-[11px] text-[var(--color-text-muted)] px-3 mb-0.5 min-w-0 max-w-full"
          data-testid="home-chat-msg-meta"
        >
          <span className="truncate min-w-0" data-testid="home-chat-msg-name">
            {name}
          </span>
          <span className="shrink-0" aria-hidden>
            •
          </span>
          <span className="shrink-0">{mountainTime(m.createdAtMs)}</span>
        </span>
      ) : null}
      {/* The bubble and its chips: what the hold menu lifts above the dim
          (the name line stays on the page, as iOS lifts only the bubble). */}
      <div className={`flex flex-col min-w-0 max-w-full ${mine ? "items-end" : "items-start"}`} data-home-chat-lift={m.id}>
      {/* In the column: the bubble in its own box, so the picture sits
          against it and the chips under it never push it down. */}
      {column ? (
        <div className="relative min-w-0 max-w-full" data-home-chat-bubble-box="">
          {bubble}
          {face ? <HomeChatSenderPicture face={face} /> : null}
        </div>
      ) : (
        bubble
      )}
      <ReactionChips
        reactions={m.reactions}
        mine={mine}
        disabled={readOnly || optimistic}
        onToggle={(emoji) => actions.toggleReaction(m.id, emoji)}
        whoFor={(emoji) => actions.whoReacted(m.id, emoji)}
      />
      </div>
      {mine && (run.last || send) ? (
        <span
          className="flex items-center gap-2 h-4 leading-4 whitespace-nowrap text-[11px] text-[var(--color-text-muted)] px-2 mt-0.5"
          data-testid="home-chat-msg-status"
          data-status={failed ? "failed" : pending ? "sending" : "sent"}
        >
          {failed && nonce && send?.final ? (
            // A retry can't fix it (an archived channel): no Retry.
            <span className="text-[var(--color-status-warn-text)]" data-testid="home-chat-not-sent" title={send.error || undefined}>
              Not sent
            </span>
          ) : failed && nonce ? (
            <>
              <button
                type="button"
                className="text-[var(--color-status-warn-text)] bg-transparent border-0 p-0"
                data-testid="home-chat-retry"
                aria-label="Not sent. Tap to retry"
                title={send?.error || undefined}
                onClick={() => actions.retry(nonce)}
              >
                Not sent · Retry
              </button>
              {canEdit ? (
                <button type="button" className="bg-transparent border-0 p-0" data-testid="home-chat-edit" onClick={() => actions.edit(nonce)}>
                  Edit
                </button>
              ) : null}
            </>
          ) : pending ? (
            "Sending…"
          ) : (
            mountainTime(m.createdAtMs)
          )}
        </span>
      ) : null}
    </div>
  );
});

/** A DM call's record: a quiet centred line ("Missed call", "Call · 4:12")
 *  with Call back once the call is over (desktop `HomeChatCallRecord`).
 *  `onCallBack` is the call builder's (absent: no button). */
export const HomeChatCallLine = memo(function HomeChatCallLine({
  m,
  me,
  flash,
  onCallBack,
}: {
  m: HomeChatMessage;
  me: string | null;
  flash: boolean;
  onCallBack?: () => void;
}) {
  if (!m.call) return null;
  const line = callRecordLine(m.call, me);
  const missed = line.kind === "missed";
  return (
    <div
      data-home-chat-msg={m.id}
      data-testid="home-chat-call"
      data-call={line.kind}
      className="relative self-center flex items-center justify-center gap-2 min-w-0 max-w-full my-1.5 px-3 text-[12px]"
      style={{ color: "var(--color-text-muted)" }}
    >
      {flash ? <span aria-hidden className="k2-hc-wash" /> : null}
      <span className="flex shrink-0" style={{ color: missed ? "var(--color-status-error)" : "var(--color-text-muted)" }}>
        <PhoneIcon size={13} strokeWidth={2} />
      </span>
      <span className="truncate" style={missed ? { color: "var(--color-status-error-text)" } : undefined} data-testid="home-chat-call-text">
        {line.text}
      </span>
      <span className="shrink-0" aria-hidden>
        ·
      </span>
      <span className="shrink-0">{mountainTime(m.createdAtMs)}</span>
      {line.callBack && onCallBack ? (
        <button
          type="button"
          className="shrink-0 zen-glass zen-glass-pill text-[12px] font-semibold"
          style={{ minHeight: 26, padding: "0 10px", color: "var(--color-accent-text)" }}
          data-testid="home-chat-call-back"
          onClick={onCallBack}
        >
          Call back
        </button>
      ) : null}
    </div>
  );
});
