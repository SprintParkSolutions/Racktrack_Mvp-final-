"""Image fingerprint + nearest-correction lookup.

Two-tier matching identical to Active Learning CDP/*.py:
  1. Perceptual hash (Hamming distance <= HAMMING_TOL) — fast/exact path
  2. ResNet18 deep-feature cosine similarity (>= SIM_THRESH) — robust path

The ResNet18 embedder is lazy-loaded so importing this module is cheap; the
~3s model load only happens on the first embed() call.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

HASH_SIZE = 16
HAMMING_TOL = 6
SIM_THRESH = 0.88

_emb_model = None
_emb_tf = None
_device = None


def _load_embedder():
    global _emb_model, _emb_tf, _device
    if _emb_model is not None:
        return
    import torch
    import torchvision
    from torchvision import transforms

    _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    m = torchvision.models.resnet18(weights=torchvision.models.ResNet18_Weights.DEFAULT)
    m.fc = torch.nn.Identity()
    m.eval().to(_device)
    _emb_model = m
    _emb_tf = transforms.Compose(
        [
            transforms.Resize((224, 224)),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ]
    )


def _to_pil(img) -> Image.Image:
    if isinstance(img, Image.Image):
        return img.convert("RGB")
    if isinstance(img, (str, Path)):
        return Image.open(str(img)).convert("RGB")
    # numpy array (BGR from cv2)
    import numpy as _np

    arr = _np.asarray(img)
    if arr.ndim == 3 and arr.shape[2] == 3:
        # heuristic: assume BGR; convert
        arr = arr[:, :, ::-1]
    return Image.fromarray(arr).convert("RGB")


def phash(img, size: int = HASH_SIZE) -> str:
    """Perceptual hash from any image-like input."""
    pil = _to_pil(img)
    g = pil.convert("L").resize((size, size), Image.BILINEAR)
    arr = np.asarray(g, dtype=np.float32)
    bits = (arr > arr.mean()).flatten()
    return "".join("1" if b else "0" for b in bits)


def hamming(a: str, b: str) -> int:
    if len(a) != len(b):
        return 10**9
    return sum(c1 != c2 for c1, c2 in zip(a, b))


def embed(img) -> list:
    """Return L2-normalized 512-d ResNet18 feature vector as a plain list."""
    _load_embedder()
    import torch

    pil = _to_pil(img)
    with torch.no_grad():
        x = _emb_tf(pil).unsqueeze(0).to(_device)
        v = _emb_model(x).squeeze(0).cpu().numpy()
    v = v / (np.linalg.norm(v) + 1e-9)
    return v.astype(np.float32).tolist()


def cos_sim(a, b) -> float:
    return float(np.dot(np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)))


def nearest_correction(h: str, emb: list, corrections: dict) -> dict | None:
    """Return the best-matching correction record, or None.

    Fast path: pHash Hamming <= HAMMING_TOL.
    Robust path: ResNet18 cosine >= SIM_THRESH.
    """
    if not corrections:
        return None
    best, best_d = None, HAMMING_TOL + 1
    for stored_h, rec in corrections.items():
        d = hamming(h, stored_h)
        if d < best_d:
            best, best_d = rec, d
    if best is not None:
        return best
    best, best_s = None, SIM_THRESH
    for rec in corrections.values():
        v = rec.get("embedding")
        if not v:
            continue
        s = cos_sim(emb, v)
        if s > best_s:
            best, best_s = rec, s
    return best
