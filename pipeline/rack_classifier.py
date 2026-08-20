"""
Rack Occlusion Classifier — single-file version.

Classifies a rack photo as "clear" or "occluded" (view blocked by cables/clutter).

Usage:
    python rack_classifier.py path\\to\\image.jpg [more images...]   -> prints result(s) in the console
    python rack_classifier.py --serve                                -> launches the web UI at http://127.0.0.1:5000

Integration (import into another codebase):
    from rack_classifier import load_model, predict_image
    from PIL import Image

    model, classes = load_model()                       # load once at startup
    img = Image.open("scan.jpg").convert("RGB")
    label, confidence, probs = predict_image(img, model, classes)
    if label == "occluded":
        ...  # flag for re-capture
"""

import argparse
import io
import pathlib
import sys

import torch
from PIL import Image
from torch import nn
from torchvision import models, transforms

# --------------------------------------------------------------------------
# CONFIG — adjust these if paths/classes change
# --------------------------------------------------------------------------
MODEL_PATH = pathlib.Path(__file__).parent / "rack_classifier.pth"
CLASSES = ["clear", "occluded"]
IMG_SIZE = 224
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]
SERVE_PORT = 5000
# --------------------------------------------------------------------------


def _transform():
    return transforms.Compose(
        [
            transforms.Resize((IMG_SIZE, IMG_SIZE)),
            transforms.ToTensor(),
            transforms.Normalize(mean=MEAN, std=STD),
        ]
    )


def _build_architecture(num_classes):
    model = models.mobilenet_v2(weights=None)
    in_features = model.classifier[1].in_features
    model.classifier[1] = nn.Linear(in_features, num_classes)
    return model


def load_model(weights_path=MODEL_PATH):
    """Load the trained model once; reuse the returned (model, classes) for every prediction."""
    weights_path = pathlib.Path(weights_path)
    if not weights_path.exists():
        raise FileNotFoundError(
            f"Model weights not found at {weights_path}. Train first or check MODEL_PATH."
        )
    ckpt = torch.load(weights_path, map_location="cpu")
    classes = ckpt["classes"]
    model = _build_architecture(len(classes))
    model.load_state_dict(ckpt["model_state"])
    model.eval()
    return model, classes


def predict_image(img, model, classes):
    """Run inference on an already-opened PIL Image (RGB). Returns (label, confidence, probs_dict)."""
    x = _transform()(img).unsqueeze(0)
    with torch.no_grad():
        probs = torch.softmax(model(x), dim=1)[0]
    idx = int(probs.argmax())
    return classes[idx], probs[idx].item(), {c: probs[i].item() for i, c in enumerate(classes)}


def predict_path(image_path, model, classes):
    img = Image.open(image_path).convert("RGB")
    return predict_image(img, model, classes)


