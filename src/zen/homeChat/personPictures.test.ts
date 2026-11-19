import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("no tauri in tests");
  }),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import type { HomeChatPeople, HomeChatPerson } from "../../api/homeChatPure";
import { parsePersonPicture, type PersonPictureAnswer } from "../../api/personPicture";
import { homeChatFace, pictureRefOf } from "./homeChatModel";
import {
  PICTURE_FETCH_CONCURRENCY,
  PICTURE_RETRY_MS,
  PREFETCH_ALL_MAX,
  __forgetServerForTests,
  __setPersonPictureDepsForTests,
  __settlePersonPicturesForTests,
  notePeoplePictures,
  pictureKey,
  pictureLogin,
  usePersonPictures,
  wantPersonPicture,
  type PictureBackend,
  type PictureRow,
} from "./personPictures";

const JPG1 = "data:image/jpeg;base64,/9j/AAA1";
const JPG2 = "data:image/jpeg;base64,/9j/AAA2";

let fetched: Array<{ serverId: string; login: string }>;
let answer: (serverId: string, login: string) => Promise<PersonPictureAnswer>;
let toNse: Array<{ serverId: string; ext: string; url: string; rev: string }>;
let saved: Map<string, PictureRow>;
let deleted: string[];
let t: number;

function backend(): PictureBackend {
  return {
    loadAll: async () => [...saved.values()],
    put: async (row) => {
      saved.set(row.key, row);
    },
    delete: async (keys) => {
      for (const k of keys) {
        deleted.push(k);
        saved.delete(k);
      }
    },
  };
}

function install() {
  __setPersonPictureDepsForTests({
    fetch: (serverId, login) => {
      fetched.push({ serverId, login });
      return answer(serverId, login);
    },
    backend: backend(),
    toNse: (serverId, ext, url, rev) => toNse.push({ serverId, ext, url, rev }),
    now: () => t,
  });
}

const shown = (serverId: string, ext: string) => usePersonPictures.getState().pics[pictureKey(serverId, ext)] ?? null;
const sam = (rev: string | null | undefined) => ({ serverId: "s1", ext: "k2:connect:sam-id", username: "sam", rev });

beforeEach(() => {
  fetched = [];
  toNse = [];
  saved = new Map();
  deleted = [];
  t = 1_000_000;
  answer = async () => ({ ok: true, imageUrl: JPG1, imageHash: "r1" });
  install();
});

afterEach(() => {
  __setPersonPictureDepsForTests(null);
});

async function want(ref: Parameters<typeof wantPersonPicture>[0]) {
  await wantPersonPicture(ref);
  await __settlePersonPicturesForTests();
}

describe("the login asked for", () => {
  it("is owner for k2:owner, else the username", () => {
    expect(pictureLogin("k2:owner", "")).toBe("owner");
    expect(pictureLogin("K2:Owner", "riley")).toBe("owner");
    expect(pictureLogin("k2:connect:abc", " sam ")).toBe("sam");
    expect(pictureLogin("k2:connect:abc", "")).toBe("");
  });

  it("the owner's row asks person=owner", async () => {
    await want({ serverId: "s1", ext: "k2:owner", username: "owner", rev: "r1" });
    expect(fetched).toEqual([{ serverId: "s1", login: "owner" }]);
  });
});

describe("parsePersonPicture", () => {
  it("reads imageUrl + imageHash; a non-image or missing URL is no picture", () => {
    expect(parsePersonPicture({ ok: true, person: "owner", imageHash: "h1", imageUrl: JPG1 })).toEqual({ imageUrl: JPG1, imageHash: "h1" });
    expect(parsePersonPicture({ ok: true, person: "owner", imageHash: null, imageUrl: null })).toEqual({ imageUrl: null, imageHash: null });
    expect(parsePersonPicture({ imageHash: "h", imageUrl: "https://x/y.jpg" })).toEqual({ imageUrl: null, imageHash: null });
    expect(parsePersonPicture(null)).toEqual({ imageUrl: null, imageHash: null });
    expect(parsePersonPicture({ imageUrl: JPG1 })).toEqual({ imageUrl: JPG1, imageHash: null });
  });
});

