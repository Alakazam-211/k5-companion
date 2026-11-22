#![cfg_attr(not(target_os = "ios"), allow(dead_code))]
//! The native self-view: your own camera on the call screen's tile, about
//! one frame behind the camera, instead of the webview's path (VP8 encode,
//! the bridge, a WebCodecs decode).
//!
//! Sew's native sink on `local:camera` (plugin 0.9.3) hands over each camera
//! frame as captured: the OS's own CVPixelBuffer from the camera's pool,
//! upright, never mirrored, with the camera's facing. It never opens the
//! camera itself. Each frame goes to K2SelfView.swift (k2-push
//! `selfview::frame`) with its mirror flag (the front camera) and its
//! discontinuity (after an open, a pause or a flip: the layer flushes).
//!
//! When the sink is open ([`SelfPlan`]): in a call, while the webview shows
//! your tile on the call screen and your camera is on or paused
//! (`voice_self_view {tile, camera}`). It closes when the camera stops, the
//! call ends or the tile goes. Opening and closing run on a thread of their
//! own ([`self_loop`]): the voice listener can't call [`VoiceControl`]
//! (it runs under the plugin's lock), so it and the command only queue.
//!
//! Buffer lifetime: the pointer is borrowed from the sink's event, which
//! lives for the whole consumer call; Swift takes its own retain (ARC)
//! before returning and releases it once the layer is done. Nothing here
//! retains or releases.
//!
//! The call log gets a `camera self_view` line every [`STATS_EVERY`] while
//! the sink is open: Sew's `frames_in` (the camera's frames the sink took)
//! against `frames_out` and the drops, so a TestFlight log shows the camera
//! pool's pressure.

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_k2_push::selfview;
use tauri_plugin_sew_voice::native::{
    CameraFeed, NativePayload, NativeSink, NativeSinkStats, NativeSinkTarget, NativeVideoConsumer, NativeVideoEvent,
};
use tauri_plugin_sew_voice::VoiceControl;

use super::{code, pixel_buffer, pts_90k, Native};

/// Sew's self-view track (`tauri_plugin_sew_voice::video::LOCAL_CAMERA`).
pub const LOCAL_CAMERA: &str = "local:camera";

/// How often an open sink notes its counts in the call log.
pub const STATS_EVERY: Duration = Duration::from_secs(5);