# --------------------------------------------------------------------------
# Web UI (Flask) — only imported/used when running with --serve
# --------------------------------------------------------------------------
INDEX_HTML = """
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rack Occlusion Classifier</title>
<style>
  :root {
    --bg: #f4f6fb; --panel: #ffffff; --border: #e3e7f0; --text: #1c2333; --muted: #6b7385;
    --accent: #4f6df5; --accent-2: #7c5cff;
    --clear: #1fa26e; --clear-bg: #e7f8f1;
    --occluded: #d9502b; --occluded-bg: #fdece5;
    --shadow: 0 10px 30px rgba(30, 41, 80, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1220; --panel: #171b2e; --border: #262c45; --text: #eef0f8; --muted: #99a0b8;
      --clear-bg: #103427; --occluded-bg: #3a1f18; --shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: radial-gradient(1200px 600px at 10% -10%, rgba(124, 92, 255, 0.12), transparent),
                radial-gradient(1000px 500px at 110% 10%, rgba(79, 109, 245, 0.10), transparent), var(--bg);
    color: var(--text); min-height: 100%; display: flex; justify-content: center; padding: 48px 20px 80px;
  }
  .wrap { width: 100%; max-width: 760px; }
  header { text-align: center; margin-bottom: 36px; }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600;
    letter-spacing: 0.04em; color: var(--accent); text-transform: uppercase;
    background: rgba(79, 109, 245, 0.1); padding: 6px 14px; border-radius: 999px; margin-bottom: 16px;
  }
  h1 { font-size: 30px; margin: 0 0 10px; letter-spacing: -0.02em; }
  header p { color: var(--muted); margin: 0; font-size: 15px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 20px;
    box-shadow: var(--shadow); padding: 28px; margin-bottom: 24px;
  }
  #dropzone {
    border: 2px dashed var(--border); border-radius: 16px; padding: 40px 24px; text-align: center;
    cursor: pointer; transition: border-color .15s ease, background .15s ease; position: relative;
  }
  #dropzone.drag { border-color: var(--accent); background: rgba(79,109,245,0.06); }
  #dropzone svg { color: var(--accent); margin-bottom: 12px; }
  #dropzone .title { font-weight: 600; font-size: 16px; margin-bottom: 4px; }
  #dropzone .hint { color: var(--muted); font-size: 13px; }
  #fileInput { display: none; }
  .preview-row { display: flex; align-items: center; gap: 20px; margin-top: 20px; }
  #previewImg {
    width: 120px; height: 120px; object-fit: cover; border-radius: 14px;
    border: 1px solid var(--border); display: none;
  }
  .file-meta { flex: 1; min-width: 0; }
  .file-meta .name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-meta .size { color: var(--muted); font-size: 13px; margin-top: 2px; }
  .actions { display: flex; gap: 12px; margin-top: 24px; }
  button {
    font: inherit; border: none; border-radius: 12px; padding: 13px 22px; font-weight: 600;
    font-size: 14px; cursor: pointer; transition: transform .1s ease, opacity .15s ease;
  }
  button:active { transform: scale(0.97); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  #analyzeBtn { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: white; flex: 1; }
  #resetBtn { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  #result { display: none; }
  .final-result { text-align: center; padding: 12px 0; }
  .final-label {
    font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 16px;
  }
  .badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; font-weight: 700; font-size: 15px; }
  .badge.clear { background: var(--clear-bg); color: var(--clear); }
  .badge.occluded { background: var(--occluded-bg); color: var(--occluded); }
  .badge.big { padding: 16px 32px; font-size: 22px; border-radius: 16px; }
  #status { text-align: center; color: var(--muted); font-size: 14px; margin-top: 4px; display: none; }
  #errorBox {
    display: none; background: var(--occluded-bg); color: var(--occluded);
    border-radius: 12px; padding: 14px 16px; font-size: 14px; margin-top: 16px;
  }
  .spinner {
    width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.4);
    border-top-color: white; display: inline-block; vertical-align: middle; margin-right: 8px;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  footer { text-align: center; color: var(--muted); font-size: 12.5px; margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">Rack Vision</div>
    <h1>Rack Occlusion Classifier</h1>
    <p>Upload a rack photo to check whether the view is clear or blocked by cables/clutter before it enters your scan pipeline.</p>
  </header>

  <div class="card">
    <div id="dropzone">
      <input type="file" id="fileInput" accept="image/*">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
      <div class="title">Drop a rack image here, or click to browse</div>
      <div class="hint">JPG, PNG, WEBP, AVIF supported</div>
      <div class="preview-row" id="previewRow" style="display:none;">
        <img id="previewImg">
        <div class="file-meta">
          <div class="name" id="fileName"></div>
          <div class="size" id="fileSize"></div>
        </div>
      </div>
    </div>
    <div class="actions">
      <button id="analyzeBtn" disabled>Analyze Image</button>
      <button id="resetBtn">Clear</button>
    </div>
    <div id="status"></div>
    <div id="errorBox"></div>
  </div>

  <div class="card" id="result">
    <div class="final-result">
      <div class="final-label">Final Result</div>
      <span class="badge big" id="badge"></span>
    </div>
  </div>

  <footer>Powered by a fine-tuned MobileNetV2 trained on your clear_racks / occlusion_racks dataset.</footer>
</div>

<script>
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const previewRow = document.getElementById('previewRow');
const previewImg = document.getElementById('previewImg');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const analyzeBtn = document.getElementById('analyzeBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');
const errorBox = document.getElementById('errorBox');
const resultCard = document.getElementById('result');
const badge = document.getElementById('badge');

let currentFile = null;

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function handleFile(file) {
  currentFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    previewImg.src = e.target.result;
    previewImg.style.display = 'block';
  };
  reader.readAsDataURL(file);
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  previewRow.style.display = 'flex';
  analyzeBtn.disabled = false;
  errorBox.style.display = 'none';
  resultCard.style.display = 'none';
}

resetBtn.addEventListener('click', () => {
  currentFile = null;
  fileInput.value = '';
  previewRow.style.display = 'none';
  previewImg.style.display = 'none';
  analyzeBtn.disabled = true;
  errorBox.style.display = 'none';
  resultCard.style.display = 'none';
  statusEl.style.display = 'none';
});

analyzeBtn.addEventListener('click', async () => {
  if (!currentFile) return;
  errorBox.style.display = 'none';
  resultCard.style.display = 'none';
  analyzeBtn.disabled = true;
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span class="spinner" style="border-top-color:var(--accent); border-color: rgba(79,109,245,0.25);"></span>Analyzing...';

  const formData = new FormData();
  formData.append('image', currentFile);

  try {
    const res = await fetch('/predict', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Prediction failed');
    showResult(data);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.style.display = 'block';
  } finally {
    statusEl.style.display = 'none';
    analyzeBtn.disabled = false;
  }
});

function showResult(data) {
  badge.className = 'badge big ' + data.label;
  badge.textContent = data.label === 'clear' ? 'Clear View' : 'Occluded View';
  resultCard.style.display = 'block';
}
</script>
</body>
</html>
"""


