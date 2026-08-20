"""
ocr_closeup.py — identify one device from a close-up photo of its label.

Rack-photo OCR (ocr_devices.py) fails on a device when that device's slice of
the frame carries too few pixels for the model string to survive. The
preprocessing chain compensates by upscaling, but upscaling only interpolates
detail the camera never captured — which is why "Vendor not detected" on a
rack photo is usually a resolution problem, not a legibility one.

This module reads a photo of a SINGLE device: one the tech walked up to and
framed on the model label, where those pixels are real. Same engine, same
identifier, same vendor/model parser as ocr_devices.py — the only structural
difference is that the whole frame belongs to one device, so every text
detection is its own and there is no box to assign labels to.

The result is a SUGGESTION. It is handed to the user to confirm or correct in
the manual-entry editor, never written straight to CMDB: a close-up read is
much better than a rack-crop read, but "much better" is not "trusted".

Usage:
    python -m pipeline.ocr_closeup <image_path>
    python -m pipeline.ocr_closeup <image_path> --fast
    python -m pipeline.ocr_closeup <image_path> --accurate

Output (stdout, one JSON line):
{
  "ok":         true,
  "make":       "MikroTik" | null,
  "model":      "CRS328-24P-4S+RM" | null,
  "version":    "6.48.6" | null,
  "raw_text":   "MikroTik RouterBOARD CRS328-24P-4S+RM ...",
  "ocr_conf":   0.91,       # mean OCR confidence over the frame
  "match_conf": 0.94,       # identifier confidence in (make, model)
  "detections": 14,
  "source":     "closeup_full" | "closeup_make_only" | "closeup_failed",
  "alternates": [ { "make": "Netgear", "model": "GS1100", "conf": 0.55 } ]
}

Never exits non-zero on a failed READ — an unreadable photo is an ordinary
outcome the UI handles by falling back to manual entry, not an error. Only a
crash (missing file, engine failure) sets ok=false.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# Reuse the rack-scan parser wholesale. Two code paths deriving make/model
# from OCR text is how they drift: a vendor added to MODEL_PATTERNS for the
# rack path would silently not exist for close-ups.
from pipeline.ocr_devices import (  # noqa: E402
    _read_whole_image,
    load_vendor_names,
    parse_make_model,
    parse_version,
)


def closeup_config(escalate: bool = False):
    """OCR preset for a single-device close-up.

    ``accurate()`` is tuned for the opposite problem — a rack photo where the
    model string may be 20px tall — so it buys server models, a 2600px
    upscale target, every variant and every retry, and costs ~24s a call. On
    a close-up the text is already large, so most of that budget buys
    nothing, and a read the user waits 24s for is one they would rather have
    typed. ``fast()`` is the other extreme: one variant, no retries at all.

    Neither fits, so this is two configs used in sequence (see ``run``):

    ``escalate=False`` — baseline only. On a close-up that came out well this
    lands the answer in ~1-5s, because the retry stages are what dominate the
    clock, not the recognizer.

    ``escalate=True`` — the same baseline plus the retries that target how a
    close-up actually goes wrong: shot at an angle from below (deskew,
    perspective), phone torch bouncing off a metal faceplate (deglare), and
    an orientation the EXIF tag doesn't describe. Dropped as not worth their
    cost here: the multi-engine ensemble, the brute-force rotate sweep that
    deskew supersedes, and the colour-channel retry. ``time_budget`` caps the
    escalation so a hopeless photo fails fast instead of stalling the request.
    """
    from switch_ocr import OCRConfig

    cfg = dict(
        variants=["enhanced", "upscaled"],
        det_limit_side_len=2000,
        ensemble_engines=False,
        rotate_retry=False,
        channel_retry=False,
    )
    if not escalate:
        return OCRConfig(
            **cfg,
            orientation_retry=False,
            deskew_retry=False,
            perspective_retry=False,
            deglare_retry=False,
            zoom_retry=False,
        )
    return OCRConfig(**cfg, time_budget=10.0)


_READERS: dict[str, object] = {}


def get_reader(preset: str = "closeup"):
    """Reader for a preset, built once per process.

    PaddleOCR loads its weights lazily on the first read (~3s), so holding
    the reader is what makes the second close-up in a warm worker noticeably
    faster than the first. In the one-shot CLI path the cache is a no-op.
    """
    if preset not in _READERS:
        from switch_ocr import OCRConfig, SwitchTextReader

        cfg = (
            OCRConfig.fast()
            if preset == "fast"
            else OCRConfig.accurate()
            if preset == "accurate"
            else closeup_config(escalate=(preset == "closeup_escalated"))
        )
        print(f"[ocr_closeup] engine: switch-ocr ({preset})", file=sys.stderr)
        _READERS[preset] = SwitchTextReader(cfg)
    return _READERS[preset]


def _identify(labels: list[dict]) -> tuple[str | None, str | None, float, list[dict]]:
    """(make, model, confidence, alternates) from switch-ocr's identifier.

    Same call ocr_devices._identify_switch makes, but keeping the confidence
    and the runner-up readings instead of discarding them: on a close-up the
    user is standing in front of the device and can settle a close call
    between two candidates instantly, which is worth surfacing.
    """
    try:
        from switch_ocr import identify_device
    except Exception:
        return None, None, 0.0, []
    dets = [l["_det"] for l in labels if l.get("_det") is not None]
    if not dets:
        return None, None, 0.0, []
    try:
        dev = identify_device(dets)
    except Exception:
        return None, None, 0.0, []

    make = dev.brand or None
    model = dev.model or None
    # A model must look like one. Without this the universal fallback can
    # promote any prominent faceplate word ("GIGABIT", "CONSOLE") to a model.
    if model and not any(c.isdigit() for c in model):
        model = None

    alternates = []
    for alt in (dev.alternates or [])[:3]:
        a_make = alt.get("brand") or None
        a_model = alt.get("model") or None
        if a_model and not any(c.isdigit() for c in a_model):
            a_model = None
        if not (a_make or a_model):
            continue
        if (a_make, a_model) == (make, model):
            continue
        alternates.append(
            {
                "make": a_make,
                "model": a_model,
                "conf": round(float(alt.get("confidence") or 0.0), 3),
            }
        )

    return make, model, float(dev.confidence or 0.0), alternates


def _read_and_identify(img, preset: str) -> dict:
    """One OCR pass over the frame, parsed into a make/model answer."""
    labels = _read_whole_image(get_reader(preset), img)
    # The frame IS the device, so reading order is only cosmetic — except that
    # the concatenated text feeds the regex parser below, and a model number
    # split across two detections only rejoins correctly in reading order.
    labels.sort(key=lambda l: (round(l["cy"] / 12.0), l["cx"]))
    text = " ".join(l["text"] for l in labels)
    ocr_conf = round(sum(l["conf"] for l in labels) / len(labels), 3) if labels else 0.0

    make, model, ident_conf, alternates = _identify(labels)
    if not (make and model):
        m2, mo2 = parse_make_model(text, load_vendor_names())
        make = make or m2
        model = model or mo2

    if make and model:
        source = "closeup_full"
        # The identifier's own confidence when it produced the answer; the
        # regex fallback has no confidence of its own, so stand in the OCR
        # confidence shaped the same way ocr_devices.py shapes it.
        match_conf = round(min(1.0, ident_conf or (0.6 + 0.4 * ocr_conf)), 3)
    elif make:
        source = "closeup_make_only"
        match_conf = round(min(1.0, ident_conf or (0.4 + 0.4 * ocr_conf)), 3)
    else:
        source = "closeup_failed"
        match_conf = 0.0

    return {
        "ok": True,
        "make": make,
        "model": model,
        "version": parse_version(text),
        "raw_text": text,
        "ocr_conf": ocr_conf,
        "match_conf": match_conf,
        "detections": len(labels),
        "source": source,
        "alternates": alternates,
    }


def run(image_path: str, preset: str = "closeup") -> dict:
    import cv2

    img = cv2.imread(str(image_path))
    if img is None:
        return {
            "ok": False,
            "error": f"could not read image: {image_path}",
            "source": "closeup_failed",
        }

    # Explicit presets are honoured as-is; only the default is two-stage.
    if preset != "closeup":
        return _read_and_identify(img, preset)

    # Baseline first. The retry stages — deskew, perspective, deglare, zoom —
    # are what dominate the clock (measured: ~1-5s baseline vs ~8-13s with
    # everything on), and a close-up the tech framed well doesn't need any of
    # them. Paying for them up front would tax every good photo to rescue the
    # bad ones.
    result = _read_and_identify(img, "closeup")
    if result["make"] and result["model"]:
        return result

    # Short of a full answer, spend the retries: this is the photo that was
    # shot at an angle, or into a torch reflection, or sideways. Worst case
    # the user waits for both passes — still bounded, and still the outcome
    # they were heading for anyway (manual entry) if we stopped here.
    escalated = _read_and_identify(img, "closeup_escalated")
    if escalated["make"] and escalated["model"]:
        return escalated

    # Neither pass was complete: keep whichever got further, preferring the
    # escalated pass on a tie since it saw strictly more of the image.
    def rank(r):
        return (bool(r["make"]) + bool(r["model"]), r["match_conf"])

    return escalated if rank(escalated) >= rank(result) else result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image_path")
    group = ap.add_mutually_exclusive_group()
    group.add_argument(
        "--fast", action="store_true", help="Single-pass preset — fastest, lowest recall."
    )
    group.add_argument(
        "--accurate", action="store_true", help="Rack-photo preset — slowest, highest recall."
    )
    args = ap.parse_args()

    preset = "fast" if args.fast else "accurate" if args.accurate else "closeup"
    try:
        result = run(args.image_path, preset=preset)
    except Exception as e:
        result = {"ok": False, "error": f"unexpected: {e}", "source": "closeup_failed"}

    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
    # A photo we couldn't read is a normal outcome (the UI falls back to
    # manual entry), so only a genuine failure is a non-zero exit.
    sys.exit(0 if result.get("ok") else 2)


if __name__ == "__main__":
    main()
