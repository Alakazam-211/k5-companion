// Light palettes (Veil): glass buttons and rows take the palette's ink, never
// a hard-coded white (the owner 2026-11-19: the Files X and the viewer's
// Source / Close were white on Veil).
import { describe, expect, it } from "vitest";
import closeButton from "./GlassCloseButton.tsx?raw";
import fileViewer from "./files/FileViewer.tsx?raw";
import gardensList from "./gardens/GardensList.tsx?raw";
import gardenView from "./gardens/GardenView.tsx?raw";

const files: [string, string][] = [
  ["GlassCloseButton", closeButton],
  ["FileViewer", fileViewer],
  ["GardensList", gardensList],
  ["GardenView", gardenView],
];

describe("theme ink on glass", () => {
  it.each(files)("%s has no hard-coded white text", (_name, src) => {
    expect(src).not.toMatch(/color:\s*"#fff(fff)?"/i);
    expect(src).not.toMatch(/\btext-white\b/);
  });
});
