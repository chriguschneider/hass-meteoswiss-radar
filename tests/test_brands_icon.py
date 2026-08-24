"""Tests for the brands icon generator (issue #84).

Pure logic only: no network, no Pillow. Guards the two footguns in
scripts/generate_brands_icon.py - the App Store artwork-URL rewrite and
picking the correct app out of the iTunes search results by bundle id.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "generate_brands_icon.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("generate_brands_icon", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gbi = _load_module()


def test_upscale_request_rewrites_dimensions():
    url = (
        "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/57/47/da/"
        "abc/AppIcon-0-0-85-220.png/512x512bb.jpg"
    )
    assert gbi.upscale_request(url, 1024).endswith("/1024x1024bb.jpg")


def test_upscale_request_keeps_png_extension():
    url = "https://example.test/thumb/foo/100x100bb.png"
    assert gbi.upscale_request(url, 512) == "https://example.test/thumb/foo/512x512bb.png"


def test_upscale_request_leaves_unrecognised_url_untouched():
    url = "https://example.test/icon.png"
    assert gbi.upscale_request(url, 512) == url


def test_find_artwork_url_matches_bundle_id(monkeypatch):
    payload = {
        "results": [
            {"bundleId": "ch.srf.meteo", "artworkUrl512": "https://x/srf.jpg"},
            {
                "bundleId": gbi.APP_BUNDLE_ID,
                "artworkUrl512": "https://x/meteoswiss.jpg",
            },
        ]
    }
    monkeypatch.setattr(gbi, "_get", lambda url: json.dumps(payload).encode())
    assert gbi.find_artwork_url(gbi.APP_BUNDLE_ID) == "https://x/meteoswiss.jpg"


def test_find_artwork_url_raises_when_absent(monkeypatch):
    monkeypatch.setattr(gbi, "_get", lambda url: b'{"results": []}')
    with pytest.raises(SystemExit):
        gbi.find_artwork_url(gbi.APP_BUNDLE_ID)
