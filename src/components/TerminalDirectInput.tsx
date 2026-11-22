import { useEffect, useRef, useState } from "react";
import { AccessoryBar } from "./AccessoryBar";
import { LiveInputCapture } from "./LiveInputCapture";
import type { LiveLocalEdit } from "../lib/liveInputText";

// Direct typing's input pair: the zen accessory key strip over the hidden
// live capture. It owns the sticky Ctrl state — the strip shows it, the
// capture's pipeline uses it (the next typed character becomes its
// control byte) — and disarms it when the keyboard goes down, when
// `sessionKey` changes (another terminal), or with the strip unmounting
// (leaving the terminal or switching to safe send).

interface Props {
  /** Deliver bytes to the PTY (the terminal's input seam). */
  send: (bytes: string) => void;
  /** Populated with the capture's focus() trigger (raises the keyboard). */
  focusRef: { current: (() => void) | null };
  /** The terminal this input types into; a change disarms Ctrl. */
  sessionKey?: string;
}

export function TerminalDirectInput({ send, focusRef, sessionKey }: Props) {
  const sendKeyRef = useRef<((bytes: string, localEdit?: LiveLocalEdit) => void) | null>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);

  useEffect(() => {
    setCtrlArmed(false);
  }, [sessionKey]);

  return (
    <>
      <AccessoryBar
        variant="zen"
        onKey={(bytes, localEdit) => {
          if (sendKeyRef.current) sendKeyRef.current(bytes, localEdit);
          else send(bytes);
        }}
        ctrlArmed={ctrlArmed}
        onCtrlArmedChange={(armed) => {
          setCtrlArmed(armed);
          // Arming means "the next key I type": bring the keyboard up if
          // it is down (same tap, so iOS allows it).
          if (armed) focusRef.current?.();
        }}
      />
      <LiveInputCapture
        send={send}
        focusRef={focusRef}
        sendKeyRef={sendKeyRef}
        ctrlArmed={ctrlArmed}
        onCtrlDisarm={() => setCtrlArmed(false)}
        onBlur={() => setCtrlArmed(false)}
      />
    </>
  );
}
