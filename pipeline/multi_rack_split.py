"""
Multi-rack video splitter.

Given a video where the user pans across N racks side-by-side, split it into
N best-frame images — one per rack — so the rest of the existing single-rack
analysis pipeline can run on each independently.

Algorithm (fully automated, no user input):

  1. Sample frames at evenly-spaced timestamps (~30 frames over the whole
     clip — fast enough for a 30s phone video, dense enough to catch
     short pauses on each rack).

  2. Run the existing device detector on each sampled frame to get the
     device bounding boxes.

  3. Compute each frame's "rack signature" — a horizontal cluster of
     detected device boxes (mean X position weighted by box area). The
     same rack across consecutive frames has a stable signature; a pan
     to the next rack shows up as a sudden X-shift.

  4. Detect rack-transition points: split the frame sequence wherever
     the signature shift between adjacent samples exceeds ~30% of the
     frame width (a deliberate horizontal pan, not camera shake).

  5. For each segment (= one rack), score the constituent frames by
       0.45 * device_count_normalized
     + 0.35 * mean_detection_confidence
     + 0.20 * sharpness (Laplacian variance)
     and pick the highest-scoring frame as that rack's "best frame".

  6. Save best frames to disk under outputs/multi/<video_hash>/rack_N.jpg
     and return a list of records the caller can hand to the existing
     /api/analyze pipeline (it accepts a single image at a time).

Design notes:
  - We do NOT modify the existing single-rack pipeline. Each rack's best
    frame goes through the same analyze() the regular flow uses, so per-
    rack reports / topology / SFP advice / firmware checks all work the
    same way they always did. Multi-rack only adds the "group" parent.
  - The detector comes from pipeline.detection.load_model, the same cache
    the worker warms at boot, so a video split reuses the checkpoint that
    is already resident instead of loading a second copy of it.
  - Sampled frames are scored on a downscaled copy and are NOT retained.
    Only the winning frame of each segment is re-read at full resolution,
    right before it is written. See split_video_into_racks for why.
"""

import hashlib
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

# Tunable knobs ------------------------------------------------------------
MAX_SAMPLED_FRAMES = 30  # cap on how many frames we score
MIN_DEVICES_FOR_RACK = 1  # frames with 0 devices are pan-transitions
TRANSITION_X_SHIFT_RATIO = 0.25  # adjacent samples whose mean-X differs
# by > 25% of frame width = new rack
VISUAL_CHANGE_THRESHOLD = 0.35  # 1 - HSV-histogram correlation between
# adjacent samples. > 0.35 = scene changed
# (different rack), even if X stayed put.
MIN_FRAMES_PER_RACK = 3  # a "rack" must hold the camera for >= N samples.
# This was 1, which made the filter below a
# no-op: every segment has at least one frame,
# so nothing was ever dropped. A single shaky
# frame mid-pan became its own "rack", and one
# rack filmed in one pass could split into two
# near-identical entries — which is why a
# two-rack video showed the same topology
# twice. Three samples is roughly a second of
# the camera actually being held on a rack.
DEFAULT_DEVICES_CONF = 0.20  # only used when config.json omits
# detection.devices_conf — the live value
# is read from the config so this path and
# the single-rack path can never drift.
MAX_ANALYSIS_WIDTH = 1920  # sampled frames wider than this are
# downscaled before detection. The detector
# letterboxes to imgsz=640 internally, so
# 4K pixels buy nothing but RAM and resize
# time — and 30 retained 4K BGR frames was
# ~750 MB inside a worker that already
# holds several YOLO checkpoints.


_REPO_ROOT = Path(__file__).resolve().parents[1]


def _video_hash(video_path: str) -> str:
    """Stable per-video id (used for the multi-rack output directory)."""
    h = hashlib.sha256()
    with open(video_path, "rb") as f:
        # Hash up to first 8 MiB — enough to be unique without reading 100MB
        h.update(f.read(8 * 1024 * 1024))
    return h.hexdigest()[:16]


def _sample_timestamps(total_frames: int, fps: float, k: int) -> list[int]:
    """Evenly-spaced frame indices to sample, capped at k."""
    if total_frames <= 0:
        return []
    if total_frames <= k:
        return list(range(total_frames))
    step = total_frames / k
    return [int(i * step) for i in range(k)]