describe("fetch once per rev", () => {
  it("one fetch for the same (server, person, rev); shown, saved, and sent to the NSE with that rev", async () => {
    await want(sam("r1"));
    await want(sam("r1"));
    await want({ ...sam("r1"), username: "sam" });
    expect(fetched).toEqual([{ serverId: "s1", login: "sam" }]);
    expect(shown("s1", "k2:connect:sam-id")).toEqual({ rev: "r1", url: JPG1 });
    expect(saved.get(pictureKey("s1", "k2:connect:sam-id"))).toMatchObject({ serverId: "s1", ext: "k2:connect:sam-id", rev: "r1", url: JPG1 });
    expect(toNse).toEqual([{ serverId: "s1", ext: "k2:connect:sam-id", url: JPG1, rev: "r1" }]);
  });

  it("a new rev fetches again; the old picture shows until the new one lands", async () => {
    await want(sam("r1"));
    let release!: () => void;
    answer = () =>
      new Promise((res) => {
        release = () => res({ ok: true, imageUrl: JPG2, imageHash: "r2" });
      });
    const p = wantPersonPicture(sam("r2"));
    await p;
    await vi.waitFor(() => expect(fetched).toHaveLength(2));
    expect(shown("s1", "k2:connect:sam-id")).toEqual({ rev: "r1", url: JPG1 });
    release();
    await __settlePersonPicturesForTests();
    expect(shown("s1", "k2:connect:sam-id")).toEqual({ rev: "r2", url: JPG2 });
    expect(toNse.map((x) => x.rev)).toEqual(["r1", "r2"]);
    await want(sam("r2"));
    expect(fetched).toHaveLength(2);
  });

  it("the same picture on another server is its own fetch", async () => {
    await want(sam("r1"));
    await want({ ...sam("r1"), serverId: "s2" });
    expect(fetched.map((f) => f.serverId)).toEqual(["s1", "s2"]);
  });

  it("a picture read back from the device isn't fetched again for its rev", async () => {
    const key = pictureKey("s1", "k2:connect:sam-id");
    saved.set(key, { key, serverId: "s1", ext: "k2:connect:sam-id", rev: "r1", url: JPG1, at: 1 });
    install();
    await want(sam("r1"));
    expect(fetched).toEqual([]);
    expect(shown("s1", "k2:connect:sam-id")).toEqual({ rev: "r1", url: JPG1 });
    // Handed to the NSE cache again (same rev: the native side skips it).
    expect(toNse).toEqual([{ serverId: "s1", ext: "k2:connect:sam-id", url: JPG1, rev: "r1" }]);
    await want(sam("r9"));
    expect(fetched).toHaveLength(1);
  });

  it(`at most ${PICTURE_FETCH_CONCURRENCY} at a time`, async () => {
    let inFlight = 0;
    let most = 0;
    answer = async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, imageUrl: JPG1, imageHash: "r1" };
    };
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((u) => wantPersonPicture({ serverId: "s1", ext: `k2:connect:${u}`, username: u, rev: "r1" }))
    );
    await __settlePersonPicturesForTests();
    expect(fetched).toHaveLength(5);
    expect(most).toBe(PICTURE_FETCH_CONCURRENCY);
  });

  it("a failure waits before the same rev is asked again; a 404 is final", async () => {
    answer = async () => ({ ok: false, gone: false });
    await want(sam("r1"));
    await want(sam("r1"));
    expect(fetched).toHaveLength(1);
    t += PICTURE_RETRY_MS;
    answer = async () => ({ ok: true, imageUrl: JPG1, imageHash: "r1" });
    await want(sam("r1"));
    expect(fetched).toHaveLength(2);
    expect(shown("s1", "k2:connect:sam-id")?.url).toBe(JPG1);

    answer = async () => ({ ok: false, gone: true });
    await want({ serverId: "s1", ext: "k2:connect:x", username: "x", rev: "r1" });
    t += PICTURE_RETRY_MS * 10;
    await want({ serverId: "s1", ext: "k2:connect:x", username: "x", rev: "r1" });
    expect(fetched).toHaveLength(3);
  });

  it("no username (not the owner): not asked", async () => {
    await want({ serverId: "s1", ext: "k2:connect:q", username: "", rev: "r1" });
    expect(fetched).toEqual([]);
  });
});

describe("no picture", () => {
  it("rev null drops the shown and saved picture, without a fetch", async () => {
    await want(sam("r1"));
    expect(shown("s1", "k2:connect:sam-id")).not.toBeNull();
    await want(sam(null));
    expect(fetched).toHaveLength(1);
    expect(shown("s1", "k2:connect:sam-id")).toBeNull();
    expect(saved.size).toBe(0);
    expect(deleted).toEqual([pictureKey("s1", "k2:connect:sam-id")]);
  });

  it("rev null drops a picture only on the device too", async () => {
    const key = pictureKey("s1", "k2:connect:sam-id");
    saved.set(key, { key, serverId: "s1", ext: "k2:connect:sam-id", rev: "r1", url: JPG1, at: 1 });
    install();
    await want(sam(null));
    expect(shown("s1", "k2:connect:sam-id")).toBeNull();
    expect(saved.size).toBe(0);
  });

  it("the server answers no picture (removed since the list): dropped", async () => {
    await want(sam("r1"));
    answer = async () => ({ ok: true, imageUrl: null, imageHash: null });
    await want(sam("r2"));
    expect(shown("s1", "k2:connect:sam-id")).toBeNull();
  });

  it("rev absent (an older daemon): nothing asked, nothing dropped", async () => {
    await want(sam("r1"));
    await want(sam(undefined));
    expect(fetched).toHaveLength(1);
    expect(shown("s1", "k2:connect:sam-id")).not.toBeNull();
  });
});

