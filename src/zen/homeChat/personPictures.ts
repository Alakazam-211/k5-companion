// People's profile pictures in Home chat (K2 `f988f071ac`, prd-home-chat-
// pushes-v1 §5): `GET /cli/home-chat/people` rows carry `pictureRev` (the
// picture's hash, null: none), and `GET /cli/people/picture?person=<login>`
// gives the picture itself. This module fetches each picture once per
// (server, person, rev), keeps it in memory and on the device, and hands
// it to the notification avatar cache (lib/avatarCache.ts, key
// `<subdomain>|person:<ext>`, rev = pictureRev) so the NSE, which has no
// network, can show it.
//
// Rules:
//   - Asked only for people the app shows or messages: a mounted avatar
//     (`usePersonPicture`: people rows, channel senders, the DM header,
//     members) asks for its own. When a server's people list is small
//     (PREFETCH_ALL_MAX with a picture or fewer), all of them are asked
//     too, so a channel's pushes from people not on screen get a picture.
//   - Background priority, PICTURE_FETCH_CONCURRENCY at a time overall.
//   - Fetched once per rev; a new rev fetches again (the old picture shows
//     until the new one lands: a stale picture beats initials). A failure
//     waits PICTURE_RETRY_MS before that rev is asked again; a 404 is
//     final for the rev.
//   - rev null: initials, and the cached picture is dropped (memory and
//     device). rev absent (an older daemon): nothing is asked, nothing
//     dropped; initials as before.
//   - The login asked for is `owner` for `k2:owner`, else the username.
//   - On the device: one IndexedDB row per person (`k2-person-pictures`),
//     read back once per launch; memory only when IndexedDB is missing.
//   - A removed or re-keyed server drops its pictures.

import { useEffect } from "react";
import { create } from "zustand";
import type { HomeChatPeople } from "../../api/homeChatPure";
import { fetchPersonPicture, type PersonPictureAnswer } from "../../api/personPicture";
import { scopeFor } from "../../api/scope";
import { queuePersonAvatars } from "../../lib/avatarCache";
import { onServerForget } from "../../stores/servers";

/** Who an avatar is, for its picture. `rev` as the people list gave it. */
export interface PersonPictureRef {
  serverId: string;
  ext: string;
  /** Their username there (the login asked for; the owner is `owner`). */
  username: string;
  rev: string | null | undefined;
}

export type PictureRow = { key: string; serverId: string; ext: string; rev: string; url: string; at: number };

export interface PictureBackend {
  loadAll(): Promise<PictureRow[]>;
  put(row: PictureRow): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

/** Pictures fetched at once, across servers. */
export const PICTURE_FETCH_CONCURRENCY = 2;
/** A failed fetch waits this long before the same rev is asked again. */
export const PICTURE_RETRY_MS = 60_000;
/** A people list with this many pictures or fewer is fetched whole. */
export const PREFETCH_ALL_MAX = 12;
/** Pictures kept on the device (oldest go first). */
export const PICTURE_STORE_MAX = 300;

/** `<serverId>|<ext>` (ext lowercased). */
export function pictureKey(serverId: string, ext: string): string {
  return `${serverId}|${ext.trim().toLowerCase()}`;
}

/** The login `/cli/people/picture?person=` takes: `owner` for the owner,
 *  else the username ("" when unknown: not asked). */
export function pictureLogin(ext: string, username: string): string {
  if (ext.trim().toLowerCase() === "k2:owner") return "owner";
  return username.trim();
}

/** key → the picture shown (its rev may trail the list's while a new one
 *  is fetched). */
export const usePersonPictures = create<{ pics: Record<string, { rev: string; url: string }> }>(() => ({ pics: {} }));

// ─── The device store (IndexedDB; memory when it's missing) ───

const DB_NAME = "k2-person-pictures";
const STORE = "pictures";

function idbBackend(): PictureBackend {
  let dbp: Promise<IDBDatabase> | null = null;
  let broken = false;
  const open = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const factory = globalThis.indexedDB;
      if (!factory) {
        reject(new Error("no IndexedDB"));
        return;
      }
      let r: IDBOpenDBRequest;
      try {
        r = factory.open(DB_NAME, 1);
      } catch (e) {
        reject(e);
        return;
      }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"));
      r.onblocked = () => reject(new Error("IndexedDB open blocked"));
    }));
  const run = async <T,>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | null> => {
    if (broken) return null;
    try {
      const db = await open();
      return await new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const r = op(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(r ? r.result : null);
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("IndexedDB failed"));
      });
    } catch {
      broken = true;
      return null;
    }
  };
  return {
    loadAll: async () => ((await run("readonly", (s) => s.getAll())) as PictureRow[] | null) ?? [],
    put: async (row) => {
      await run("readwrite", (s) => s.put(row));
    },
    delete: async (keys) => {
      if (!keys.length) return;
      await run("readwrite", (s) => {
        for (const k of keys) s.delete(k);
        return undefined;
      });
    },
  };
}

