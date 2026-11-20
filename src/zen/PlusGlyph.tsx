/** The `＋` drawn by the composer's attach button. Shared with the
 *  Agents / Servers bottom bar so both pluses stay identical. */
export const PLUS_GLYPH = "＋";
export const PLUS_GLYPH_PX = 22;

/** `bright`: primary text (white on dark palettes), like the header bubbles' icons (the Agents / Servers
 *  bottom bar, Riley 2026-10-18). The composer keeps the muted plus. */
export function PlusGlyph({ bright = false, color }: { bright?: boolean; /** Overrides both (the drawers' accent plus). */ color?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="plus-glyph"
      style={{
        fontSize: PLUS_GLYPH_PX,
        lineHeight: 1,
        color: color ?? (bright ? "var(--color-text-primary)" : "var(--color-text-muted)"),
      }}
    >
      {PLUS_GLYPH}
    </span>
  );
}
