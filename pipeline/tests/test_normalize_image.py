"""normalize_image is the gate between an upload and the pipeline. Whatever a
phone or gallery hands us has to come out the other side as an upright RGB
JPEG, or as a clear "no" that never raises."""

import json
import os
import subprocess
import sys

import pytest
from PIL import ExifTags, Image

from pipeline import normalize_image as ni

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

heif_only = pytest.mark.skipif(not ni.HEIF_SUPPORTED, reason="pillow-heif is not installed")


def _picture(size=(64, 48)):
    """A two-tone RGB image: red left half, blue right half, so rotation is visible."""
    im = Image.new("RGB", size, (255, 0, 0))
    half = size[0] // 2
    for x in range(half, size[0]):
        for y in range(size[1]):
            im.putpixel((x, y), (0, 0, 255))
    return im


def _is_jpeg(path):
    with open(path, "rb") as fh:
        return fh.read(2) == b"\xff\xd8"


def _close(px, want, tol=6):
    return all(abs(a - b) <= tol for a, b in zip(px, want))


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "GIF", "WEBP", "BMP", "TIFF"])
def test_common_formats_become_jpeg(tmp_path, fmt):
    src = tmp_path / f"src.{fmt.lower()}"
    _picture().save(src, format=fmt)
    dst = tmp_path / "out.jpg"

    r = ni.normalize(str(src), str(dst))

    assert r["ok"] is True, r
    assert r["format"] == fmt
    assert (r["width"], r["height"]) == (64, 48)
    assert r["transposed"] is False
    assert r["dst"] == str(dst)
    assert _is_jpeg(dst)
    with Image.open(dst) as out:
        assert out.format == "JPEG"
        assert out.mode == "RGB"
        assert out.size == (64, 48)


@heif_only
@pytest.mark.parametrize("fmt", ["HEIF", "AVIF"])
def test_heif_and_avif_become_jpeg(tmp_path, fmt):
    src = tmp_path / f"src.{fmt.lower()}"
    _picture().save(src, format=fmt)
    dst = tmp_path / "out.jpg"

    r = ni.normalize(str(src), str(dst))

    assert r["ok"] is True, r
    assert r["format"] == fmt
    assert (r["width"], r["height"]) == (64, 48)
    assert _is_jpeg(dst)
    with Image.open(dst) as out:
        # Lossy both ways, so only the colours are checked, not exact bytes.
        assert _close(out.getpixel((10, 24)), (255, 0, 0), tol=24)
        assert _close(out.getpixel((54, 24)), (0, 0, 255), tol=24)


def test_opens_by_content_not_by_extension(tmp_path):
    # PNG bytes wearing a .jpg name: the gallery renames things, the bytes do not lie.
    src = tmp_path / "photo.jpg"
    _picture().save(src, format="PNG")
    r = ni.normalize(str(src), str(tmp_path / "out.jpg"))
    assert r["ok"] is True
    assert r["format"] == "PNG"


@heif_only
def test_heic_renamed_jpg_is_still_heic(tmp_path):
    src = tmp_path / "IMG_0001.jpg"
    _picture().save(src, format="HEIF")
    r = ni.normalize(str(src), str(tmp_path / "out.jpg"))
    assert r["ok"] is True
    assert r["format"] == "HEIF"


def test_no_extension_at_all(tmp_path):
    # Android content:// picks arrive as tmp_<uuid> with nothing after it.
    src = tmp_path / "tmp_abc123"
    _picture().save(src, format="WEBP")
    r = ni.normalize(str(src), str(tmp_path / "out.jpg"))
    assert r["ok"] is True
    assert r["format"] == "WEBP"


def test_exif_orientation_6_comes_out_upright(tmp_path):
    # A phone held portrait stores the frame landscape (80x40) and writes
    # orientation 6 ("rotate 90 degrees clockwise to view"). The pipeline reads
    # pixels, not tags, so the pixels themselves must be turned.
    src = tmp_path / "portrait.jpg"
    exif = Image.Exif()
    exif[ExifTags.Base.Orientation] = 6
    _picture((80, 40)).save(src, format="JPEG", quality=95, exif=exif.tobytes())
    dst = tmp_path / "out.jpg"

    r = ni.normalize(str(src), str(dst))

    assert r["ok"] is True
    assert r["transposed"] is True
    assert (r["width"], r["height"]) == (40, 80)
    with Image.open(dst) as out:
        assert out.size == (40, 80)
        # The left (red) half of the stored frame is now the top.
        assert _close(out.getpixel((20, 10)), (255, 0, 0))
        assert _close(out.getpixel((20, 70)), (0, 0, 255))
        # And the tag is gone, so nobody rotates it again.
        assert out.getexif().get(ExifTags.Base.Orientation) in (None, 1)


