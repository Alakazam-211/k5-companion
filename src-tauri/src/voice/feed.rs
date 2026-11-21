#![cfg_attr(not(target_os = "ios"), allow(dead_code))]
//! The call's event feed (K2 0.46.17): `GET /_k2/voice/sew/feed`, a
//! WebSocket of Sew's dispatch frames (`{"op":0,"t","s","d"}`, READY at
//! s=1) that K2 forwards for this person's own login. The phone listens
//! only while it is in a call, and only for what changes Record and Stop:
//! Sew's `perms_changed` (RECORD_CALLS is a Sew permission; K2 never sees a
//! moderator grant it).
//!
//! Native, because the feed takes the login only as `Authorization:
//! Bearer` (no `?token=`: the query is the kit's) and a webview WebSocket
//! can't set headers. The token is the Keychain's, read here; it never
//! reaches the page. The page hears [`FEED_EVENT`] with ids only (never a
//! frame body: `voice_server_updated` carries a media token):
//!
//! - `{kind:"open"}` once K2 answered 101 (READY is on its way);
//! - `{kind:"ready"|"mine", channel, space}`: where this person is in voice
//!   (READY's own voice state, then their own `voice_state_updated`);
//! - `{kind:"perms", channels, space}`: a `perms_changed`;
//! - `{kind:"refused", code}`: K2 answered the upgrade with an HTTP status
//!   (403 for a login the feed is not for, 404 on a K2 without it);
//! - `{kind:"closed", code}`: the socket ended (4000 reset: reconnect;
//!   4001 the login ended; 1006 a drop).
//!
//! Every event carries `server` and `n` (this open's number), so the page
//! drops a closed feed's late events. One feed at a time (one call).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Wry};
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::Native;

pub const FEED_EVENT: &str = "k2-voice://feed";
const FEED_PATH: &str = "/_k2/voice/sew/feed";
/// K2 writes the 101 only after Sew's READY (its handshake: 15 s).
const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A drop with no close frame.
const CLOSE_DROPPED: u16 = 1006;

static OPENS: AtomicU64 = AtomicU64::new(0);
static FEED: Mutex<Option<(u64, tauri::async_runtime::JoinHandle<()>)>> = Mutex::new(None);

/// The feed's address on a server's base URL.
pub fn feed_url(base: &str) -> String {
    format!("{}{FEED_PATH}", base.trim_end_matches('/'))
}

fn id_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// What the page hears of one dispatch frame (pure): ids only, and only
/// for the frames above. `me` is READY's `member.id`, kept across frames.
pub fn page_event(frame: &Value, me: &mut String) -> Option<Value> {
    if frame.get("op").and_then(Value::as_u64) != Some(0) {
        return None;
    }
    let t = frame.get("t")?.as_str()?;
    let d = frame.get("d").unwrap_or(&Value::Null);
    match t {
        "ready" => {
            *me = id_of(d.pointer("/member/id")).unwrap_or_default();
            let mine = d.get("voice_states").and_then(Value::as_array).and_then(|vs| {
                vs.iter().find(|v| !me.is_empty() && id_of(v.get("member_id")).as_deref() == Some(me.as_str()))
            });
            Some(json!({
                "kind": "ready",
                "channel": mine.and_then(|v| id_of(v.get("channel_id"))),
                "space": mine.and_then(|v| id_of(v.get("space_id"))),
            }))
        }
        "voice_state_updated" => {
            if me.is_empty() || id_of(d.get("member_id")).as_deref() != Some(me.as_str()) {
                return None;
            }
            Some(json!({ "kind": "mine", "channel": id_of(d.get("channel_id")), "space": id_of(d.get("space_id")) }))
        }
        "perms_changed" => {
            let channels: Vec<String> = d
                .get("channels")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|c| id_of(c.get("channel_id"))).collect())
                .unwrap_or_default();
            Some(json!({ "kind": "perms", "channels": channels, "space": id_of(d.get("space_id")) }))
        }
        _ => None,
    }
}

/// A `Sec-WebSocket-Key`: 16 bytes, base64 (K2 only derives the accept).
fn ws_key() -> String {
    static SALT: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) as u64;
    let s = SALT.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
    let mut b = [0u8; 16];
    b[..8].copy_from_slice(&(t ^ s.rotate_left(17)).to_le_bytes());
    b[8..].copy_from_slice(&(s ^ t.rotate_left(29)).to_le_bytes());
    B64.encode(b)
}

fn tell(app: &AppHandle<Wry>, server: &str, n: u64, mut ev: Value) {
    ev["server"] = json!(server);
    ev["n"] = json!(n);
    let _ = app.emit(FEED_EVENT, ev);
}

