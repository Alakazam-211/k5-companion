// @vitest-environment jsdom
// PersonAvatar's profile picture (personPictures.ts): fetched by
// `pictureRev`, drawn once it lands; initials without a rev or a server
// that doesn't send one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("no tauri in tests");
  }),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { PersonAvatar } from "./HomeChatGlyphs";
import { __setPersonPictureDepsForTests } from "./personPictures";

const JPG = "data:image/jpeg;base64,/9j/AAA1";
let fetched: string[];

beforeEach(() => {
  fetched = [];
  __setPersonPictureDepsForTests({
    fetch: async (_serverId, login) => {
      fetched.push(login);
      return { ok: true, imageUrl: JPG, imageHash: "r1" };
    },
    backend: { loadAll: async () => [], put: async () => {}, delete: async () => {} },
    toNse: () => {},
  });
});

afterEach(() => {
  cleanup();
  __setPersonPictureDepsForTests(null);
});

describe("PersonAvatar pictureOf", () => {
  it("draws the fetched picture once it lands", async () => {
    render(<PersonAvatar username="owner" name="Riley Stone" pictureOf={{ serverId: "s1", ext: "k2:owner", username: "owner", rev: "r1" }} testId="pa" />);
    expect(screen.getByTestId("pa").getAttribute("data-person-avatar")).toBe("initials");
    await waitFor(() => expect(screen.getByTestId("pa").getAttribute("data-person-avatar")).toBe("picture"));
    expect(screen.getByTestId("pa").querySelector("img")?.getAttribute("src")).toBe(JPG);
    expect(fetched).toEqual(["owner"]);
  });

  it("initials and no fetch without a ref (older daemons) or with rev null", async () => {
    render(<PersonAvatar username="sam" name="Sam" pictureOf={null} testId="a" />);
    render(<PersonAvatar username="sam" name="Sam" pictureOf={{ serverId: "s1", ext: "k2:connect:x", username: "sam", rev: null }} testId="b" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("a").getAttribute("data-person-avatar")).toBe("initials");
    expect(screen.getByTestId("b").getAttribute("data-person-avatar")).toBe("initials");
    expect(fetched).toEqual([]);
  });

  it("a legacy picture on the row still wins", () => {
    render(<PersonAvatar username="sam" name="Sam" picture="data:image/png;base64,AA==" testId="c" />);
    expect(screen.getByTestId("c").querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  });
});
