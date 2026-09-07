"""
OCR-only label extraction for rack images.

Runs EasyOCR on a single image and prints a JSON document to stdout.
No segmentation, no grouping, no HTML — just text + bbox + confidence.

Usage:
    python pipeline/ocr_labels.py <image_path>
    python pipeline/ocr_labels.py <image_path> --min-conf 0.5

Output (stdout, single line of JSON):
    {
      "image_size": { "w": 1920, "h": 1080 },
      "labels": [
        {
          "text":  "SW-U10",
          "conf":  0.92,
          "bbox":  { "x": 412, "y": 580, "w": 96, "h": 22, "yPct": 53.7 }
        },
        ...
      ]
    }
"""

import argparse
import json
import re
import sys

# The unit segment of a rack label — "SW-U10", "SP-RI-U15-SW04" — is two
# digits after a U, and EasyOCR reads those digits as the letters that look
# like them: 1 as I or l, 5 as S, 0 as O, 8 as B, 2 as Z, 6 as G. One label in
# the office rack came back "SP-RI-UIS-SW04" for U15. The fix is applied only
# where the token can be nothing but a unit: a U with exactly two such
# characters after it, hyphenated on at least one side (or already holding a
# digit), so "USB" and "UPS" are left alone.
_CONFUSABLE = str.maketrans(
    {"I": "1", "l": "1", "|": "1", "S": "5", "O": "0", "Q": "0", "B": "8", "Z": "2", "G": "6"}
)
_UNIT_SEG = re.compile(r"(?P<pre>^|-)U(?P<seg>[0-9IlSOQBZG|]{2})(?=$|-)")


def fix_unit_confusables(text: str) -> str:
    """Repair a unit segment: "SP-RI-UIS-SW04" -> "SP-RI-U15-SW04"; "USB" stays as read."""

    def _sub(m: re.Match) -> str:
        seg = m.group("seg")
        hyphen_after = text[m.end() : m.end() + 1] == "-"
        if m.group("pre") == "" and not hyphen_after and not any(ch.isdigit() for ch in seg):
            return m.group(0)
        return f"{m.group('pre')}U{seg.translate(_CONFUSABLE)}"

    return _UNIT_SEG.sub(_sub, text)


# Built on first use and kept. Constructing an easyocr.Reader loads two neural
# networks off disk — several seconds — and the old code did it on every call,
# which in a spawned-per-request script meant every photograph paid for it. In
# the warm worker the first label pays and the rest do not.
_READER = None


def _reader():
    global _READER
    if _READER is None:
        import easyocr

        _READER = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _READER


def extract_labels(image_path: str, min_conf: float = 0.25) -> dict:
    import cv2

    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")
    h_img, w_img = img.shape[:2]

    results = _reader().readtext(image_path, detail=1, paragraph=False)

    labels = []
    for pts, text, conf in results:
        raw = (text or "").strip()
        if len(raw) < 2 or float(conf) < min_conf:
            continue
        text = fix_unit_confusables(raw)
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x1 = max(0, int(min(xs)))
        y1 = max(0, int(min(ys)))
        x2 = min(w_img, int(max(xs)))
        y2 = min(h_img, int(max(ys)))
        if x2 - x1 < 5 or y2 - y1 < 5:
            continue
        labels.append(
            {
                "text": text,
                **({"raw": raw} if raw != text else {}),
                "conf": round(float(conf), 3),
                "bbox": {
                    "x": x1,
                    "y": y1,
                    "w": x2 - x1,
                    "h": y2 - y1,
                    "yPct": round(y1 / h_img * 100, 2),
                    "xPct": round(x1 / w_img * 100, 2),
                },
            }
        )

    return {
        "image_size": {"w": w_img, "h": h_img},
        "labels": labels,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image_path")
    ap.add_argument(
        "--min-conf",
        type=float,
        default=0.25,
        help="Drop OCR detections below this confidence (default: 0.25)",
    )
    args = ap.parse_args()

    try:
        result = extract_labels(args.image_path, min_conf=args.min_conf)
    except Exception as e:
        # Always emit JSON so the Node side can parse cleanly.
        sys.stdout.write(json.dumps({"error": str(e), "labels": []}))
        sys.stdout.flush()
        sys.exit(1)

    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