def _load_config(config_path: str | None = None) -> dict:
    """Resolve the config exactly the way pipeline.worker does: an explicit
    path wins, then RACKTRACK_CONFIG, then plain "config.json" relative to
    the process cwd. A deployment that points RACKTRACK_CONFIG at a
    non-default config must get the same model + thresholds here as it does
    on the single-rack path. Falling back to the repo-root copy keeps this
    module usable when it's driven directly (tests, CLI) from elsewhere.
    """
    path = config_path or os.environ.get("RACKTRACK_CONFIG") or "config.json"
    if not os.path.isabs(path) and not os.path.exists(path):
        path = str(_REPO_ROOT / path)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _load_detector(cfg: dict):
    """Load the device detector through pipeline.detection.load_model so we
    share the worker's warm _MODEL_CACHE instead of loading a second copy of
    the checkpoint into the same long-lived process.
    """
    from pipeline.detection import load_model

    # config.json ships "devices_seg" — there has never been a plain "devices"
    # key, so this raised KeyError on every call and the video split silently
    # reported "multi-rack split failed: 'devices'". Accept either spelling.
    model_path = cfg["models"].get("devices") or cfg["models"]["devices_seg"]
    # Keep the config's own spelling of the path when it resolves from the
    # cwd — the cache is keyed on the string, and the worker preloads it in
    # exactly that form, so absolutising it here would miss the warm entry.
    if not os.path.isabs(model_path) and not os.path.exists(model_path):
        model_path = str(_REPO_ROOT / model_path)
    return load_model(model_path)


def _devices_conf(cfg: dict) -> float:
    """Detection threshold, from the same config key the single-rack path
    reads. Previously a module constant that only happened to match.
    """
    return float(cfg.get("detection", {}).get("devices_conf", DEFAULT_DEVICES_CONF))


def _downscale_for_analysis(bgr_frame):
    """Shrink oversized frames before detection/scoring. Returns the frame
    unchanged when it's already narrow enough.
    """
    w = bgr_frame.shape[1]
    if w <= MAX_ANALYSIS_WIDTH:
        return bgr_frame
    scale = MAX_ANALYSIS_WIDTH / float(w)
    return cv2.resize(
        bgr_frame,
        (MAX_ANALYSIS_WIDTH, max(1, int(bgr_frame.shape[0] * scale))),
        interpolation=cv2.INTER_AREA,
    )


def _read_frame_at(cap, index: int):
    """Seek + read one frame. Returns None when the seek/decode fails."""
    cap.set(cv2.CAP_PROP_POS_FRAMES, index)
    ok, frame = cap.read()
    if not ok or frame is None:
        return None
    return frame


def _detect_devices(model, bgr_frame, conf: float):
    """Run device detection on one frame. Returns a list of
    (x_center, width, conf) tuples.
    """
    res = model.predict(bgr_frame, verbose=False, conf=conf)[0]
    if res.boxes is None or len(res.boxes) == 0:
        return []
    xyxy = res.boxes.xyxy.cpu().numpy()
    conf = res.boxes.conf.cpu().numpy()
    out = []
    for (x1, y1, x2, y2), c in zip(xyxy, conf):
        cx = (x1 + x2) / 2.0
        w = max(1.0, x2 - x1)
        out.append((float(cx), float(w), float(c)))
    return out


def _frame_signature(detections, frame_width):
    """Area-weighted mean X-center of all detected device boxes,
    normalized to [0, 1] across the frame width. Frames with no
    detections return None (treated as pan-transition).
    """
    if not detections or frame_width <= 0:
        return None, 0, 0.0
    weights = [d[1] for d in detections]
    xs = [d[0] for d in detections]
    confs = [d[2] for d in detections]
    mean_x = float(np.average(xs, weights=weights))
    return mean_x / frame_width, len(detections), float(np.mean(confs))


