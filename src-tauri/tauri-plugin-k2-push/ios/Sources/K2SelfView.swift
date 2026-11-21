// The native self-view: your own camera on the call screen's tile, drawn by
// an AVSampleBufferDisplayLayer over the webview instead of the webview's
// WebCodecs path (encode, bridge, decode: several frames late). About one
// frame behind the camera.
//
// Frames: Sew's `local:camera` native sink (voice/self_view.rs) hands each
// camera frame's own CVPixelBuffer (NV12, from the camera's pool) to
// `k2_self_view_frame`, on the sink's thread. The buffer is borrowed for the
// call: binding it here takes ARC's retain (CFRetain), which the sample
// buffer and the layer keep while they need it and release after (CFRelease).
// No copy. The frame goes to the layer on `queue` synchronously, so at most
// the layer's own one or two buffers are held: a slow layer makes Sew's
// one-frame slot drop, never a queue here.
//
// Placement: the page keeps the tile's box and reports its rect in webview
// points (`callOp selfViewFrame {x, y, w, h, visible, radius}`) on layout,
// scroll, resize and orientation; this view follows it, above the webview,
// rounded like the kit's tile, aspect fill. `visible: false` (the tile went,
// the camera paused, something covers it) hides it. It hides in the
// background on its own and comes back on return if the page still has a
// rect. Touches go through to the page.
//
// Mirror: the frames come upright and never mirrored; the front camera's are
// shown flipped (as a mirror). A change of camera (a flip) comes with a
// discontinuity: the layer is flushed and the next frame goes to it only
// after the view's mirror changed on the main thread, so no frame shows the
// wrong way round.

import AVFoundation
import CoreMedia
import K2VideoFrames
import UIKit
import os.log

private func selfViewLog(_ message: String) {
  os_log(
    "[K2SelfView] %{public}@", log: OSLog(subsystem: "com.alakazamlabs.k2so.companion", category: "k2selfview"),
    type: .default, message)
}

// ── Rust's entry points (k2-push `selfview`), on Sew's sink thread ─────

/// One camera frame's CVPixelBufferRef, borrowed for the call: the binding
/// below holds ARC's own retain until the layer is done with it.
@_cdecl("k2_self_view_frame")
public func k2SelfViewFrame(_ buffer: UnsafeMutableRawPointer?, _ mirror: Bool, _ discontinuity: Bool, _ pts90k: Int64) {
  guard let buffer = buffer else { return }
  let pixelBuffer = Unmanaged<CVPixelBuffer>.fromOpaque(buffer).takeUnretainedValue()
  K2SelfView.shared.enqueue(
    pixelBuffer, mirror: mirror, discontinuity: discontinuity, pts: CMTime(value: pts90k, timescale: 90_000))
}

/// Drop what the layer holds (`removeImage`: show nothing).
@_cdecl("k2_self_view_flush")
public func k2SelfViewFlush(_ removeImage: Bool) {
  K2SelfView.shared.flush(removeImage: removeImage)
}

/// The call ended: the self-view hides (callOp `end` / `report ended`).
func k2SelfViewCallEnded() {
  K2SelfView.shared.setTile(nil, radius: 0)
}

/// The display view, flipped as a whole for the mirror. Its own layer is
/// the display layer.
private final class K2SelfDisplayView: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
  var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

/// The rounded, clipping box at the page's rect. Lays the display view out
/// by bounds and centre, so the mirror transform never fights the frame.
private final class K2SelfBox: UIView {
  let display = K2SelfDisplayView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    addSubview(display)
  }

  required init?(coder: NSCoder) { fatalError("not from a coder") }

  override func layoutSubviews() {
    super.layoutSubviews()
    display.bounds = CGRect(origin: .zero, size: bounds.size)
    display.center = CGPoint(x: bounds.midX, y: bounds.midY)
  }
}

final class K2SelfView: NSObject {
  static let shared = K2SelfView()

  /// The app's webview: tile rects are in its points. Set by the plugin.
  weak var webView: UIView?

  // Main thread.
  private var box: K2SelfBox?
  /// The page's tile (`selfViewFrame`), nil while it isn't on screen.
  private var tile: (rect: CGRect, radius: CGFloat)?
  private var backgrounded = false
  private var mirroredOnMain = false
  private var observers: [NSObjectProtocol] = []

  // `queue`: every frame goes through it.
  private let queue = DispatchQueue(label: "k2.selfview", qos: .userInteractive)
  private var layer: AVSampleBufferDisplayLayer?
  /// The view is on screen: frames go to the layer only then.
  private var showing = false
  /// The mirror the view has (or is getting), as the queue last set it.
  private var mirrored = false
  /// The view's mirror is changing on the main thread: frames wait (drop)
  /// until it has, so none shows the wrong way round.
  private var mirroring = false
  /// Frames shown and dropped, for the log when the tile hides.
  private var shown: UInt64 = 0
  private var dropped: UInt64 = 0

  private override init() {
    super.init()
  }

  // ── Placement (main) ───────────────────────────────────────────────

