"""Tests for the brand icon set and its generator (issue #84).

The generator tests are pure logic: no network, no Pillow. They guard the
two footguns in scripts/generate_brands_icon.py - the App Store
artwork-URL rewrite and picking the correct app out of the iTunes search
results by bundle id.

The shipped-asset tests guard the files themselves. Since HA 2026.3 the
brands proxy API serves custom_components/meteoswiss_radar/brand/ in
preference to the brands CDN, so those PNGs are a release artifact: if
they go missing or change shape, every user falls back to the
puzzle-piece icon and nothing else in the suite would notice.
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


# --- Shipped brand assets -------------------------------------------------
#
# Deliberately parsed by hand rather than with Pillow: the suite must run
# without Pillow installed, and a PNG header check is enough to catch the
# realistic failure modes (file missing, truncated, wrong dimensions, or a
# JPEG renamed to .png).

BRAND_DIR = ROOT / "custom_components" / "meteoswiss_radar" / "brand"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _png_size(path: Path) -> tuple[int, int]:
    """Return (width, height) from the IHDR chunk of a PNG."""
    header = path.read_bytes()[:24]
    assert header[:8] == PNG_MAGIC, f"{path.name} is not a PNG"
    assert header[12:16] == b"IHDR", f"{path.name} has no leading IHDR chunk"
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    return width, height


@pytest.mark.parametrize(("filename", "edge"), gbi.OUTPUTS)
def test_shipped_brand_icon_has_expected_dimensions(filename, edge):
    path = BRAND_DIR / filename
    assert path.is_file(), (
        f"{filename} is missing from {BRAND_DIR.name}/ - HA falls back to the "
        "puzzle-piece icon. Regenerate with scripts/generate_brands_icon.py."
    )
    assert _png_size(path) == (edge, edge)


def test_shipped_brand_icons_match_generator_outputs():
    """The folder holds exactly what the generator produces - no strays."""
    expected = {filename for filename, _ in gbi.OUTPUTS}
    actual = {p.name for p in BRAND_DIR.iterdir() if p.is_file()}
    assert actual == expected


def test_generator_defaults_to_the_shipped_brand_folder():
    """Guards the default --out; a drifted path silently stops shipping."""
    assert gbi.BRAND_DIR == BRAND_DIR