def test_orientation_1_is_not_reported_as_transposed(tmp_path):
    src = tmp_path / "plain.jpg"
    exif = Image.Exif()
    exif[ExifTags.Base.Orientation] = 1
    _picture().save(src, format="JPEG", exif=exif.tobytes())
    r = ni.normalize(str(src), str(tmp_path / "out.jpg"))
    assert r["ok"] is True
    assert r["transposed"] is False
    assert (r["width"], r["height"]) == (64, 48)


def test_alpha_is_flattened_onto_white(tmp_path):
    # Fully transparent everywhere except an opaque black square. JPEG has no
    # alpha; the transparent area must become white, not the black that sat
    # under it.
    im = Image.new("RGBA", (64, 48), (0, 0, 0, 0))
    for x in range(10, 20):
        for y in range(10, 20):
            im.putpixel((x, y), (0, 0, 0, 255))
    src = tmp_path / "shot.png"
    im.save(src, format="PNG")
    dst = tmp_path / "out.jpg"

    r = ni.normalize(str(src), str(dst))

    assert r["ok"] is True
    with Image.open(dst) as out:
        assert out.mode == "RGB"
        assert _close(out.getpixel((50, 40)), (255, 255, 255))
        assert _close(out.getpixel((15, 15)), (0, 0, 0), tol=12)


def test_palette_gif_with_transparency_is_flattened(tmp_path):
    im = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    src = tmp_path / "t.gif"
    im.save(src, format="GIF")  # Pillow writes a palette image with a transparency index
    dst = tmp_path / "out.jpg"
    r = ni.normalize(str(src), str(dst))
    assert r["ok"] is True
    with Image.open(dst) as out:
        assert _close(out.getpixel((16, 16)), (255, 255, 255))


def test_greyscale_and_16_bit_sources_still_come_out_rgb(tmp_path):
    for mode in ("L", "I;16", "1"):
        src = tmp_path / f"m_{mode.replace(';', '')}.png"
        Image.new(mode, (16, 16)).save(src, format="PNG")
        dst = tmp_path / f"out_{mode.replace(';', '')}.jpg"
        r = ni.normalize(str(src), str(dst))
        assert r["ok"] is True, (mode, r)
        with Image.open(dst) as out:
            assert out.mode == "RGB"


def test_not_an_image_returns_error_not_exception(tmp_path):
    src = tmp_path / "notes.txt"
    src.write_text("this is not a picture\n")
    dst = tmp_path / "out.jpg"

    r = ni.normalize(str(src), str(dst))

    assert r["ok"] is False
    assert isinstance(r["error"], str) and r["error"]
    assert not dst.exists()


def test_truncated_jpeg_returns_error_not_exception(tmp_path):
    good = tmp_path / "good.jpg"
    _picture((200, 200)).save(good, format="JPEG")
    data = good.read_bytes()
    src = tmp_path / "cut.jpg"
    src.write_bytes(data[: len(data) // 3])
    r = ni.normalize(str(src), str(tmp_path / "out.jpg"))
    assert r["ok"] is False
    assert r["error"]


def test_missing_file_returns_error(tmp_path):
    r = ni.normalize(str(tmp_path / "nope.jpg"), str(tmp_path / "out.jpg"))
    assert r["ok"] is False
    assert "nope.jpg" in r["error"]


def test_cli_prints_json_and_exit_code(tmp_path):
    src = tmp_path / "src.webp"
    _picture().save(src, format="WEBP")
    dst = tmp_path / "out.jpg"

    good = subprocess.run(
        [sys.executable, "-m", "pipeline.normalize_image", str(src), str(dst)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert good.returncode == 0, good.stderr
    payload = json.loads(good.stdout.strip().splitlines()[-1])
    assert payload["ok"] is True
    assert payload["format"] == "WEBP"
    assert _is_jpeg(dst)

    bad_src = tmp_path / "bad.bin"
    bad_src.write_bytes(b"\x00\x01\x02 not a picture")
    bad = subprocess.run(
        [sys.executable, "-m", "pipeline.normalize_image", str(bad_src), str(tmp_path / "bad.jpg")],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert bad.returncode == 1
    assert json.loads(bad.stdout.strip().splitlines()[-1])["ok"] is False

    usage = subprocess.run(
        [sys.executable, "-m", "pipeline.normalize_image"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert usage.returncode == 2
    assert json.loads(usage.stdout.strip())["ok"] is False