/// What [`self_loop`] hears, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToSelf {
    /// The call screen shows your tile (the webview's `tile`).
    Tile(bool),
    /// Your camera is on or paused (the webview's `camera`, from the kit's
    /// `local_video`).
    Camera(bool),
    /// In a call (connecting, connected, reconnecting), or not any more.
    Call(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfAct {
    Open,
    Close,
}

/// Whether the self-view sink should be open, and whether it is.
#[derive(Debug, Default)]
pub struct SelfPlan {
    tile: bool,
    camera: bool,
    call: bool,
    open: bool,
}

impl SelfPlan {
    pub fn next(&mut self, msg: ToSelf) -> Option<SelfAct> {
        match msg {
            ToSelf::Tile(on) => self.tile = on,
            ToSelf::Camera(on) => self.camera = on,
            ToSelf::Call(on) => self.call = on,
        }
        self.want()
    }

    fn want(&self) -> Option<SelfAct> {
        match (self.tile && self.camera && self.call, self.open) {
            (true, false) => Some(SelfAct::Open),
            (false, true) => Some(SelfAct::Close),
            _ => None,
        }
    }

    /// What `act` did (`ok`: an open opened). A refused open tries again on
    /// the next message that still wants it.
    pub fn done(&mut self, act: SelfAct, ok: bool) {
        self.open = act == SelfAct::Open && ok;
    }

    pub fn is_open(&self) -> bool {
        self.open
    }
}

/// What [`self_loop`] does, so tests can stand in.
pub trait SelfOps {
    /// True when the sink opened.
    fn open(&mut self) -> bool;
    /// Drop the sink.
    fn close(&mut self);
    /// Every [`STATS_EVERY`] while open: the call log's counts.
    fn tick(&mut self);
}

/// The self-view sink's own thread, until every sender is gone (then an
/// open sink is closed).
pub fn self_loop(ops: &mut impl SelfOps, rx: mpsc::Receiver<ToSelf>, every: Duration) {
    let mut plan = SelfPlan::default();
    loop {
        match rx.recv_timeout(every) {
            Ok(msg) => {
                let Some(act) = plan.next(msg) else { continue };
                let ok = match act {
                    SelfAct::Open => ops.open(),
                    SelfAct::Close => {
                        ops.close();
                        true
                    }
                };
                plan.done(act, ok);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if plan.is_open() {
                    ops.tick();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if plan.is_open() {
                    ops.close();
                }
                return;
            }
        }
    }
}

/// Start the thread; its sender goes to `native`.
pub fn start(native: &Native) -> mpsc::Sender<ToSelf> {
    let (tx, rx) = mpsc::channel();
    let mut sink = SelfViewSink { native: native.clone(), sink: None, counts: Arc::new(SelfCounts::default()) };
    std::thread::Builder::new()
        .name("k2-self-view".into())
        .spawn(move || self_loop(&mut sink, rx, STATS_EVERY))
        .expect("the self-view thread starts");
    tx
}

/// The listener's state as [`ToSelf::Call`]: a live call (connecting,
/// connected, reconnecting), not one held for a recording answer or over.
pub fn in_call(state: &tauri_plugin_sew_voice::CallState) -> bool {
    use tauri_plugin_sew_voice::CallState;
    matches!(state, CallState::Connecting | CallState::Connected | CallState::Reconnecting { .. })
}

/// What the consumer handed Swift, for the call log.
#[derive(Debug, Default)]
pub struct SelfCounts {
    /// Frames to K2SelfView.
    pub shown: AtomicU64,
    /// Camera frames with no CVPixelBuffer (CPU planes): not shown.
    pub no_buffer: AtomicU64,
    pub discontinuities: AtomicU64,
    pub mirrored: AtomicU64,
    /// The feed now: 0 off, 1 live, 2 paused.
    pub feed: AtomicU8,
}

impl SelfCounts {
    fn feed_name(&self) -> &'static str {
        match self.feed.load(Ordering::Relaxed) {
            1 => "live",
            2 => "paused",
            _ => "off",
        }
    }
}

/// The call log's line: Sew's sink counters and ours (counts only).
pub fn stats_line(stats: &NativeSinkStats, counts: &SelfCounts) -> String {
    let n = |a: &AtomicU64| a.load(Ordering::Relaxed);
    format!(
        "camera self_view feed={} frames_in={} frames_out={} fps={:.1} dropped_queue_full={} consumer_us_avg={} shown={} no_buffer={} discontinuities={} mirrored={}",
        counts.feed_name(),
        stats.frames_in,
        stats.frames_out,
        stats.fps,
        stats.dropped_queue_full,
        stats.consumer_us_avg,
        n(&counts.shown),
        n(&counts.no_buffer),
        n(&counts.discontinuities),
        n(&counts.mirrored),
    )
}

/// What Swift gets for one of the sink's events.
#[derive(Debug, PartialEq)]
pub enum SelfFeed {
    /// A camera frame's CVPixelBufferRef, borrowed while the event lives.
    Frame { buffer: *mut std::ffi::c_void, mirror: bool, discontinuity: bool, pts_90k: i64 },
    Flush { remove_image: bool },
}

/// The sink's event as Swift's calls (and the counts).
pub fn self_feed(event: &NativeVideoEvent, counts: &SelfCounts) -> Option<SelfFeed> {
    let add = |n: &AtomicU64| {
        n.fetch_add(1, Ordering::Relaxed);
    };
    match event {
        NativeVideoEvent::SelfView { feed } => {
            let (n, out) = match feed {
                CameraFeed::Live => (1, None),
                // Kept: the page shows "Camera paused" and hides the view.
                CameraFeed::Paused => (2, None),
                // No camera: nothing to show.
                _ => (0, Some(SelfFeed::Flush { remove_image: true })),
            };
            counts.feed.store(n, Ordering::Relaxed);
            out
        }
        NativeVideoEvent::Frame(f) => {
            let NativePayload::Camera(cam) = &f.payload else { return None };
            let Some(buffer) = pixel_buffer(&f.payload) else {
                add(&counts.no_buffer);
                return None;
            };
            add(&counts.shown);
            if f.discontinuity {
                add(&counts.discontinuities);
            }
            let mirror = cam.mirror();
            if mirror {
                add(&counts.mirrored);
            }
            Some(SelfFeed::Frame { buffer, mirror, discontinuity: f.discontinuity, pts_90k: pts_90k(f.timestamp_us) })
        }
        NativeVideoEvent::Reset { .. } => Some(SelfFeed::Flush { remove_image: false }),
        _ => None,
    }
}

/// Sew's `local:camera` native sink, into K2SelfView.
struct SelfViewSink {
    native: Native,
    sink: Option<NativeSink>,
    counts: Arc<SelfCounts>,
}

impl SelfOps for SelfViewSink {
    fn open(&mut self) -> bool {
        let Some(app) = self.native.app() else { return false };
        let control = app.state::<VoiceControl>().inner().clone();
        self.counts = Arc::new(SelfCounts::default());
        let feed = SelfViewFeed { counts: self.counts.clone() };
        // `max_size` changes nothing for the self-view: frames are the camera's.
        match control.open_native_sink(NativeSinkTarget::Track(LOCAL_CAMERA.into()), (0, 0), Arc::new(feed)) {
            Ok(sink) => {
                self.native.note("camera self_view open");
                self.sink = Some(sink);
                true
            }
            Err(e) => {
                self.native.note(&format!("camera self_view refused {}", code(&e.code)));
                false
            }
        }
    }

    fn close(&mut self) {
        // The sink first: no frame after the flush.
        if let Some(sink) = self.sink.take() {
            self.native.note(&stats_line(&sink.stats(), &self.counts));
            sink.close();
        }
        selfview::flush(true);
        self.native.note("camera self_view closed");
    }

    fn tick(&mut self) {
        if let Some(sink) = &self.sink {
            self.native.note(&stats_line(&sink.stats(), &self.counts));
        }
    }
}

/// The sink's events to K2SelfView, on the sink's own thread.
struct SelfViewFeed {
    counts: Arc<SelfCounts>,
}

impl NativeVideoConsumer for SelfViewFeed {
    fn on_video(&self, event: NativeVideoEvent) {
        match self_feed(&event, &self.counts) {
            // `event` (and so the buffer) lives until this returns.
            Some(SelfFeed::Frame { buffer, mirror, discontinuity, pts_90k }) => {
                selfview::frame(buffer, mirror, discontinuity, pts_90k)
            }
            Some(SelfFeed::Flush { remove_image }) => selfview::flush(remove_image),
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeOps {
        acts: Vec<&'static str>,
        refuse: bool,
    }

    impl SelfOps for FakeOps {
        fn open(&mut self) -> bool {
            self.acts.push("open");
            !self.refuse
        }
        fn close(&mut self) {
            self.acts.push("close");
        }
        fn tick(&mut self) {
            self.acts.push("tick");
        }
    }

    fn run(ops: &mut FakeOps, msgs: &[ToSelf]) -> Vec<&'static str> {
        let (tx, rx) = mpsc::channel();
        for m in msgs {
            tx.send(*m).unwrap();
        }
        drop(tx);
        self_loop(ops, rx, Duration::from_secs(60));
        std::mem::take(&mut ops.acts)
    }

    use ToSelf::*;

    #[test]
    fn open_only_in_a_call_with_the_tile_and_the_camera() {
        let mut ops = FakeOps::default();
        // Any order: the last of the three opens it, once.
        assert_eq!(run(&mut ops, &[Tile(true), Camera(true), Call(true), Tile(true), Camera(true)]), vec!["open", "close"]);
        assert_eq!(run(&mut ops, &[Call(true), Camera(true), Tile(true)]), vec!["open", "close"]);
        // Never without all three.
        assert_eq!(run(&mut ops, &[Call(true), Camera(true), Tile(false)]), Vec::<&str>::new());
        assert_eq!(run(&mut ops, &[Tile(true), Camera(true)]), Vec::<&str>::new());
        assert_eq!(run(&mut ops, &[Call(true), Tile(true)]), Vec::<&str>::new());
    }

    #[test]
    fn the_camera_off_the_call_ending_or_the_tile_hiding_drops_the_sink() {
        let mut plan = SelfPlan::default();
        let mut step = |m: ToSelf| {
            let act = plan.next(m);
            if let Some(a) = act {
                plan.done(a, true);
            }
            act
        };
        assert_eq!(step(Call(true)), None);
        assert_eq!(step(Tile(true)), None);
        assert_eq!(step(Camera(true)), Some(SelfAct::Open));
        // The camera stops.
        assert_eq!(step(Camera(false)), Some(SelfAct::Close));
        assert_eq!(step(Camera(true)), Some(SelfAct::Open));
        // The tile hides (the call screen closed).
        assert_eq!(step(Tile(false)), Some(SelfAct::Close));
        assert_eq!(step(Tile(false)), None);
        assert_eq!(step(Tile(true)), Some(SelfAct::Open));
        // The call ends.
        assert_eq!(step(Call(false)), Some(SelfAct::Close));
        assert_eq!(step(Call(false)), None);
        assert_eq!(step(Camera(false)), None);
    }

    #[test]
    fn a_refused_open_tries_again_and_the_end_of_the_thread_closes() {
        let mut ops = FakeOps { refuse: true, ..FakeOps::default() };
        assert_eq!(run(&mut ops, &[Call(true), Tile(true), Camera(true), Camera(true)]), vec!["open", "open"]);
        // Still open when the senders go: closed then.
        let mut ops = FakeOps::default();
        assert_eq!(run(&mut ops, &[Call(true), Tile(true), Camera(true)]), vec!["open", "close"]);
    }

    #[test]
    fn an_open_sink_notes_its_counts_on_the_clock() {
        let mut ops = FakeOps::default();
        let (tx, rx) = mpsc::channel();
        for m in [Call(true), Tile(true), Camera(true)] {
            tx.send(m).unwrap();
        }
        let sender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            tx.send(Camera(false)).unwrap();
            std::thread::sleep(Duration::from_millis(60));
        });
        self_loop(&mut ops, rx, Duration::from_millis(20));
        sender.join().unwrap();
        let acts = ops.acts;
        assert_eq!(acts.first(), Some(&"open"));
        let close = acts.iter().position(|a| *a == "close").expect("closed");
        assert!(acts[1..close].iter().all(|a| *a == "tick") && close > 1, "{acts:?}");
        // No ticks once closed.
        assert_eq!(acts.len(), close + 1, "{acts:?}");
    }

    #[test]
    fn only_a_live_call_counts_as_in_a_call() {
        use tauri_plugin_sew_voice::CallState;
        assert!(in_call(&CallState::Connecting));
        assert!(in_call(&CallState::Connected));
        assert!(in_call(&CallState::Reconnecting { attempt: 1 }));
        assert!(!in_call(&CallState::Idle));
    }

    fn camera_frame(facing: sew_call_client::kessel_video::Facing, discontinuity: bool) -> NativeVideoEvent {
        use sew_call_client::kessel_video::{PixelFormat, Planes, VideoFrame};
        let planes = Planes::new(PixelFormat::Nv12, 4, 2, vec![0u8; 12], [4, 4, 0], [0, 8, 0]).unwrap();
        let frame = VideoFrame::from_planes(planes, 4, 2, 0).unwrap();
        NativeVideoEvent::Frame(tauri_plugin_sew_voice::native::NativeVideoFrame {
            track: LOCAL_CAMERA.into(),
            keyframe: true,
            discontinuity,
            timestamp_us: 1_000_000,
            rtp_ts: 90_000,
            payload: NativePayload::Camera(tauri_plugin_sew_voice::native::CameraFrame::new(frame, facing)),
        })
    }

    #[test]
    fn the_feed_and_frames_without_a_pixel_buffer() {
        use sew_call_client::kessel_video::Facing;
        let counts = SelfCounts::default();
        assert_eq!(self_feed(&NativeVideoEvent::SelfView { feed: CameraFeed::Live }, &counts), None);
        assert_eq!(counts.feed_name(), "live");
        assert_eq!(self_feed(&NativeVideoEvent::SelfView { feed: CameraFeed::Paused }, &counts), None);
        assert_eq!(counts.feed_name(), "paused");
        assert_eq!(
            self_feed(&NativeVideoEvent::SelfView { feed: CameraFeed::Off }, &counts),
            Some(SelfFeed::Flush { remove_image: true })
        );
        assert_eq!(counts.feed_name(), "off");
        assert_eq!(
            self_feed(&NativeVideoEvent::Reset { track: LOCAL_CAMERA.into() }, &counts),
            Some(SelfFeed::Flush { remove_image: false })
        );
        // CPU planes (no CVPixelBuffer) aren't shown: counted only.
        assert_eq!(self_feed(&camera_frame(Facing::Front, true), &counts), None);
        assert_eq!(counts.no_buffer.load(Ordering::Relaxed), 1);
        assert_eq!(counts.shown.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_camera_frame_carries_its_mirror_and_discontinuity() {
        // A frame with a real CVPixelBuffer needs the camera; what Swift gets
        // from one is the same mapping as this, with `pixel_buffer`'s pointer.
        use sew_call_client::kessel_video::Facing;
        let NativeVideoEvent::Frame(f) = camera_frame(Facing::Front, true) else { unreachable!() };
        let NativePayload::Camera(cam) = &f.payload else { unreachable!() };
        assert!(cam.mirror());
        let NativeVideoEvent::Frame(f) = camera_frame(Facing::Back, false) else { unreachable!() };
        let NativePayload::Camera(cam) = &f.payload else { unreachable!() };
        assert!(!cam.mirror());
        assert_eq!(pts_90k(f.timestamp_us), 90_000);
    }

    #[test]
    fn the_stats_line_is_counts_only() {
        let mut stats = NativeSinkStats::default();
        stats.frames_in = 300;
        stats.frames_out = 290;
        stats.fps = 29.5;
        stats.dropped_queue_full = 10;
        let counts = SelfCounts::default();
        counts.shown.store(290, Ordering::Relaxed);
        counts.feed.store(1, Ordering::Relaxed);
        let line = stats_line(&stats, &counts);
        assert!(
            line.starts_with("camera self_view feed=live frames_in=300 frames_out=290 fps=29.5 dropped_queue_full=10"),
            "{line}"
        );
        assert!(line.contains("shown=290 no_buffer=0"), "{line}");
    }
}
