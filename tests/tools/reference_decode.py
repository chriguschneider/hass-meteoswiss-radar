"""
Reference decoder for MeteoSwiss radar frame JSON.

Derived directly from FORMAT.md — not a port of the JS implementation.
Run from the repo root:

    python3 tests/tools/reference_decode.py \\
        tests/fixtures/frame.json \\
        tests/fixtures/frame_decoded.json

The output is committed and used by decoder.test.mjs as an independent
comparison baseline for the JS chain-code decoder.

Coordinate values are rounded to float32 precision before writing so the
test can compare against JS Float32Array values without a per-element
tolerance wider than float32 rounding itself.
"""

import json
import struct
import sys


def grid_km_to_latlng(x_km, y_km):
    """CH1903 grid km -> WGS84 (swisstopo approximation, FORMAT.md §Basemap).

    E = x_km*1000 + 2000000  (LV95 m, but formula uses the CH1903 auxiliaries)
    N = y_km*1000 + 1000000
    yp = (E - 2600000) / 1000000   (formula ref: swisstopo TN_0164)
    xp = (N - 1200000) / 1000000
    But FORMAT.md uses the CH1903(LV03) km convention:
      yp = (x_km*1000 - 600000) / 1000000
      xp = (y_km*1000 - 200000) / 1000000
    """
    yp = (x_km * 1000 - 600000) / 1_000_000
    xp = (y_km * 1000 - 200000) / 1_000_000
    lam = (
        2.6779094
        + 4.728982 * yp
        + 0.791484 * yp * xp
        + 0.1306 * yp * xp * xp
        - 0.0436 * yp ** 3
    )
    phi = (
        16.9023892
        + 3.238272 * xp
        - 0.270978 * yp ** 2
        - 0.002528 * xp ** 2
        - 0.0447 * yp ** 2 * xp
        - 0.014 * xp ** 3
    )
    return [(phi * 100) / 36, (lam * 100) / 36]


def decode_contour(contour, coords):
    """Decode one chain-code contour to a flat [lat, lng, lat, lng, ...] list.

    FORMAT.md §Chain-code contours:
    - i even: vertex on vertical gridline; fractional offset applies to y
    - i odd:  vertex on horizontal gridline; fractional offset applies to x
    - off = digit/10 + 0.05  (sub-cell position along the gridline)
    - delta between vertex s and s+1: i += d[2s]-77, j += d[2s+1]-77
    """
    x_min = coords["x_min"]
    x_span = coords["x_max"] - coords["x_min"]
    x_count = coords["x_count"]
    y_min = coords["y_min"]
    y_span = coords["y_max"] - coords["y_min"]
    y_count = coords["y_count"]

    ci = contour["i"]
    cj = contour["j"]
    o = contour["o"]
    d = contour["d"]
    n = len(o)
    points = []

    for s in range(n):
        off = (ord(o[s]) - 48) / 10 + 0.05
        if ci % 2 == 0:
            x = x_min + x_span * (ci / 2) / x_count
            y = y_min + y_span * ((cj - 1) / 2 + off) / y_count
        else:
            x = x_min + x_span * ((ci - 1) / 2 + off) / x_count
            y = y_min + y_span * (cj / 2) / y_count
        lat, lng = grid_km_to_latlng(x, y)
        points.extend([lat, lng])
        if s < n - 1:
            ci += ord(d[2 * s]) - 77
            cj += ord(d[2 * s + 1]) - 77

    return points


def to_float32(v):
    """Round a Python float to the nearest IEEE 754 single-precision value."""
    return struct.unpack("f", struct.pack("f", v))[0]


def decode_frame(frame):
    """Decode a full frame JSON to the same structure as the JS decoder.

    Returns: [{"color": "#rrggbb", "shapes": [[[lat, lng, ...], ...], ...]}, ...]
    Each ring is a flat list of float32-rounded lat/lng pairs.
    """
    coords = frame["coords"]
    result = []
    for area in frame["areas"]:
        color = "#" + area["color"]
        shapes = []
        for shape in area["shapes"]:
            rings = []
            for contour in shape:
                raw = decode_contour(contour, coords)
                rings.append([to_float32(v) for v in raw])
            shapes.append(rings)
        result.append({"color": color, "shapes": shapes})
    return result


def main():
    in_path = sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/frame.json"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "tests/fixtures/frame_decoded.json"

    with open(in_path) as fh:
        frame = json.load(fh)

    decoded = decode_frame(frame)

    with open(out_path, "w") as fh:
        json.dump(decoded, fh, indent=2)
        fh.write("\n")

    area_count = len(decoded)
    vertex_count = sum(
        len(ring) // 2
        for area in decoded
        for shape in area["shapes"]
        for ring in shape
    )
    print(f"Decoded {area_count} areas, {vertex_count} vertices -> {out_path}")


if __name__ == "__main__":
    main()