def run_server():
    from flask import Flask, jsonify, render_template_string, request

    app = Flask(__name__)
    model, classes = load_model()  # loaded once at startup

    @app.route("/")
    def index():
        return render_template_string(INDEX_HTML)

    @app.route("/predict", methods=["POST"])
    def predict_route():
        if "image" not in request.files:
            return jsonify({"error": "No image uploaded"}), 400
        file = request.files["image"]
        try:
            img = Image.open(io.BytesIO(file.read())).convert("RGB")
        except Exception as e:
            return jsonify({"error": f"Could not read image: {e}"}), 400

        label, confidence, probs = predict_image(img, model, classes)
        return jsonify({"label": label, "confidence": confidence, "probs": probs})

    print(f"Serving at http://127.0.0.1:{SERVE_PORT}")
    app.run(debug=False, port=SERVE_PORT)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Rack occlusion classifier")
    parser.add_argument("images", nargs="*", help="Image path(s) to classify")
    parser.add_argument("--serve", action="store_true", help="Launch the web UI instead")
    parser.add_argument("--verbose", action="store_true", help="Show confidence breakdown too")
    args = parser.parse_args()

    if args.serve:
        run_server()
        return

    if not args.images:
        parser.print_help()
        sys.exit(1)

    model, classes = load_model()
    for image_path in args.images:
        try:
            label, confidence, probs = predict_path(image_path, model, classes)
        except Exception as e:
            print(f"{image_path}: ERROR - {e}")
            continue
        print(f"{image_path} -> {label}")
        if args.verbose:
            breakdown = "  ".join(f"{c}: {p * 100:.1f}%" for c, p in probs.items())
            print(f"    ({breakdown})")


if __name__ == "__main__":
    main()
