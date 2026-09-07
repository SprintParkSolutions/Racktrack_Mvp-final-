"""Turn any image a phone or gallery can hand us into a JPEG the pipeline reads.

The CV pipeline decodes with OpenCV (``cv2.imread``) and Pillow. Neither reads
HEIC/HEIF or AVIF on its own, and only OpenCV honours the EXIF orientation tag,
so a photo that looks fine on the phone can arrive sideways or fail to open at
all. This module is the one place that difference is absorbed:

* the file is opened by CONTENT, never by extension. An Android gallery pick
  often has no extension, and a HEIC renamed ``.jpg`` is still a HEIC;
* the EXIF orientation is applied and then dropped, so the pixels are upright
  and no later reader can rotate them a second time;
* alpha is flattened onto white and the image is converted to RGB;
* the result is written as a baseline JPEG (quality 92, optimised).

A JPEG that is already upright is re-encoded too rather than copied through.
That costs a few tens of milliseconds and keeps one code path; the server only
calls this for formats it could not hand straight to the pipeline anyway.

HEIC/HEIF and AVIF decoding comes from the optional ``pillow-heif`` package.
Without it those two formats fail with a message that says so, and every other
format still works.

Usage::

    python -m pipeline.normalize_image SRC DST

prints one JSON object on stdout and exits 0 when the conversion succeeded, 1
when it did not. ``normalize()`` never raises on bad input; it reports through
the returned dict.
"""

from __future__ import annotations

import json
import sys

from PIL import ExifTags, Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_SUPPORTED = True
except ImportError:  # pragma: no cover - depends on what is installed
    pillow_heif = None
    HEIF_SUPPORTED = False

JPEG_QUALITY = 92
_ORIENTATION = ExifTags.Base.Orientation
_HEIF_HINT = "HEIC/HEIF and AVIF need the pillow-heif package (pip install pillow-heif)."


def _looks_like_heif(path: str) -> bool:
    """Return True when the file starts with an ISO BMFF ``ftyp`` box.

    That is the container HEIF and AVIF share (and MP4, but a video never
    reaches this module). Used only to make the "pillow-heif is missing"
    failure say what is actually wrong.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(12)
    except OSError:
        return False
    return len(head) >= 12 and head[4:8] == b"ftyp"


def _flatten_to_rgb(im: Image.Image) -> Image.Image:
    """Return ``im`` as an RGB image, compositing any alpha channel onto white.

    JPEG has no alpha. Dropping the channel would leave the RGB values that
    sat under transparent pixels, which is usually black, so a transparent
    PNG screenshot would come out with a black surround. White is what the
    viewer showed.
    """
    if im.mode == "RGB":
        return im
    has_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
    if has_alpha:
        rgba = im.convert("RGBA")
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.getchannel("A"))
        return flat
    try:
        return im.convert("RGB")
    except (ValueError, OSError):
        # Exotic modes without a direct RGB path go through greyscale.
        return im.convert("L").convert("RGB")


def normalize(src: str, dst: str) -> dict:
    """Read ``src`` in any format Pillow can decode and write an upright RGB JPEG to ``dst``.

    Returns a dict and never raises:

    ``ok``
        True when ``dst`` was written.
    ``format``
        The source format Pillow saw ("JPEG", "HEIF", "PNG", "WEBP", ...).
    ``width``, ``height``
        Output size in pixels, after EXIF transposition. A portrait phone
        photo stored landscape with orientation 6 comes out with these swapped
        relative to the stored frame.
    ``transposed``
        True when an EXIF orientation other than 1 was applied.
    ``dst``
        The path written.
    ``error``
        Present only when ``ok`` is False: one plain sentence.
    """
    try:
        with Image.open(src) as opened:
            fmt = opened.format
            orientation = int(opened.getexif().get(_ORIENTATION, 1) or 1)
            upright = ImageOps.exif_transpose(opened)
        rgb = _flatten_to_rgb(upright)
        rgb.save(dst, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        width, height = rgb.size
    except FileNotFoundError:
        return {"ok": False, "error": f"No such file: {src}"}
    except Image.UnidentifiedImageError:
        if not HEIF_SUPPORTED and _looks_like_heif(src):
            return {"ok": False, "error": _HEIF_HINT}
        return {"ok": False, "error": "Not an image Pillow can read."}
    except Exception as exc:  # a truncated file, a decompression bomb, a write failure
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return {
        "ok": True,
        "format": fmt,
        "width": width,
        "height": height,
        "transposed": orientation != 1,
        "dst": dst,
    }


def main(argv: list[str] | None = None) -> int:
    """CLI entry: ``python -m pipeline.normalize_image SRC DST``. Prints JSON, returns the exit code."""
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print(
            json.dumps({"ok": False, "error": "usage: python -m pipeline.normalize_image SRC DST"})
        )
        return 2
    result = normalize(args[0], args[1])
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
