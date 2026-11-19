// The viewing lease (K2 0.46.16 `home-chat-push-v1`, daemon
// `home_chat/chat_push.rs` `parse_viewing` / `lease`; desktop
// `lib/home-chat/viewing-lease.ts`): while a Home chat is on screen and the
// app is in front, the phone says so on `WS /cli/home-chat/events`, and the
// daemon holds this person's phone pushes for that conversation. Text
// frames:
//
//   {"t":"viewing","conv":"<sew id>","visible":true}   now, then every 30 s
//   {"t":"viewing","conv":"<sew id>","visible":false}  at once when it stops
//
// The daemon keeps each lease 90 s and drops it when the socket closes, so a
// reopened socket gets the current lease again at once (`linked`). This only
// quiets pushes: `POST /cli/home-chat/view` still joins and subscribes typing.
//
// Pure: the timers and the send are given (the chat view passes the events
// socket's `send` from `onLink`).

/** How often a held lease is sent again (the daemon keeps one 90 s). */
export const VIEWING_LEASE_REPEAT_MS = 30_000;

/** One `viewing` text frame. */
export function viewingFrame(conv: string, visible: boolean): string {
  return JSON.stringify({ t: "viewing", conv, visible });
}

export interface ViewingLeaseDeps {
  /** Send a text frame on the events socket; false when it isn't open. */
  send: (text: string) => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (t: unknown) => void;
}

export interface ViewingLease {
  /** The conversation now viewed (null: none). A change ends the last one
   *  at once (`visible:false`) and starts the new one. */
  set: (conv: string | null) => void;
  /** The conversation the lease is for now, if any. */
  current: () => string | null;
  /** The socket (re)opened: send the current lease again now. */
  linked: () => void;
  /** Ends the lease (`visible:false`) and its timer. */
  stop: () => void;
}

export function createViewingLease(deps: ViewingLeaseDeps): ViewingLease {
  let conv: string | null = null;
  let timer: unknown = null;

  const stopTimer = (): void => {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
  };
  const hold = (): void => {
    stopTimer();
    if (conv === null) return;
    const c = conv;
    deps.send(viewingFrame(c, true));
    timer = deps.setInterval(() => {
      if (conv === c) deps.send(viewingFrame(c, true));
    }, VIEWING_LEASE_REPEAT_MS);
  };

  return {
    set: (next) => {
      if (next === conv) return;
      if (conv !== null) {
        stopTimer();
        deps.send(viewingFrame(conv, false));
      }
      conv = next;
      hold();
    },
    current: () => conv,
    linked: () => hold(),
    stop: () => {
      stopTimer();
      if (conv !== null) deps.send(viewingFrame(conv, false));
      conv = null;
    },
  };
}
