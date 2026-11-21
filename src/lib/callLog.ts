import { invoke } from "@tauri-apps/api/core";

/** One "Send call log" line (Rust keeps codes only: `[a-z0-9_.:-]`, at
 *  most 6 words, nothing token-shaped). Off iOS, and under test, nothing. */
export function callLogNote(words: string[]): void {
  void Promise.resolve()
    .then(() => invoke("voice_note", { words }))
    .catch(() => {});
}
