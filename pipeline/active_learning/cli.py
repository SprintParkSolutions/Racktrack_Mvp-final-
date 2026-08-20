"""Subprocess CLI for active-learning operations.

Reads a JSON request from stdin, writes a JSON response to stdout. Designed
to be called from the Node server with one invocation per feedback event.

Why short-lived (not a long-running worker):
    Feedback events are infrequent (one per user correction). Loading
    ResNet18 takes ~3s; that's acceptable per call and avoids managing yet
    another long-running process.

Request shapes (one JSON object per line on stdin):

  {"cmd": "stats"}

  {"cmd": "find_match",
   "model": "cable" | "devices" | "ports",
   "image_path": "..."}

  {"cmd": "add_correction",
   "model": "cable" | "devices",
   "image_path": "...",
   "pred_label": "...",
   "final_label": "...",
   "source_name": "..."}

  {"cmd": "save_verified_ports",
   "image_path": "...",
   "image_name": "...",
   "ports": [{"port_number": 1, "x": 100, "y": 200}, ...],
   "img_w": 1920, "img_h": 1080}

  {"cmd": "find_verified_ports",
   "image_path": "..."}

  {"cmd": "apply_to_scan",
   "rack_dir": "/abs/path/outputs/RK-XXXXXXXX"}
    Iterates each detected device in device_unit_map.json, crops the
    device region from original_image.jpg, looks up a matching
    correction in the AL devices store, and rewrites class_name if a
    match is found. Returns the list of changes applied. This is the
    auto-apply step that lets a re-uploaded image of the same rack
    (different SHA256 = different rackId) automatically pick up the
    user's prior corrections.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

from . import store


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _handle(req: dict) -> dict:
    # Active learning is organization-scoped: an optional org_id on the
    # request routes all store reads/writes to that org's partition, so
    # corrections are shared across an org's Sites but isolated between orgs.
    store.set_org(req.get("org_id"))
    cmd = req.get("cmd")

    if cmd == "stats":
        return {"ok": True, "stats": store.stats()}

    if cmd == "find_match":
        model = req["model"]
        image_path = req["image_path"]
        match = store.find_match(model, image_path)
        return {"ok": True, "match": match}

    if cmd == "add_correction":
        model = req["model"]
        rec = store.add_correction(
            model=model,
            image_path=req["image_path"],
            pred_label=req.get("pred_label", ""),
            final_label=req["final_label"],
            source_name=req.get("source_name"),
            extra=req.get("extra"),
        )
        # Don't echo the 512-d embedding back over stdout — large + uninteresting.
        rec_lite = {k: v for k, v in rec.items() if k != "embedding"}
        return {"ok": True, "record": rec_lite}

    if cmd == "save_verified_ports":
        res = store.add_verified_port_layout(
            image_path=req["image_path"],
            image_name=req["image_name"],
            ports=req["ports"],
            img_w=req["img_w"],
            img_h=req["img_h"],
        )
        return {"ok": True, "saved": res}

    if cmd == "find_verified_ports":
        rec = store.find_verified_port_layout(req["image_path"])
        if rec is not None:
            # Drop embedding from response — large and unused on the JS side.
            rec = {k: v for k, v in rec.items() if k != "embedding"}
        return {"ok": True, "verified": rec}

    if cmd == "add_confirmed_rack":
        res = store.add_confirmed_rack(
            image_path=req["image_path"],
            rack_id=req["rack_id"],
            image_name=req.get("image_name"),
        )
        return {"ok": True, "confirmed": res}

    if cmd == "find_confirmed_rack":
        rec = store.find_confirmed_rack(req["image_path"])
        return {"ok": True, "confirmed": rec}

    if cmd == "apply_to_scan":
        return _apply_to_scan(req["rack_dir"])

    return {"ok": False, "error": f"unknown cmd: {cmd!r}"}


def _apply_to_scan(rack_dir: str) -> dict:
    """Walk a finished scan's outputs/, look up AL corrections per device,
    and rewrite device_unit_map.json with any matched class_names.

    Skipped silently if device_unit_map.json or original_image.jpg are
    missing. Always returns ok:true with a list of changes (possibly empty).
    """
    from PIL import Image

    rd = Path(rack_dir)
    map_path = rd / "device_unit_map.json"
    img_path = rd / "original_image.jpg"
    if not map_path.exists() or not img_path.exists():
        return {"ok": True, "skipped": True, "reason": "missing inputs", "changes": []}

    try:
        data = json.loads(map_path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": f"map parse: {e}"}

    devices = data.get("devices") or []
    if not devices:
        return {"ok": True, "changes": []}

    pil = Image.open(str(img_path)).convert("RGB")
    img_w, img_h = pil.size
    changes = []
    tmp_dir = rd / ".al_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    for idx, dev in enumerate(devices):
        box = dev.get("box")
        if not box or len(box) != 4:
            continue
        x1, y1, x2, y2 = box
        # Pad by 4% of device size for context
        bw = max(1, x2 - x1)
        bh = max(1, y2 - y1)
        pad_x = int(bw * 0.04)
        pad_y = int(bh * 0.04)
        cx1 = max(0, int(x1) - pad_x)
        cy1 = max(0, int(y1) - pad_y)
        cx2 = min(img_w, int(x2) + pad_x)
        cy2 = min(img_h, int(y2) + pad_y)
        if cx2 <= cx1 or cy2 <= cy1:
            continue
        crop = pil.crop((cx1, cy1, cx2, cy2))
        crop_path = tmp_dir / f"dev_{idx}.jpg"
        try:
            crop.save(str(crop_path), quality=85)
        except Exception:
            continue

        match = store.find_match("devices", str(crop_path))
        if match and match.get("label"):
            old = dev.get("class_name") or ""
            new = match["label"]
            if new != old:
                dev["_al_correction"] = {
                    "applied_at_load": True,
                    "source": "active_learning_memory",
                    "fields": ["class_name"],
                    "original": {"class_name": old},
                    "phash": match.get("phash"),
                }
                dev["class_name"] = new
                changes.append(
                    {
                        "device_index": idx + 1,
                        "from": old,
                        "to": new,
                        "phash": match.get("phash"),
                    }
                )

    if changes:
        try:
            map_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            return {"ok": False, "error": f"map write: {e}"}

    # Clean tmp crops
    try:
        for f in tmp_dir.iterdir():
            try:
                f.unlink()
            except OSError:
                pass
        tmp_dir.rmdir()
    except OSError:
        pass

    return {"ok": True, "changes": changes, "applied": len(changes)}


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw:
        _emit({"ok": False, "error": "empty stdin"})
        return 2
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        _emit({"ok": False, "error": f"json parse: {e}"})
        return 2
    try:
        resp = _handle(req)
        _emit(resp)
        return 0 if resp.get("ok") else 1
    except Exception as e:
        _emit({"ok": False, "error": str(e), "trace": traceback.format_exc()})
        return 1


if __name__ == "__main__":
    sys.exit(main())
