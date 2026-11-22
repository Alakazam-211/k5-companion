// One person's profile picture on a server (K2 0.46.8 `/cli/people/picture`,
// `crates/k2-daemon/src/people_picture_routes.rs`):
//
//   GET /cli/people/picture?person=<login>
//     → {ok, person, imageHash, imageUrl}   (both null: no picture)
//
// `person` is a login: `owner` for the server's owner (`k2:owner`), else a
// Connect username (case-insensitive; an owner-linked login reads as the
// owner). `imageUrl` is a JPEG data URL; `imageHash` is the picture's rev,
// the `pictureRev` of `GET /cli/home-chat/people` and a Home chat push's
// `avatarRev`. A 404 `unknown_person`: not a person on that server.
//
// Not a Home chat route, so it goes straight through `scopedFetch` (a
// refusal here never touches the Home chat gate). Never throws.

import { scopedFetch } from "./scopedFetch";
import type { ServerScope } from "./scope";

export const PERSON_PICTURE_PATH = "/cli/people/picture";

export type PersonPictureAnswer =
  | { ok: true; imageUrl: string | null; imageHash: string | null }
  /** `gone`: the server says there is no such person (404), so asking
   *  again won't help; otherwise a network or server failure. */
  | { ok: false; gone: boolean };

/** The route's answer body → picture + hash (a non-image URL reads as no
 *  picture). Pure. */
export function parsePersonPicture(body: unknown): { imageUrl: string | null; imageHash: string | null } {
  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const url = typeof o.imageUrl === "string" ? o.imageUrl.trim() : "";
  const hash = typeof o.imageHash === "string" ? o.imageHash.trim() : "";
  const imageUrl = url.toLowerCase().startsWith("data:image/") && url.includes(",") ? url : null;
  return { imageUrl, imageHash: imageUrl && hash ? hash : null };
}

/** `GET /cli/people/picture?person=<login>` on `scope`, background priority. */
export async function fetchPersonPicture(scope: ServerScope, login: string): Promise<PersonPictureAnswer> {
  const person = login.trim();
  if (!person) return { ok: false, gone: true };
  try {
    const r = await scopedFetch(scope, PERSON_PICTURE_PATH, {
      query: { person },
      priority: "background",
      timeoutMs: 20_000,
    });
    if (r.status === 404) return { ok: false, gone: true };
    if (!r.ok) return { ok: false, gone: false };
    return { ok: true, ...parsePersonPicture(JSON.parse(r.text) as unknown) };
  } catch {
    return { ok: false, gone: false };
  }
}