function person(i: number, rev: string | null | undefined): HomeChatPerson {
  const p: HomeChatPerson = {
    ext: `k2:connect:p${i}`,
    username: `u${i}`,
    displayName: `U ${i}`,
    picture: null,
    role: null,
    ready: true,
    memberId: String(100 + i),
  };
  if (rev !== undefined) p.pictureRev = rev;
  return p;
}

describe("notePeoplePictures", () => {
  it("a small list: every picture is asked for; nulls are dropped", async () => {
    await want({ serverId: "s1", ext: "k2:connect:p2", username: "u2", rev: "old" });
    fetched = [];
    const people: HomeChatPeople = { me: { ext: "k2:connect:me", memberId: "1", pictureRev: null }, people: [person(1, "r1"), person(2, null), person(3, "r3")] };
    await notePeoplePictures("s1", people, "me");
    await __settlePersonPicturesForTests();
    expect(fetched.map((f) => f.login).sort()).toEqual(["u1", "u3"]);
    expect(shown("s1", "k2:connect:p2")).toBeNull();
  });

  it(`a list with more than ${PREFETCH_ALL_MAX} pictures: none asked up front (avatars ask), nulls still dropped`, async () => {
    await want({ serverId: "s1", ext: "k2:connect:p0", username: "u0", rev: "old" });
    fetched = [];
    const list = [person(0, null), ...Array.from({ length: PREFETCH_ALL_MAX + 1 }, (_, i) => person(i + 1, `r${i}`))];
    await notePeoplePictures("s1", { me: { ext: "k2:owner", memberId: null }, people: list });
    await __settlePersonPicturesForTests();
    expect(fetched).toEqual([]);
    expect(shown("s1", "k2:connect:p0")).toBeNull();
  });

  it("an older daemon's list (no pictureRev): no fetches", async () => {
    await notePeoplePictures("s1", { me: { ext: "k2:owner", memberId: null }, people: [person(1, undefined), person(2, undefined)] });
    await __settlePersonPicturesForTests();
    expect(fetched).toEqual([]);
  });
});

describe("a forgotten server", () => {
  it("drops its pictures and ignores a fetch that was running", async () => {
    await want(sam("r1"));
    let release!: () => void;
    answer = () =>
      new Promise((res) => {
        release = () => res({ ok: true, imageUrl: JPG2, imageHash: "r2" });
      });
    await wantPersonPicture({ serverId: "s1", ext: "k2:owner", username: "owner", rev: "r2" });
    await vi.waitFor(() => expect(fetched).toHaveLength(2));
    __forgetServerForTests("s1");
    release();
    await __settlePersonPicturesForTests();
    expect(usePersonPictures.getState().pics).toEqual({});
    expect(saved.size).toBe(0);
  });
});

describe("the faces' refs", () => {
  it("pictureRefOf: null without a server or without pictureRev (older daemons)", () => {
    expect(pictureRefOf("s1", person(1, "r1"))).toEqual({ serverId: "s1", ext: "k2:connect:p1", username: "u1", rev: "r1" });
    expect(pictureRefOf("s1", person(1, null))).toEqual({ serverId: "s1", ext: "k2:connect:p1", username: "u1", rev: null });
    expect(pictureRefOf("s1", person(1, undefined))).toBeNull();
    expect(pictureRefOf(null, person(1, "r1"))).toBeNull();
    expect(pictureRefOf("s1", null)).toBeNull();
  });

  it("homeChatFace carries the ref only with a server id and a rev", () => {
    const people: HomeChatPeople = { me: { ext: "k2:owner", memberId: "1" }, people: [person(1, "r1"), person(2, undefined)] };
    expect(homeChatFace(people, "101", "s1").pictureOf).toEqual({ serverId: "s1", ext: "k2:connect:p1", username: "u1", rev: "r1" });
    expect(homeChatFace(people, "101").pictureOf).toBeUndefined();
    expect("pictureOf" in homeChatFace(people, "102", "s1")).toBe(false);
  });
});