// ─── State ───

type Deps = {
  fetch: (serverId: string, login: string) => Promise<PersonPictureAnswer>;
  backend: PictureBackend;
  /** To the notification avatar cache. */
  toNse: (serverId: string, ext: string, url: string, rev: string) => void;
  now: () => number;
};

const defaultDeps = (): Deps => ({
  fetch: (serverId, login) => fetchPersonPicture(scopeFor(serverId), login),
  backend: idbBackend(),
  toNse: (serverId, ext, url, rev) => queuePersonAvatars(serverId, [{ ext, picture: url, pictureRev: rev }]),
  now: Date.now,
});

let deps: Deps = defaultDeps();
/** key → the row behind `usePersonPictures` (server and ext for forgets). */
const rows = new Map<string, PictureRow>();
/** `<key>\n<rev>` asked and answered this session (fetched or 404). */
const asked = new Set<string>();
/** `<key>\n<rev>` → when its fetch last failed. */
const failedAt = new Map<string, number>();
/** key → the latest ask waiting for a slot. */
const queue = new Map<string, PersonPictureRef>();
/** `<key>\n<rev>` being fetched now. */
const active = new Set<string>();
const running = new Set<Promise<void>>();
/** serverId → bumped on forget: a fetch that started before is dropped. */
const epochs = new Map<string, number>();
let hydrated: Promise<void> | null = null;

function revOk(rev: unknown): rev is string {
  return typeof rev === "string" && rev.trim().length > 0;
}

function show(row: PictureRow): void {
  usePersonPictures.setState((s) => {
    const cur = s.pics[row.key];
    if (cur && cur.rev === row.rev && cur.url === row.url) return s;
    return { pics: { ...s.pics, [row.key]: { rev: row.rev, url: row.url } } };
  });
}

function unshow(keys: string[]): void {
  usePersonPictures.setState((s) => {
    if (!keys.some((k) => k in s.pics)) return s;
    const pics = { ...s.pics };
    for (const k of keys) delete pics[k];
    return { pics };
  });
}

/** Read the device's pictures back, once (memory wins over the device). */
function hydrate(): Promise<void> {
  return (hydrated ??= (async () => {
    let saved: PictureRow[] = [];
    try {
      saved = await deps.backend.loadAll();
    } catch {
      saved = [];
    }
    for (const r of saved) {
      if (!r || typeof r.key !== "string" || !revOk(r.rev) || typeof r.url !== "string" || !r.url.startsWith("data:image/")) continue;
      if (typeof r.serverId !== "string" || typeof r.ext !== "string" || rows.has(r.key)) continue;
      rows.set(r.key, r);
      show(r);
      // Keeps the NSE's copy (and its LRU place); same rev = skipped there.
      deps.toNse(r.serverId, r.ext, r.url, r.rev);
    }
  })());
}

function keep(row: PictureRow): void {
  rows.set(row.key, row);
  show(row);
  void deps.backend.put(row).catch(() => {});
  deps.toNse(row.serverId, row.ext, row.url, row.rev);
  if (rows.size > PICTURE_STORE_MAX) {
    const oldest = [...rows.values()].sort((a, b) => a.at - b.at).slice(0, rows.size - PICTURE_STORE_MAX);
    drop(oldest.map((r) => r.key));
  }
}

function drop(keys: string[]): void {
  const gone = keys.filter((k) => rows.has(k) || k in usePersonPictures.getState().pics);
  for (const k of keys) queue.delete(k);
  if (!gone.length) return;
  for (const k of gone) rows.delete(k);
  unshow(gone);
  void deps.backend.delete(gone).catch(() => {});
}

function track(p: Promise<void>): void {
  running.add(p);
  void p.finally(() => running.delete(p));
}

async function fetchOne(key: string, ref: PersonPictureRef, rev: string): Promise<void> {
  const ask = `${key}\n${rev}`;
  const epoch = epochs.get(ref.serverId) ?? 0;
  let r: PersonPictureAnswer;
  try {
    r = await deps.fetch(ref.serverId, pictureLogin(ref.ext, ref.username));
  } catch {
    r = { ok: false, gone: false };
  }
  if ((epochs.get(ref.serverId) ?? 0) !== epoch) return;
  if (!r.ok) {
    if (r.gone) asked.add(ask);
    else failedAt.set(ask, deps.now());
    return;
  }
  asked.add(ask);
  failedAt.delete(ask);
  if (!r.imageUrl) {
    // Removed since the list was read: initials.
    drop([key]);
    return;
  }
  const got = r.imageHash ?? rev;
  asked.add(`${key}\n${got}`);
  keep({ key, serverId: ref.serverId, ext: ref.ext.trim(), rev: got, url: r.imageUrl, at: deps.now() });
}