  /// `selfViewFrame`: the page's tile at `rect` (webview points), or nil when
  /// it isn't on screen.
  @discardableResult
  func setTile(_ rect: CGRect?, radius: CGFloat) -> [String: Any] {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { self.setTile(rect, radius: radius) }
      return ["ok": true]
    }
    let was = tile != nil
    tile = rect.flatMap { $0.width > 0 && $0.height > 0 ? ($0, max(0, radius)) : nil }
    if tile != nil { prepare() }
    place()
    if was != (tile != nil) { selfViewLog("tile \(tile != nil ? "on" : "off")") }
    return state()
  }

  func state() -> [String: Any] {
    ["ok": true, "tile": tile != nil, "shown": box.map { !$0.isHidden } ?? false]
  }

  /// The box in the webview's window, hidden (once).
  private func prepare() {
    if box != nil { return }
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    guard let window = webView?.window ?? windows.first(where: { $0.isKeyWindow }) ?? windows.first else {
      selfViewLog("no window")
      return
    }
    let b = K2SelfBox(frame: .zero)
    b.isUserInteractionEnabled = false
    b.backgroundColor = .clear
    b.clipsToBounds = true
    b.isHidden = true
    b.display.isUserInteractionEnabled = false
    b.display.backgroundColor = .clear
    b.display.displayLayer.videoGravity = .resizeAspectFill
    b.display.transform = mirroredOnMain ? CGAffineTransform(scaleX: -1, y: 1) : .identity
    window.addSubview(b)
    box = b
    let layer = b.display.displayLayer
    queue.async { self.layer = layer }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) {
        [weak self] _ in
        self?.backgrounded = true
        self?.place()
      },
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) {
        [weak self] _ in
        self?.backgrounded = false
        self?.place()
      },
    ]
  }

  /// Over the webview at the tile, or hidden.
  private func place() {
    guard let b = box, let window = b.superview else { return }
    if let t = tile, !backgrounded, let web = webView, web.window === window {
      b.frame = web.convert(t.rect, to: window)
      b.layer.cornerRadius = t.radius
      window.bringSubviewToFront(b)
      if b.isHidden {
        b.isHidden = false
        queue.async { self.showing = true }
      }
    } else if !b.isHidden {
      b.isHidden = true
      queue.async {
        self.showing = false
        // No stale picture when it comes back: the next frame is fresh.
        if let layer = self.layer { Self.flush(layer, removeImage: true) }
        selfViewLog("hidden after \(self.shown) frames, \(self.dropped) dropped")
      }
    }
  }

  // ── Frames (any thread) ────────────────────────────────────────────

  /// One camera frame. Runs on `queue` before returning, so the caller's
  /// borrow is all it needs; the retains it takes live in the sample.
  func enqueue(_ pixelBuffer: CVPixelBuffer, mirror: Bool, discontinuity: Bool, pts: CMTime) {
    queue.sync {
      guard let layer = layer, showing else { return }
      if mirroring {
        dropped += 1
        return
      }
      if discontinuity { Self.flush(layer, removeImage: false) }
      if mirror != mirrored {
        // A flip: the old picture goes, and this frame (and any after it)
        // waits for the view's new mirror (the main thread), so none shows
        // the wrong way round.
        mirrored = mirror
        mirroring = true
        Self.flush(layer, removeImage: true)
        DispatchQueue.main.async {
          self.setMirror(mirror)
          self.queue.async {
            self.mirroring = false
            self.push(pixelBuffer, pts: pts, on: layer)
          }
        }
        return
      }
      push(pixelBuffer, pts: pts, on: layer)
    }
  }

  /// A flush asked by Rust (a reset, the sink closed or the camera off).
  func flush(removeImage: Bool) {
    queue.sync {
      guard let layer = layer else { return }
      Self.flush(layer, removeImage: removeImage)
    }
  }

  private func setMirror(_ on: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    mirroredOnMain = on
    box?.display.transform = on ? CGAffineTransform(scaleX: -1, y: 1) : .identity
  }

  // ── Frames (queue) ─────────────────────────────────────────────────

  private func push(_ pixelBuffer: CVPixelBuffer, pts: CMTime, on layer: AVSampleBufferDisplayLayer) {
    guard showing, layer === self.layer else { return }
    // A failed layer (or one the system interrupted) takes nothing until it
    // is flushed; each camera frame stands alone.
    if Self.failed(layer) || Self.needsFlush(layer) { Self.flush(layer, removeImage: false) }
    guard Self.ready(layer) else {
      dropped += 1
      return
    }
    do {
      Self.enqueue(try K2VideoFrames.sampleBuffer(pixelBuffer: pixelBuffer, pts: pts), on: layer)
      shown += 1
    } catch {
      dropped += 1
      selfViewLog("frame: \(error)")
    }
  }

  // ── The layer's renderer (iOS 17 moved it to `sampleBufferRenderer`) ──

  private static func enqueue(_ sample: CMSampleBuffer, on layer: AVSampleBufferDisplayLayer) {
    if #available(iOS 17.0, *) { layer.sampleBufferRenderer.enqueue(sample) } else { layer.enqueue(sample) }
  }

  private static func failed(_ layer: AVSampleBufferDisplayLayer) -> Bool {
    if #available(iOS 17.0, *) { return layer.sampleBufferRenderer.status == .failed }
    return layer.status == .failed
  }

  private static func needsFlush(_ layer: AVSampleBufferDisplayLayer) -> Bool {
    if #available(iOS 17.0, *) { return layer.sampleBufferRenderer.requiresFlushToResumeDecoding }
    if #available(iOS 14.0, *) { return layer.requiresFlushToResumeDecoding }
    return false
  }

  private static func ready(_ layer: AVSampleBufferDisplayLayer) -> Bool {
    if #available(iOS 17.0, *) { return layer.sampleBufferRenderer.isReadyForMoreMediaData }
    return layer.isReadyForMoreMediaData
  }

  private static func flush(_ layer: AVSampleBufferDisplayLayer, removeImage: Bool) {
    if #available(iOS 17.0, *) {
      layer.sampleBufferRenderer.flush(removingDisplayedImage: removeImage, completionHandler: nil)
    } else if removeImage {
      layer.flushAndRemoveImage()
    } else {
      layer.flush()
    }
  }
}
