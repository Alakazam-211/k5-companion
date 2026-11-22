// K2's own form for this server's GitHub credential, on the phone (K2
// 0.46.10, permission card `compute.git-access-setup`). It opens from the
// card's "Set up GitHub access" and posts straight to
// `POST /cli/compute/git-access/setup` as this person (owner or admin), the
// route `k2 compute git-access setup` uses: the key or token goes into this
// server's vault there and never passes through the card, the Thread or the
// agent. The card sends Allow only after the route said yes (desktop's
// GitAccessSetupForm does the same).
//
// The secret rule (desktop SecretCard / GitAccessSetupForm): the App ID,
// key and token are uncontrolled fields, read from the DOM once, on Save,
// and never put in React state, a store or a log. A chosen .pem is read
// straight into the key field. Every field is emptied after a save and
// when the sheet closes.

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ServerScope } from "../api/scope";
import { setupGitAccess, type GitAccessSetup } from "../api/permissionCards";
import { useBackHandler } from "../lib/androidBack";
import { useViewport } from "../lib/useViewportHeight";
import { isUnsupportedPick, nativePick, nativePickerAvailable } from "../lib/nativePicker";

const MUTED = "var(--color-text-muted)";

export type GitAccessKind = "app" | "token";

/** The same guidance as `k2 compute git-access --help`. */
export const GIT_ACCESS_GUIDANCE =
  "Give it Repository permissions: Contents read-only, on just the repos you will grant (install the App on them, or pick them for the token).";

/** A .pem is a few KB; anything much bigger isn't one. */
const PEM_MAX_BYTES = 64 * 1024;

/** Why these values can't be sent yet, or null (the daemon checks again). */
export function gitAccessProblem(kind: GitAccessKind, appId: string, key: string, token: string): string | null {
  if (kind === "app") {
    if (!/^\d+$/.test(appId.trim())) return "The App ID is the number on the App's settings page.";
    if (!key.includes("PRIVATE KEY")) return "Paste the private key (.pem), or choose the file.";
    return null;
  }
  if (!token.trim()) return "Paste the fine-grained token (github_pat_…).";
  return null;
}