def _sharpness(bgr_frame):
    gray = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _visual_fingerprint(bgr_frame, target_w: int = 96):
    """Small HSV color histogram. Robust to minor camera shake within a
    rack but changes a lot when the scene changes (different rack —
    different devices, cabling, room background). Used as a second
    rack-boundary signal alongside the device-X-shift signature, because
    head-on shots of two different racks can produce the same mean-X
    even though the visual content is completely different.
    """
    h, w = bgr_frame.shape[:2]
    if w > target_w:
        scale = target_w / float(w)
        small = cv2.resize(bgr_frame, (target_w, max(1, int(h * scale))))
    else:
        small = bgr_frame
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    return hist


def _visual_distance(hist_a, hist_b) -> float:
    """0.0 = identical scene, ~1.0 = completely different scene."""
    if hist_a is None or hist_b is None:
        return 0.0
    corr = cv2.compareHist(hist_a, hist_b, cv2.HISTCMP_CORREL)
    return max(0.0, 1.0 - float(corr))


def split_video_into_racks(
    video_path: str, output_dir: str | None = None, config_path: str | None = None
) -> list[dict]:
    """Main entry. Returns a list of dicts, one per detected rack:
    {
      "position":       1,                     # 1-based, in pan order
      "label":          "Rack 1",              # auto-generated
      "best_frame_path": ".../rack_1.jpg",
      "frame_index":    143,                   # source frame number
      "device_count":   12,                    # in the best frame
      "score":          0.84,                  # internal ranking score
    }
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return []

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    if total <= 0 or width <= 0:
        cap.release()
        return []

    indices = _sample_timestamps(total, fps, MAX_SAMPLED_FRAMES)
    print(
        f"[multi-rack] sampling {len(indices)} of {total} frames @ fps={fps:.1f}", file=sys.stderr
    )

    # Load detector once (workers reuse it across frames, and load_model
    # reuses the checkpoint the worker already warmed at boot)
    cfg = _load_config(config_path)
    model = _load_detector(cfg)
    conf = _devices_conf(cfg)

    # Sample + detect.
    #
    # We deliberately keep NO frame pixels here — only the scores and the
    # source frame index. Retaining all 30 sampled frames at full resolution
    # was ~750 MB of resident numpy for 4K phone footage (the upload limit
    # admits it), which OOM-killed the singleton worker mid-split and stalled
    # every other CV request until it respawned and reloaded its models. The
    # ~one winning frame per rack is re-read at full resolution below, just
    # before it is written; scoring runs on a downscaled copy because the
    # detector letterboxes to imgsz=640 regardless.
    samples = []
    for idx in indices:
        frame = _read_frame_at(cap, idx)
        if frame is None:
            continue
        small = _downscale_for_analysis(frame)
        frame = None  # release the full-res decode now
        dets = _detect_devices(model, small, conf)
        sig, n_dev, mean_conf = _frame_signature(dets, small.shape[1])
        # Sharpness is scale-dependent, but every sample is downscaled by the
        # same factor (one video = one resolution), so the ranking holds.
        sharp = _sharpness(small) if n_dev > 0 else 0.0
        fp = _visual_fingerprint(small)
        samples.append(
            {
                "index": idx,
                "n_devices": n_dev,
                "sig": sig,  # normalized mean X, or None
                "mean_conf": mean_conf,
                "sharpness": sharp,
                "fp": fp,  # HSV histogram fingerprint
            }
        )

    if not samples:
        cap.release()
        return []

    # ── Segment by signature shifts ──────────────────────────────────
    # Walk samples in order. Start a new segment when ANY of:
    #   * device-X signature jumps by > TRANSITION_X_SHIFT_RATIO   (clear pan)
    #   * scene fingerprint changes by > VISUAL_CHANGE_THRESHOLD   (different rack)
    #   * we cross a stretch of frames with no detections          (pan blur)
    # The visual-fingerprint signal catches the case where the user films
    # two different racks each centered head-on — both have mean-X ≈ 0.5
    # so the X-shift never trips, but the room/device colors are obviously
    # different scenes.
    segments: list[list[dict]] = []
    current: list[dict] = []
    last_sig = None
    last_fp = None
    for s in samples:
        if s["sig"] is None or s["n_devices"] < MIN_DEVICES_FOR_RACK:
            # Likely mid-pan. Close out the current segment.
            if current:
                segments.append(current)
                current = []
            last_sig = None
            last_fp = None
            continue
        big_x_shift = last_sig is not None and abs(s["sig"] - last_sig) > TRANSITION_X_SHIFT_RATIO
        visual_distance = _visual_distance(s["fp"], last_fp)
        big_visual_jump = last_fp is not None and visual_distance > VISUAL_CHANGE_THRESHOLD
        if big_x_shift or big_visual_jump:
            reason = "x-shift" if big_x_shift else f"scene-change(d={visual_distance:.2f})"
            print(f"[multi-rack]   split at sample idx={s['index']} ({reason})", file=sys.stderr)
            if current:
                segments.append(current)
            current = []
        current.append(s)
        last_sig = s["sig"]
        last_fp = s["fp"]
    if current:
        segments.append(current)

    # Drop too-short segments (single-frame flickers from camera shake).
    #
    # This silently discarded real racks. Sampling spreads MAX_SAMPLED_FRAMES
    # across the WHOLE video, so a rack the operator panned past quickly — under
    # roughly MIN_FRAMES_PER_RACK/MAX_SAMPLED_FRAMES of the runtime — can never
    # accumulate enough samples. A three-rack pan that lingers on two came back
    # as `ok: true, count: 2`, with position renumbering removing even the gap
    # that would have hinted something was lost. Still dropped, because a
    # shake flicker really is not a rack, but it is no longer silent.
    kept = [seg for seg in segments if len(seg) >= MIN_FRAMES_PER_RACK]
    dropped = len(segments) - len(kept)
    if dropped:
        print(
            f"[multi-rack] dropped {dropped} segment(s) shorter than "
            f"{MIN_FRAMES_PER_RACK} samples — if a rack is missing from the "
            f"result, it was panned past too quickly to sample",
            file=sys.stderr,
        )
    segments = kept
    if not segments:
        # If aggressive splitting killed everything, treat the whole
        # video as one rack — pick the globally best detected frame.
        viable = [s for s in samples if s["n_devices"] >= MIN_DEVICES_FOR_RACK]
        if not viable:
            cap.release()
            return []
        segments = [viable]

    print(f"[multi-rack] detected {len(segments)} rack segment(s)", file=sys.stderr)

    # ── Pick the best frame per segment + persist ────────────────────
    out_root = (
        Path(output_dir)
        if output_dir
        else (Path(__file__).resolve().parents[1] / "outputs" / "multi" / _video_hash(video_path))
    )
    out_root.mkdir(parents=True, exist_ok=True)

    # Normalize device counts across all samples so segments with very
    # different occupancy don't get unfairly penalized.
    max_dev = max((s["n_devices"] for seg in segments for s in seg), default=1) or 1
    max_sharp = max((s["sharpness"] for seg in segments for s in seg), default=1.0) or 1.0

    def _score(s):
        return (
            0.45 * (s["n_devices"] / max_dev)
            + 0.35 * s["mean_conf"]
            + 0.20 * (s["sharpness"] / max_sharp)
        )

    results: list[dict] = []
    pos = 0
    for seg in segments:
        # Re-read the winner at full resolution. Only one full-res frame is
        # alive at a time. If a seek that worked during sampling somehow
        # fails now, fall through to the next-best frame of the same segment
        # rather than dropping the rack entirely.
        best = None
        full = None
        for cand in sorted(seg, key=_score, reverse=True):
            full = _read_frame_at(cap, cand["index"])
            if full is not None:
                best = cand
                break
            print(
                f"[multi-rack]   re-read failed for frame {cand['index']}, trying next-best",
                file=sys.stderr,
            )
        if best is None:
            continue
        pos += 1
        best_path = out_root / f"rack_{pos}.jpg"
        cv2.imwrite(str(best_path), full, [cv2.IMWRITE_JPEG_QUALITY, 92])
        full = None
        results.append(
            {
                "position": pos,
                "label": f"Rack {pos}",
                "best_frame_path": str(best_path),
                "frame_index": best["index"],
                "device_count": best["n_devices"],
                "mean_conf": round(best["mean_conf"], 3),
                "score": round(_score(best), 3),
            }
        )
    cap.release()
    return results
