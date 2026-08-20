"""Config loader — the first thing runner.py does, so a regression here takes
the whole pipeline down before a single model is loaded."""

import json
import os

import pytest

from pipeline.config_loader import ensure_dir, load_json_config

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_loads_valid_json(tmp_path):
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"models": {"ports_typed": "Models/ports_9.pt"}}))
    assert load_json_config(str(p)) == {"models": {"ports_typed": "Models/ports_9.pt"}}


def test_missing_file_raises_with_path_in_message(tmp_path):
    # runner.py surfaces this straight to the operator, so the path has to be
    # in the message — "config not found" alone is unactionable.
    missing = tmp_path / "nope.json"
    with pytest.raises(FileNotFoundError) as exc:
        load_json_config(str(missing))
    assert str(missing) in str(exc.value)


def test_malformed_json_raises_json_error(tmp_path):
    # Must NOT be swallowed into an empty dict — a silently empty config would
    # make runner.py fall through to its defaults and load the wrong models.
    p = tmp_path / "bad.json"
    p.write_text('{"models": {"ports_typed": ')
    with pytest.raises(json.JSONDecodeError):
        load_json_config(str(p))


def test_empty_file_raises(tmp_path):
    p = tmp_path / "empty.json"
    p.write_text("")
    with pytest.raises(json.JSONDecodeError):
        load_json_config(str(p))


def test_non_ascii_values_survive_the_round_trip(tmp_path):
    # The loader pins encoding="utf-8"; on Windows the default is cp1252, so an
    # accented path would decode to mojibake (or raise) without that pin.
    p = tmp_path / "utf8.json"
    p.write_text(json.dumps({"paths": {"output_dir": "outputs/Zürich"}}), encoding="utf-8")
    assert load_json_config(str(p))["paths"]["output_dir"] == "outputs/Zürich"


def test_ensure_dir_creates_nested_and_is_idempotent(tmp_path):
    target = tmp_path / "outputs" / "run1" / "crops"
    ensure_dir(str(target))
    assert target.is_dir()
    ensure_dir(str(target))  # second call must not raise (exist_ok=True)
    assert target.is_dir()


def test_ensure_dir_on_existing_file_path_raises(tmp_path):
    # A stale FILE where a directory is expected has to fail loudly rather than
    # let the pipeline run and drop every artefact on the floor.
    f = tmp_path / "outputs"
    f.write_text("not a directory")
    with pytest.raises(OSError):
        ensure_dir(str(f))


def test_shipped_config_has_the_keys_runner_indexes_directly():
    """Contract test for the repo's own config.json.

    runner.py reads these three with `config["models"][...]` (not .get), so a
    rename or a dropped key is an immediate KeyError on every job — not a
    fallback. Cheap to pin, and it needs no weights.
    """
    cfg = load_json_config(os.path.join(REPO_ROOT, "config.json"))
    for key in ("devices_seg", "ports_typed", "ports_status"):
        assert key in cfg["models"], f"config.json missing models.{key}"
    assert "output_dir" in cfg["paths"]
    # Confidence thresholds are floats in 0..1; a stray string here would only
    # blow up deep inside the model call.
    for name, value in cfg["detection"].items():
        if name.endswith("_conf") or name == "iou_dedup":
            assert isinstance(value, (int, float)) and 0.0 < value <= 1.0, name
