"""Pure metadata tests: no Home Assistant required.

Guards the "keep in sync" footgun called out in const.py: the version
must be identical across manifest.json, const.py, hacs.json context and
the card's CARD_VERSION. Also asserts the manifest carries the keys
hassfest/HACS expect. Runs in milliseconds, stdlib only.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPONENT = ROOT / "custom_components" / "meteoswiss_radar"


def _manifest() -> dict:
    return json.loads((COMPONENT / "manifest.json").read_text(encoding="utf-8"))


def _const_version() -> str:
    text = (COMPONENT / "const.py").read_text(encoding="utf-8")
    match = re.search(r'^VERSION\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match, "VERSION not found in const.py"
    return match.group(1)


def _card_version() -> str:
    text = (COMPONENT / "frontend" / "meteoswiss-radar-card.js").read_text(
        encoding="utf-8"
    )
    match = re.search(r'CARD_VERSION\s*=\s*"([^"]+)"', text)
    assert match, "CARD_VERSION not found in the card"
    return match.group(1)


def test_versions_are_in_sync() -> None:
    manifest_version = _manifest()["version"]
    assert _const_version() == manifest_version
    assert _card_version() == manifest_version


def test_manifest_has_required_keys() -> None:
    manifest = _manifest()
    for key in (
        "domain",
        "name",
        "codeowners",
        "documentation",
        "issue_tracker",
        "version",
        "config_flow",
        "iot_class",
    ):
        assert key in manifest, f"manifest.json missing '{key}'"
    assert manifest["domain"] == "meteoswiss_radar"


def test_vendor_urls_contain_version() -> None:
    """Vendor asset URLs must embed the version so a release bump busts the cache."""
    card_text = (COMPONENT / "frontend" / "meteoswiss-radar-card.js").read_text(
        encoding="utf-8"
    )
    # The card is vanilla JS with template literals; CARD_VERSION is a variable.
    assert "/vendor/${CARD_VERSION}/leaflet.js" in card_text, (
        "leaflet.js URL must include CARD_VERSION in the path"
    )
    assert "/vendor/${CARD_VERSION}/leaflet.css" in card_text, (
        "leaflet.css URL must include CARD_VERSION in the path"
    )

    init_text = (COMPONENT / "__init__.py").read_text(encoding="utf-8")
    # __init__.py uses a Python f-string with {VERSION}, not the literal value.
    assert "/vendor/{VERSION}" in init_text, (
        "__init__.py must mount vendor assets under a versioned path using VERSION"
    )


def test_unversioned_vendor_path_stays_mounted() -> None:
    """A tab left open across an upgrade still runs the old, unversioned card."""
    init_text = (COMPONENT / "__init__.py").read_text(encoding="utf-8")
    assert 'f"{FRONTEND_URL_BASE}/vendor",' in init_text, (
        "the unversioned vendor mount must stay registered as a fallback for "
        "dashboard tabs still running a card from before the versioned path"
    )


def test_hacs_json_is_valid() -> None:
    hacs = json.loads((ROOT / "hacs.json").read_text(encoding="utf-8"))
    assert hacs["name"]
    # Minimum HA version must look like a real release string.
    assert re.fullmatch(r"\d{4}\.\d+\.\d+", hacs["homeassistant"])
    # HACS renders the README as the store page.
    assert hacs.get("render_readme") is True
    # The declared minimum must match the newest HA API the code relies on.
    # StaticPathConfig / async_register_static_paths and remove_extra_js_url
    # all landed in 2024.7 -- the dev-blog post announcing them is dated
    # 2024-06-18, which is where the earlier "2024.6" claim came from.
    assert hacs["homeassistant"] == "2024.7.0"
