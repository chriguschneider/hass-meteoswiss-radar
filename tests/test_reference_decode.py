"""Tests for tests/tools/reference_decode.py.

Ensures the reference decoder stays in sync with the committed fixture and
is not merely self-consistent: the hand-computed vertex assertion verifies
the swisstopo formula independently of the decoder implementation.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

from tests.tools.reference_decode import decode_frame

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def test_decode_frame_matches_committed_fixture() -> None:
    """decode_frame(frame.json) must equal the committed frame_decoded.json."""
    frame = json.loads((FIXTURES / "frame.json").read_text(encoding="utf-8"))
    expected = json.loads((FIXTURES / "frame_decoded.json").read_text(encoding="utf-8"))
    assert decode_frame(frame) == expected


def test_decode_frame_hand_computed_vertex() -> None:
    """Verify one vertex from first principles.

    Guards against the reference being only self-consistent.

    First vertex (s=0) of the first contour in frame.json:
      i=710 (even), j=641, o[0]='5'
      coords: x_min=255.5 x_max=964.5 x_count=710 y_min=-159.5 y_max=479.5 y_count=640

    Grid position:
      off = (ord('5')-48)/10 + 0.05 = 0.55
      x = 255.5 + 709*(710/2)/710 = 610.0 km (CH1903)
      y = -159.5 + 639*(320+0.55)/640 = 160.549140625 km

    swisstopo formula (FORMAT.md §Basemap) gives ~46.596°N 7.569°E,
    rounded to float32 precision.
    """

    def _f32(v: float) -> float:
        return struct.unpack("f", struct.pack("f", v))[0]

    # Independently compute the expected grid position from the raw contour fields
    x_min, x_max, x_count = 255.5, 964.5, 710
    y_min, y_max, y_count = -159.5, 479.5, 640
    ci, cj = 710, 641
    off = (ord("5") - 48) / 10 + 0.05  # o[0]='5', s=0 formula

    # ci is even: vertex on vertical gridline
    x = x_min + (x_max - x_min) * (ci / 2) / x_count  # 610.0
    y = y_min + (y_max - y_min) * ((cj - 1) / 2 + off) / y_count  # 160.549140625

    # swisstopo TN_0164 approximation (FORMAT.md §Basemap)
    yp = (x * 1000 - 600000) / 1_000_000
    xp = (y * 1000 - 200000) / 1_000_000
    lam = (
        2.6779094
        + 4.728982 * yp
        + 0.791484 * yp * xp
        + 0.1306 * yp * xp**2
        - 0.0436 * yp**3
    )
    phi = (
        16.9023892
        + 3.238272 * xp
        - 0.270978 * yp**2
        - 0.002528 * xp**2
        - 0.0447 * yp**2 * xp
        - 0.014 * xp**3
    )
    expected_lat = _f32((phi * 100) / 36)
    expected_lng = _f32((lam * 100) / 36)

    frame = json.loads((FIXTURES / "frame.json").read_text(encoding="utf-8"))
    decoded = decode_frame(frame)

    first_ring = decoded[0]["shapes"][0][0]
    assert first_ring[0] == expected_lat
    assert first_ring[1] == expected_lng


@pytest.mark.parametrize(
    "overlay_type,has_area",
    [
        ("snow", False),
        ("snow", True),
        ("snowrain", False),
        ("snowrain", True),
        ("freezingrain", False),
        ("freezingrain", True),
    ],
)
def test_decode_overlay_frame(overlay_type: str, has_area: bool) -> None:
    """Overlay frame decodes correctly for all types and states.

    Tests overlay frames (snow, snowrain, freezingrain) in both empty
    and synthetic states. Empty frames (no areas) decode to an empty array.
    Synthetic frames with one area use the respective legend colors and
    verify the decoder works for overlays the same as for rate layers.
    """
    state = "synthetic" if has_area else "empty"
    frame_file = FIXTURES / f"{overlay_type}_frame_{state}.json"
    expected_file = FIXTURES / f"{overlay_type}_frame_{state}_decoded.json"

    frame = json.loads(frame_file.read_text(encoding="utf-8"))
    expected = json.loads(expected_file.read_text(encoding="utf-8"))
    assert decode_frame(frame) == expected
