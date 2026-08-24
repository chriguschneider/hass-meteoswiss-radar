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


def _package_version() -> str:
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]


def test_versions_are_in_sync() -> None:
    """All four version strings must move together.

    package.json was left out of this check until #64 and had silently drifted
    a patch release behind, so `npm test` printed a version the card did not
    ship as. Every file that carries the version belongs here, or it drifts.
    """
    manifest_version = _manifest()["version"]
    assert _const_version() == manifest_version, "const.py VERSION out of sync"
    assert _card_version() == manifest_version, "card CARD_VERSION out of sync"
    assert _package_version() == manifest_version, "package.json version out of sync"


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
    """Vendor asset URLs must embed the version as an opaque cache-buster tag."""
    card_text = (COMPONENT / "frontend" / "meteoswiss-radar-card.js").read_text(
        encoding="utf-8"
    )
    # The card is vanilla JS with template literals; CARD_VERSION is a variable.
    # The version stays in the URL so a release bump still busts the browser
    # cache -- but it is now only a tag, resolved version-agnostically (#70).
    assert "/vendor/${CARD_VERSION}/leaflet.js" in card_text, (
        "leaflet.js URL must include CARD_VERSION in the path"
    )
    assert "/vendor/${CARD_VERSION}/leaflet.css" in card_text, (
        "leaflet.css URL must include CARD_VERSION in the path"
    )


def test_vendor_served_version_agnostically() -> None:
    """Vendor assets must be served by a tag-agnostic view, not a versioned mount.

    Regression test for issue #70: a static mount keyed on VERSION 404s for any
    other tag (an old card after an upgrade, a new card before a restart), so
    the serving path must be a HomeAssistantView whose URL captures an opaque
    {tag} it never uses for filesystem resolution.
    """
    init_text = (COMPONENT / "__init__.py").read_text(encoding="utf-8")
    # An f-string doubles the braces: /vendor/{{tag}}/{{filename:.+}}.
    assert "/vendor/{{tag}}/{{filename" in init_text, (
        "the vendor view URL must capture an opaque {tag} segment"
    )
    # The old versioned/unversioned static mounts must be gone.
    assert "/vendor/{VERSION}" not in init_text, (
        "the version-keyed static vendor mount must be replaced by the view"
    )
    assert "async_register_static_paths" not in init_text, (
        "vendor assets must be served by a view, not a static path mount"
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