function due(key: string, rev: string): boolean {
  if (usePersonPictures.getState().pics[key]?.rev === rev) return false;
  const ask = `${key}\n${rev}`;
  if (asked.has(ask) || active.has(ask)) return false;
  const failed = failedAt.get(ask);
  return failed === undefined || deps.now() - failed >= PICTURE_RETRY_MS;
}

function pump(): void {
  while (active.size < PICTURE_FETCH_CONCURRENCY && queue.size) {
    const [key, ref] = queue.entries().next().value as [string, PersonPictureRef];
    queue.delete(key);
    const rev = ref.rev;
    if (!revOk(rev) || !due(key, rev)) continue;
    const ask = `${key}\n${rev}`;
    active.add(ask);
    track(
      fetchOne(key, ref, rev).finally(() => {
        active.delete(ask);
        pump();
      })
    );
  }
}

/** Ask for one person's picture when it's due (after the device's copies
 *  are read back). rev null drops theirs; rev absent does nothing. Never
 *  throws; resolves once the ask is queued, not when it's fetched. */
export function wantPersonPicture(ref: PersonPictureRef | null | undefined): Promise<void> {
  if (!ref || !ref.serverId || !ref.ext.trim() || ref.rev === undefined) return Promise.resolve();
  const p = hydrate().then(() => {
    const key = pictureKey(ref.serverId, ref.ext);
    if (!revOk(ref.rev)) {
      drop([key]);
      return;
    }
    if (!pictureLogin(ref.ext, ref.username) || !due(key, ref.rev.trim())) return;
    queue.set(key, { ...ref, rev: ref.rev.trim() });
    pump();
  });
  track(p);
  return p;
}

/** A server's people list was read: drop the pictures it says are gone,
 *  and, when the list is small, ask for every picture (pushes from people
 *  not on screen). Older daemons (no `pictureRev`): nothing. */
export function notePeoplePictures(serverId: string, people: HomeChatPeople | null | undefined, myUsername = ""): Promise<void> {
  if (!serverId || !people) return Promise.resolve();
  const list = people.people;
  const withPicture = list.filter((p) => revOk(p.pictureRev));
  const all = withPicture.length <= PREFETCH_ALL_MAX;
  const asks: Promise<void>[] = [];
  for (const p of list) {
    if (p.pictureRev === null || all) asks.push(wantPersonPicture({ serverId, ext: p.ext, username: p.username, rev: p.pictureRev }));
  }
  // Your own: dropped when gone; fetched only where it's shown.
  if (people.me.ext && people.me.pictureRev === null) {
    asks.push(wantPersonPicture({ serverId, ext: people.me.ext, username: myUsername, rev: null }));
  }
  return Promise.all(asks).then(() => {});
}

/** The picture to draw for `ref` (null: initials), asking for it when due.
 *  The legacy `picture` data URL on a row still wins at the call site. */
export function usePersonPicture(ref: PersonPictureRef | null | undefined): string | null {
  const serverId = ref?.serverId ?? "";
  const ext = ref?.ext ?? "";
  const username = ref?.username ?? "";
  const rev = ref?.rev;
  const key = serverId && ext ? pictureKey(serverId, ext) : "";
  const url = usePersonPictures((s) => (key && revOk(rev) ? (s.pics[key]?.url ?? null) : null));
  useEffect(() => {
    if (!serverId || !ext || rev === undefined) return;
    void wantPersonPicture({ serverId, ext, username, rev });
  }, [serverId, ext, username, rev]);
  return url;
}

function forgetServer(serverId: string): void {
  epochs.set(serverId, (epochs.get(serverId) ?? 0) + 1);
  const prefix = `${serverId}|`;
  for (const k of [...queue.keys()]) if (k.startsWith(prefix)) queue.delete(k);
  const keys = [...rows.values()].filter((r) => r.serverId === serverId).map((r) => r.key);
  for (const k of Object.keys(usePersonPictures.getState().pics)) if (k.startsWith(prefix) && !keys.includes(k)) keys.push(k);
  drop(keys);
}

onServerForget((id) => forgetServer(id));

/** Tests only: wait for every queued ask and fetch to settle. */
export async function __settlePersonPicturesForTests(): Promise<void> {
  while (running.size) await Promise.all([...running]);
}

/** Tests only: swap the edges and forget all state. */
export function __setPersonPictureDepsForTests(next: Partial<Deps> | null): void {
  rows.clear();
  asked.clear();
  failedAt.clear();
  queue.clear();
  active.clear();
  running.clear();
  epochs.clear();
  hydrated = null;
  usePersonPictures.setState({ pics: {} });
  deps = next ? { ...defaultDeps(), ...next } : defaultDeps();
}

/** Tests only: forget a server as `onServerForget` would. */
export const __forgetServerForTests = forgetServer;
