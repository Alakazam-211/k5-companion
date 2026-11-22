import { create } from "zustand";
import {
  applyTheme,
  darkPaletteFor,
  nativeLook,
  PALETTES,
  readAccent,
  readSelection,
  resolvePalette,
  selectPalette,
  systemPrefersLight,
  writeAccent,
  writeSelection,
  type PaletteId,
  type SchemeMode,
  type StyleScheme,
  type ThemeSelection,
} from "./palettes";
import type { AccentChoice } from "./styleAccent";
import { nativeAppearanceAvailable, onNativeSystemAppearance, syncNativeAppearance } from "./nativeAppearance";

/** Settings → Themes (ThemesPage.tsx; desktop's Settings → Themes): Light,
 *  Dark or Auto; the palette for each side (under Auto, the two picks);
 *  and an accent for each of the three palettes. */
type ThemeState = ThemeSelection & {
  /** The palette on screen (Auto resolved against the system). */
  shown: PaletteId;
  /** Each palette's accent; null is the palette's own. */
  accents: Record<PaletteId, AccentChoice | null>;
  setMode: (mode: SchemeMode) => void;
  /** A palette card: that side's palette, any of the three (outside Auto, the mode follows). */
  pickPalette: (side: StyleScheme, id: PaletteId) => void;
  setAccent: (id: PaletteId, choice: AccentChoice | null) => void;
  /** The system's appearance changed (Auto). */
  refresh: () => void;
  /** Screens open that keep the app dark (the terminal); while any is,
   *  the dark palette (darkPaletteFor) is stamped instead of `shown`. */
  darkHolds: number;
  /** Keep the app dark until the returned release is called. */
  holdDark: () => () => void;
};

/** The palette actually stamped: `shown`, or its dark stand-in while a
 *  screen holds the app dark. */
function stamped(sel: ThemeSelection, shown: PaletteId, holds: number): PaletteId {
  return holds > 0 ? darkPaletteFor(sel, shown) : shown;
}

/** Stamp the page and tell native, for a selection and its palette. */
function stamp(sel: ThemeSelection, shown: PaletteId, holds: number, systemLight: boolean): void {
  const id = stamped(sel, shown, holds);
  applyTheme(id, readAccent(id));
  // Held dark, native shows that palette on both sides, so the keyboard,
  // status bar and sheets stay dark with the page.
  syncNativeAppearance(nativeLook(holds > 0 ? { ...sel, dark: id, light: id } : sel, systemLight));
}

function readAccents(): Record<PaletteId, AccentChoice | null> {
  return Object.fromEntries(PALETTES.map((p) => [p.id, readAccent(p.id)])) as Record<PaletteId, AccentChoice | null>;
}

/** Persist a selection, stamp what it shows, and return the state to set. */
function commit(sel: ThemeSelection, holds: number): Pick<ThemeState, "mode" | "dark" | "light" | "shown"> {
  const light = systemPrefersLight();
  writeSelection(sel, light);
  const shown = resolvePalette(sel, light);
  stamp(sel, shown, holds, light);
  return { mode: sel.mode, dark: sel.dark, light: sel.light, shown };
}

const initial = readSelection();

export const useThemeStore = create<ThemeState>((set, get) => ({
  ...initial,
  shown: resolvePalette(initial),
  accents: readAccents(),
  darkHolds: 0,
  setMode: (mode) => {
    const { dark, light, darkHolds } = get();
    set(commit({ mode, dark, light }, darkHolds));
  },
  pickPalette: (side, id) => {
    const { mode, dark, light, darkHolds } = get();
    set(commit(selectPalette({ mode, dark, light }, side, id), darkHolds));
  },
  setAccent: (id, choice) => {
    writeAccent(id, choice);
    const accents = { ...get().accents, [id]: readAccent(id) };
    const { mode, dark, light, shown, darkHolds } = get();
    if (id === stamped({ mode, dark, light }, shown, darkHolds)) applyTheme(id, accents[id]);
    set({ accents });
  },
  refresh: () => {
    const { mode, dark, light, shown, darkHolds } = get();
    const sel = { mode, dark, light };
    const systemLight = systemPrefersLight();
    const next = resolvePalette(sel, systemLight);
    // Native under Auto has already restyled for the iPhone; this moves
    // the colour behind the page with it (deduped: nothing changed,
    // nothing sent).
    const held = darkHolds > 0 ? { ...sel, dark: darkPaletteFor(sel, next), light: darkPaletteFor(sel, next) } : sel;
    syncNativeAppearance(nativeLook(held, systemLight));
    if (next === shown) return;
    const id = stamped(sel, next, darkHolds);
    applyTheme(id, readAccent(id));
    set({ shown: next });
  },
  holdDark: () => {
    const change = (by: number) => {
      const { mode, dark, light, shown, darkHolds } = get();
      const holds = Math.max(0, darkHolds + by);
      const sel = { mode, dark, light };
      // Only a change of what's stamped restamps (a second hold, or a
      // dark palette already on screen, changes nothing on the page).
      if (stamped(sel, shown, holds) !== stamped(sel, shown, darkHolds) || (holds > 0) !== (darkHolds > 0)) {
        stamp(sel, shown, holds, systemPrefersLight());
      }
      set({ darkHolds: holds });
    };
    change(1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      change(-1);
    };
  },
}));

/** Under Auto, follow the system's light/dark as it changes. On the phone
 *  native reports the iPhone's appearance (nativeAppearance.ts): the web
 *  view's media query there is native's override (the palette on screen),
 *  not the iPhone. Elsewhere, the media query. */
export function watchSystemScheme(): () => void {
  const onChange = () => useThemeStore.getState().refresh();
  if (nativeAppearanceAvailable()) return onNativeSystemAppearance(onChange);
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener?.("change", onChange);
  return () => mq.removeEventListener?.("change", onChange);
}
