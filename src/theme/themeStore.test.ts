// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { darkPaletteFor, writeSelection } from "./palettes";
import { useThemeStore } from "./themeStore";

const palette = () => document.documentElement.getAttribute("data-palette");
const scheme = () => document.documentElement.getAttribute("data-scheme");

beforeEach(() => {
  localStorage.clear();
  writeSelection({ mode: "light", dark: "yellow", light: "veil" }, true);
  useThemeStore.setState({ mode: "light", dark: "yellow", light: "veil", shown: "veil", darkHolds: 0 });
  useThemeStore.getState().setMode("light");
});

describe("darkPaletteFor (the terminal stays dark)", () => {
  it("keeps a dark palette on screen", () => {
    expect(darkPaletteFor({ mode: "light", dark: "yellow", light: "obsidian" }, "obsidian")).toBe("obsidian");
    expect(darkPaletteFor({ mode: "dark", dark: "yellow", light: "veil" }, "yellow")).toBe("yellow");
  });
  it("Veil on screen: the dark side's pick, else Obsidian", () => {
    expect(darkPaletteFor({ mode: "light", dark: "yellow", light: "veil" }, "veil")).toBe("yellow");
    expect(darkPaletteFor({ mode: "light", dark: "obsidian", light: "veil" }, "veil")).toBe("obsidian");
    expect(darkPaletteFor({ mode: "light", dark: "veil", light: "veil" }, "veil")).toBe("obsidian");
  });
});

describe("holdDark", () => {
  it("stamps the dark palette while held and Veil again once released", () => {
    expect(palette()).toBe("veil");
    const release = useThemeStore.getState().holdDark();
    expect(palette()).toBe("yellow");
    expect(scheme()).toBe("dark");
    release();
    release(); // twice is once
    expect(palette()).toBe("veil");
    expect(useThemeStore.getState().darkHolds).toBe(0);
  });

  it("two holds: dark until both let go", () => {
    const a = useThemeStore.getState().holdDark();
    const b = useThemeStore.getState().holdDark();
    a();
    expect(palette()).toBe("yellow");
    b();
    expect(palette()).toBe("veil");
  });

  it("a change of mode while held stays dark; the selection itself is untouched", () => {
    const release = useThemeStore.getState().holdDark();
    useThemeStore.getState().pickPalette("dark", "obsidian");
    expect(palette()).toBe("obsidian");
    useThemeStore.getState().setMode("light");
    expect(palette()).toBe("obsidian");
    expect(useThemeStore.getState().shown).toBe("veil");
    expect(localStorage.getItem("k2.palette.light")).toBe("veil");
    release();
    expect(palette()).toBe("veil");
  });
});