/// Open `server`'s feed (closing any other). The open's number, or `None`
/// when the app has no address or token for that server.
pub async fn open(native: &Native, server: String) -> Option<u64> {
    let app = native.app()?;
    let base = native.host(&server)?;
    let token = native.token(&server).await?;
    let n = OPENS.fetch_add(1, Ordering::Relaxed) + 1;
    let url = feed_url(&base);
    let task = {
        let app = app.clone();
        let server = server.clone();
        tauri::async_runtime::spawn(async move {
            let (kind, code) = run(&app, &server, n, &url, &token).await;
            tell(&app, &server, n, json!({ "kind": kind, "code": code }));
        })
    };
    let old = FEED.lock().unwrap_or_else(|e| e.into_inner()).replace((n, task));
    if let Some((_, old)) = old {
        old.abort();
    }
    native.note(&format!("recording feed open n={n}"));
    Some(n)
}

/// Close the feed (the call ended or the screen let it go).
pub fn close() {
    if let Some((_, task)) = FEED.lock().unwrap_or_else(|e| e.into_inner()).take() {
        task.abort();
    }
}

/// One feed, start to end: what ended it (`refused` + the HTTP status, or
/// `closed` + the close code).
async fn run(app: &AppHandle<Wry>, server: &str, n: u64, url: &str, token: &str) -> (&'static str, u16) {
    let Ok(client) = reqwest::Client::builder().http1_only().connect_timeout(CONNECT_TIMEOUT).build() else {
        return ("closed", CLOSE_DROPPED);
    };
    let req = client
        .get(url)
        .bearer_auth(token)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", ws_key())
        .send();
    let res = match tokio::time::timeout(OPEN_TIMEOUT, req).await {
        Ok(Ok(res)) => res,
        _ => return ("closed", CLOSE_DROPPED),
    };
    let status = res.status().as_u16();
    if status != 101 {
        return ("refused", status);
    }
    let Ok(up) = res.upgrade().await else {
        return ("closed", CLOSE_DROPPED);
    };
    let mut ws = WebSocketStream::from_raw_socket(up, Role::Client, None).await;
    tell(app, server, n, json!({ "kind": "open" }));
    let mut me = String::new();
    // K2 pings; reading answers them. The phone sends nothing.
    while let Some(msg) = ws.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                if let Some(ev) = page_event(&frame, &mut me) {
                    tell(app, server, n, ev);
                }
            }
            Ok(Message::Close(frame)) => return ("closed", frame.map(|f| u16::from(f.code)).unwrap_or(1005)),
            Ok(_) => {}
            Err(_) => return ("closed", CLOSE_DROPPED),
        }
    }
    ("closed", CLOSE_DROPPED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_feed_is_on_the_servers_own_address() {
        assert_eq!(feed_url("https://box.k2.dev/"), "https://box.k2.dev/_k2/voice/sew/feed");
    }

    #[test]
    fn ready_names_this_persons_room_and_nothing_else() {
        let mut me = String::new();
        let ready = json!({ "op": 0, "t": "ready", "s": 1, "d": {
            "member": { "id": "7" },
            "voice_states": [
                { "member_id": "8", "channel_id": "99", "space_id": "5" },
                { "member_id": "7", "channel_id": "42", "space_id": "5" }
            ]
        }});
        assert_eq!(page_event(&ready, &mut me), Some(json!({ "kind": "ready", "channel": "42", "space": "5" })));
        assert_eq!(me, "7");
        let other = json!({ "op": 0, "t": "voice_state_updated", "s": 2, "d": { "member_id": "8", "channel_id": "1" } });
        assert_eq!(page_event(&other, &mut me), None);
        let moved = json!({ "op": 0, "t": "voice_state_updated", "s": 3, "d": { "member_id": "7", "channel_id": "43", "space_id": "5" } });
        assert_eq!(page_event(&moved, &mut me), Some(json!({ "kind": "mine", "channel": "43", "space": "5" })));
    }

    #[test]
    fn perms_changed_keeps_ids_only() {
        let mut me = "7".to_owned();
        let f = json!({ "op": 0, "t": "perms_changed", "s": 4, "d": {
            "space_id": "5", "my_space_perms": "123",
            "channels": [{ "channel_id": "42", "my_perms": "456" }]
        }});
        assert_eq!(page_event(&f, &mut me), Some(json!({ "kind": "perms", "channels": ["42"], "space": "5" })));
        let dm = json!({ "op": 0, "t": "perms_changed", "s": 5, "d": { "channels": [] } });
        assert_eq!(page_event(&dm, &mut me), Some(json!({ "kind": "perms", "channels": [], "space": null })));
    }

    #[test]
    fn a_media_token_never_reaches_the_page() {
        let mut me = "7".to_owned();
        let f = json!({ "op": 0, "t": "voice_server_updated", "s": 6, "d": { "token": "secret" } });
        assert_eq!(page_event(&f, &mut me), None);
        assert_eq!(page_event(&json!({ "op": 11 }), &mut me), None);
    }

    #[test]
    fn websocket_keys_are_16_bytes_and_differ() {
        let (a, b) = (ws_key(), ws_key());
        assert_eq!(B64.decode(&a).unwrap().len(), 16);
        assert_ne!(a, b);
    }
}
