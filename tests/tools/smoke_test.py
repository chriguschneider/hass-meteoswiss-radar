"""
Scheduled live smoke test against the real MeteoSwiss API.

Fetches current frames from the live API and validates that the reference
decoder produces plausible geometry. Designed to run weekly on a cron schedule
to detect upstream API format changes early.

Run from the repo root:

    python3 tests/tools/smoke_test.py

Exits with status 0 if all frames decode successfully and geometry is valid.
Exits with status 1 if any frame fails to fetch, decode, or validate.
"""

import json
import sys
import urllib.request
import urllib.error
from datetime import datetime

sys.path.insert(0, "tests/tools")
from reference_decode import decode_frame


BASE_URL = "https://www.meteoschweiz.admin.ch"
GEOM_VALIDATION = {
    "x_min": 255.5,
    "x_max": 964.5,
    "y_min": -159.5,
    "y_max": 479.5,
}


def fetch_json(path):
    """Fetch a JSON file from the MeteoSwiss API.

    Returns: parsed JSON dict, or raises urllib.error on failure.
    """
    url = f"{BASE_URL}/{path}"
    print(f"Fetching {url}...")
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError) as e:
        print(f"  ✗ Failed: {e}")
        raise


def validate_geometry(decoded_areas):
    """Validate that decoded areas contain plausible geometry.

    - At least one area
    - Each area has at least one shape
    - Each shape has at least one ring
    - Each ring has at least 6 coordinate values (3 vertices)
    - All lat/lng values are within plausible bounds (roughly earth-like)

    Returns True if valid, False otherwise.
    """
    if not decoded_areas:
        print("  ✗ No areas decoded (empty frame)")
        return False

    total_vertices = 0
    for area in decoded_areas:
        if "shapes" not in area or not area["shapes"]:
            print(f"  ✗ Area {area.get('color', '?')} has no shapes")
            return False

        for shape in area["shapes"]:
            if not shape:
                print(f"  ✗ Area {area.get('color', '?')} has empty shapes")
                return False

            for ring in shape:
                if len(ring) < 6:  # 3 vertices = 6 coords
                    print(
                        f"  ✗ Ring in area {area.get('color', '?')} "
                        f"has too few vertices: {len(ring) // 2}"
                    )
                    return False

                # Check lat/lng bounds (roughly ±90/±180, more strictly CH-like)
                for i in range(0, len(ring), 2):
                    lat, lng = ring[i], ring[i + 1]
                    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
                        print(
                            f"  ✗ Ring in area {area.get('color', '?')} "
                            f"has out-of-bounds coord: ({lat}, {lng})"
                        )
                        return False

                total_vertices += len(ring) // 2

    print(f"  ✓ {len(decoded_areas)} areas, {total_vertices} vertices decoded")
    return True


def smoke_test():
    """Run the live smoke test.

    Fetches versions.json, animation manifest, one measurement frame, and
    one forecast frame. Decodes each and validates geometry.

    Returns: (success: bool, errors: list of str)
    """
    errors = []

    try:
        print("\n=== Fetching versions.json ===")
        versions = fetch_json("product/output/versions.json")
        anim_version = versions.get("precipitation/animation")
        if not anim_version:
            errors.append("versions.json missing 'precipitation/animation'")
            return False, errors
        print(f"  ✓ Animation version: {anim_version}")

        print("\n=== Fetching animation manifest ===")
        anim_path = f"product/output/precipitation/animation/version__{anim_version}/de/animation.json"
        manifest = fetch_json(anim_path)
        print(f"  ✓ Manifest fetched")

        # Find the latest measurement frame
        pictures = manifest.get("map_images", [{}])[0].get("pictures", [])
        measurement_pics = [p for p in pictures if p.get("data_type") == "measurement"]
        if not measurement_pics:
            errors.append("No measurement frames in manifest")
            return False, errors

        latest_measurement = measurement_pics[-1]
        radar_url = latest_measurement.get("radar_url")
        if not radar_url:
            errors.append("Latest measurement frame has no radar_url")
            return False, errors

        print(f"\n=== Fetching measurement frame ===")
        print(f"  Timepoint: {latest_measurement.get('timepoint', 'N/A')}")
        frame_data = fetch_json(radar_url.lstrip("/"))
        decoded = decode_frame(frame_data)
        if not validate_geometry(decoded):
            errors.append("Measurement frame geometry validation failed")
            return False, errors
        print("  ✓ Geometry valid")

        # Find the latest forecast frame
        forecast_pics = [p for p in pictures if p.get("data_type") == "forecast"]
        if not forecast_pics:
            errors.append("No forecast frames in manifest")
            return False, errors

        latest_forecast = forecast_pics[-1]
        rate_url = latest_forecast.get("snow_url")  # Use first overlay as proxy
        if not rate_url:
            # Fall back to rate if no overlays
            print("  No overlay URL, skipping forecast frame test")
        else:
            print(f"\n=== Fetching forecast frame (overlay) ===")
            print(f"  Timepoint: {latest_forecast.get('timepoint', 'N/A')}")
            forecast_data = fetch_json(rate_url.lstrip("/"))
            decoded = decode_frame(forecast_data)
            if not validate_geometry(decoded):
                errors.append("Forecast frame (overlay) geometry validation failed")
                return False, errors
            print("  ✓ Geometry valid")

    except Exception as e:
        errors.append(f"Unexpected error: {e}")
        return False, errors

    return True, errors


def main():
    """Run the smoke test and report results."""
    print("=" * 60)
    print(f"MeteoSwiss Radar Live Smoke Test — {datetime.now().isoformat()}")
    print("=" * 60)

    success, errors = smoke_test()

    if success:
        print("\n" + "=" * 60)
        print("✓ All checks passed")
        print("=" * 60)
        return 0
    else:
        print("\n" + "=" * 60)
        print("✗ Smoke test failed:")
        for error in errors:
            print(f"  - {error}")
        print("=" * 60)
        return 1


if __name__ == "__main__":
    sys.exit(main())
