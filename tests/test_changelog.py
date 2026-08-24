"""Guard CHANGELOG.md format and coverage.

Verifies that CHANGELOG.md exists and contains a section header for the
version currently declared in manifest.json, so a version bump without a
matching changelog section fails on every push — not only on tag push.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / "CHANGELOG.md"
MANIFEST = ROOT / "custom_components" / "meteoswiss_radar" / "manifest.json"


def _current_version() -> str:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["version"]


def test_changelog_exists() -> None:
    assert CHANGELOG.exists(), "CHANGELOG.md is missing"


def test_changelog_has_section_for_current_version() -> None:
    version = _current_version()
    text = CHANGELOG.read_text(encoding="utf-8")
    # Accept both bare (0.8.0) and v-prefixed (v0.9.0) section headers.
    pattern = rf"^## \[v?{re.escape(version)}\]"
    assert re.search(pattern, text, re.MULTILINE), (
        f"CHANGELOG.md has no section for version {version!r}. "
        "Add a '## [{version}]' entry before bumping the version."
    )


def test_changelog_has_unreleased_section() -> None:
    text = CHANGELOG.read_text(encoding="utf-8")
    assert re.search(r"^## \[Unreleased\]", text, re.MULTILINE), (
        "CHANGELOG.md must have an '[Unreleased]' section at the top "
        "(Keep a Changelog convention)"
    )


def test_changelog_link_definitions_present() -> None:
    """Every version header should have a corresponding link definition."""
    text = CHANGELOG.read_text(encoding="utf-8")
    headers = re.findall(r"^## \[(v?\d+\.\d+\.\d+)\]", text, re.MULTILINE)
    for version in headers:
        assert f"[{version}]:" in text, (
            f"CHANGELOG.md is missing the link definition for [{version}]"
        )