/** Fields that never suggest, correct or remember what's typed. */
const QUIET = { autoComplete: "off", autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

export function GitAccessSetupSheet({
  scope,
  onDone,
  onCancel,
}: {
  scope: ServerScope;
  /** The route said yes: the credential is set. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<GitAccessKind>("app");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const appIdRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLTextAreaElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const vp = useViewport();

  const clearFields = () => {
    for (const el of [appIdRef.current, keyRef.current, tokenRef.current, fileRef.current]) if (el) el.value = "";
  };
  // Closing (or leaving the Thread) drops whatever was typed. A layout
  // cleanup runs while the refs are still attached.
  useLayoutEffect(() => clearFields, []);

  const cancel = () => {
    if (busy) return;
    clearFields();
    onCancel();
  };
  useBackHandler(true, cancel);

  const readFile = async (file: File | undefined) => {
    if (!file || !keyRef.current) return;
    if (file.size > PEM_MAX_BYTES) {
      setError("That file isn't a private key. Choose the .pem from the App's settings page.");
      return;
    }
    try {
      keyRef.current.value = await file.text();
      setError(null);
    } catch {
      setError("K2 couldn't read that file. Paste the key instead.");
    }
  };

  const chooseFile = () => {
    if (!nativePickerAvailable()) {
      fileRef.current?.click();
      return;
    }
    nativePick("documents")
      .then((out) => void readFile(out.files[0]))
      .catch((e) => {
        if (isUnsupportedPick(e)) fileRef.current?.click();
        else setError("Could not open the picker. Paste the key instead.");
      });
  };

  const submit = async () => {
    if (busy) return;
    const appId = appIdRef.current?.value ?? "";
    const key = keyRef.current?.value ?? "";
    const token = tokenRef.current?.value ?? "";
    const problem = gitAccessProblem(kind, appId, key, token);
    if (problem) {
      setError(problem);
      return;
    }
    const v: GitAccessSetup = kind === "app" ? { kind, appId, keyPem: key } : { kind, token };
    setBusy(true);
    setError(null);
    const r = await setupGitAccess(scope, v);
    setBusy(false);
    if (!r.ok) {
      setError(r.text);
      return;
    }
    clearFields();
    onDone();
  };

  const field: CSSProperties = {
    width: "100%",
    minHeight: 44,
    padding: "10px 14px",
    borderRadius: 10,
    color: "var(--color-text-primary)",
    fontSize: 16,
  };
  const note = "text-[12px] leading-snug";

  const option = (k: GitAccessKind, title: string, sub: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={kind === k}
      disabled={busy}
      onClick={() => {
        if (kind === k) return;
        // The other way's fields leave the page: empty them first.
        clearFields();
        setKind(k);
        setError(null);
      }}
      className="flex-1 k2-tile text-left"
      style={{
        padding: "10px 12px",
        borderRadius: 12,
        color: "var(--color-text-primary)",
        boxShadow: kind === k ? "inset 0 0 0 2px var(--color-accent-fill)" : undefined,
      }}
      data-testid={`git-access-kind-${k}`}
    >
      <span className="block text-[15px] font-semibold">{title}</span>
      <span className="block text-[12px]" style={{ color: MUTED }}>
        {sub}
      </span>
    </button>
  );

  return createPortal(
    <div
      className="fixed left-0 right-0 flex items-end justify-center"
      style={{ top: vp.offsetTop, height: vp.height, background: "var(--color-scrim)", zIndex: 60, fontFamily: "var(--zen-font)" }}
      data-testid="git-access-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Set up GitHub access"
        className="w-full k2-tile k2-tile-sheet flex flex-col overflow-y-auto"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "16px 16px max(12px, var(--safe-bottom))",
          maxHeight: "92%",
          gap: 12,
          color: "var(--color-text-primary)",
        }}
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        data-testid="git-access-form"
      >
        <h2 className="text-[17px] font-semibold text-center shrink-0">Set up GitHub access</h2>
        <p className={note} style={{ color: MUTED }} data-testid="git-access-guidance">
          {GIT_ACCESS_GUIDANCE}
        </p>
        <div className="flex shrink-0" style={{ gap: 8 }} role="radiogroup" aria-label="Credential">
          {option("app", "GitHub App", "Preferred: 1-hour tokens, one repo each")}
          {option("token", "Token", "Fine-grained, read-only")}
        </div>

        {kind === "app" ? (
          <>
            <input
              ref={appIdRef}
              aria-label="App ID"
              inputMode="numeric"
              placeholder="App ID (on the App's settings page)"
              {...QUIET}
              disabled={busy}
              className="k2-tile k2-tile-raised outline-none"
              style={field}
              data-testid="git-access-app-id"
            />
            <textarea
              ref={keyRef}
              aria-label="Private key"
              rows={4}
              placeholder="-----BEGIN PRIVATE KEY----- (paste the .pem)"
              {...QUIET}
              disabled={busy}
              className="k2-tile k2-tile-raised outline-none resize-none"
              style={{ ...field, fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace" }}
              data-testid="git-access-key"
            />
            <div className="flex items-center" style={{ gap: 10 }}>
              <button
                type="button"
                disabled={busy}
                onClick={chooseFile}
                className="k2-tile text-[15px] shrink-0"
                style={{ minHeight: 36, padding: "0 14px", borderRadius: 10, color: "var(--color-text-primary)" }}
                data-testid="git-access-key-choose"
              >
                Choose .pem file
              </button>
              <span className={note} style={{ color: MUTED }}>
                Delete the .pem afterwards: the key lives in this server's vault.
              </span>
            </div>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              data-testid="git-access-key-file"
              onChange={(e) => {
                const input = e.target;
                void readFile(input.files?.[0]).finally(() => {
                  input.value = "";
                });
              }}
            />
          </>
        ) : (
          <>
            <input
              ref={tokenRef}
              type="password"
              aria-label="Fine-grained token"
              placeholder="github_pat_…"
              {...QUIET}
              disabled={busy}
              className="k2-tile k2-tile-raised outline-none"
              style={{ ...field, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14 }}
              data-testid="git-access-token"
            />
            <p className={note} style={{ color: MUTED }}>
              Nodes get this token itself, so give it an expiry. Classic tokens and your gh login are refused.
            </p>
          </>
        )}

        {error ? (
          <p
            className="text-[13px] leading-snug"
            role="alert"
            style={{ color: "var(--color-status-error-text)", overflowWrap: "anywhere" }}
            data-testid="git-access-error"
          >
            {error}
          </p>
        ) : null}
        <p className={note} style={{ color: MUTED }}>
          It goes straight into this server's vault. The agent never sees it.
        </p>
        <div className="flex shrink-0" style={{ gap: 10 }}>
          <button
            type="button"
            className="flex-1 text-[17px] k2-tile"
            style={{ minHeight: 44, borderRadius: 12, color: "var(--color-text-primary)" }}
            disabled={busy}
            onClick={cancel}
            data-testid="git-access-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="flex-1 text-[17px] font-semibold"
            style={{
              minHeight: 44,
              borderRadius: 12,
              color: "var(--color-on-accent)",
              background: "var(--color-accent-fill)",
              opacity: busy ? 0.5 : 1,
            }}
            disabled={busy}
            data-testid="git-access-save"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
