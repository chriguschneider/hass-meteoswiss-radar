#!/usr/bin/env python3
"""Generate the home-assistant/brands icon set for this integration.

The integration shows the default puzzle-piece icon in Home Assistant and
HACS until an entry exists in the ``home-assistant/brands`` repository
(issue #84). This helper produces the two PNGs that repository requires
from the *official MeteoSwiss app icon*:

- ``icon.png``    - 256x256
- ``icon@2x.png`` - 512x512

We deliberately do not commit the resulting PNGs here: they are a
trademarked logo whose proper home is the ``home-assistant/brands`` PR,
not this repository's history. Run this script to (re)produce them, then
follow ``docs/brands-icon.md`` to open the brands PR.

The source is the App Store artwork for the official MeteoSwiss app
(``ch.admin.meteoswiss``, publisher "Federal Office of Meteorology and
Climatology MeteoSwiss"), looked up via the public iTunes Search API. The
artwork is a fully square, opaque icon with no rounded-corner alpha baked
in, which is exactly what brands wants (the HA frontend applies its own
masking).

Usage::

    pip install Pillow
    python scripts/generate_brands_icon.py --out build/brands

Requires network access and Pillow. Standard library otherwise.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

# Official MeteoSwiss app on the App Store. The bundle id is the stable
# anchor; the display name and artwork URL can change over time.
APP_BUNDLE_ID = "ch.admin.meteoswiss"
SEARCH_URL = (
    "https://itunes.apple.com/search"
    "?term=meteoswiss&country=ch&entity=software&limit=25"
)
USER_AGENT = "hass-meteoswiss-radar brands-icon-generator (issue #84)"

# home-assistant/brands required outputs: (filename, edge length in px).
OUTPUTS = (("icon.png", 256), ("icon@2x.png", 512))


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def find_artwork_url(bundle_id: str) -> str:
    """Return the App Store artwork URL for the given bundle id."""
    data = json.loads(_get(SEARCH_URL))
    for result in data.get("results", []):
        if result.get("bundleId") == bundle_id:
            url = result.get("artworkUrl512") or result.get("artworkUrl100")
            if not url:
                raise SystemExit(f"No artwork URL in result for {bundle_id}")
            return url
    raise SystemExit(
        f"App {bundle_id!r} not found in iTunes search results. "
        "Check the bundle id or pass --source-url explicitly."
    )


def upscale_request(url: str, size: int) -> str:
    """Ask Apple for a larger master so the downscale stays crisp.

    Artwork URLs end in ``/<w>x<h>bb.jpg``; swapping the dimensions asks
    the CDN to render at that size. We request the master at 2x the
    largest output so the LANCZOS downscale has headroom.
    """
    return re.sub(r"/\d+x\d+bb\.(jpg|png)$", f"/{size}x{size}bb.\\1", url)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default="build/brands",
        help="Output directory (default: build/brands)",
    )
    parser.add_argument(
        "--source-url",
        default=None,
        help="Override the App Store artwork URL (skips the iTunes lookup)",
    )
    args = parser.parse_args()

    try:
        from PIL import Image
    except ImportError:
        raise SystemExit("Pillow is required: pip install Pillow") from None

    source_url = args.source_url or find_artwork_url(APP_BUNDLE_ID)
    master_size = max(edge for _, edge in OUTPUTS) * 2
    master_url = upscale_request(source_url, master_size)
    print(f"Fetching master artwork: {master_url}")

    master = Image.open(io.BytesIO(_get(master_url))).convert("RGB")
    if master.width != master.height:
        raise SystemExit(
            f"Source artwork is not square ({master.size}); refusing to "
            "distort a logo. Inspect the source manually."
        )

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for filename, edge in OUTPUTS:
        img = master.resize((edge, edge), Image.LANCZOS)
        path = out_dir / filename
        img.save(path, "PNG", optimize=True)
        print(f"Wrote {path} ({edge}x{edge})")

    print(
        "\nDone. Next: copy these into a home-assistant/brands fork under "
        "custom_integrations/meteoswiss_radar/ and open the PR. "
        "See docs/brands-icon.md."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
