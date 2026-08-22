"""Constants for the MeteoSwiss Radar integration."""

DOMAIN = "meteoswiss_radar"

# Keep in sync with manifest.json and the card's CARD_VERSION.
VERSION = "0.6.1"

UPSTREAM_BASE = "https://www.meteoschweiz.admin.ch"

FRONTEND_URL_BASE = "/meteoswiss_radar/frontend"
CARD_FILENAME = "meteoswiss-radar-card.js"

PROXY_URL = "/api/meteoswiss_radar/proxy/{tail:.+}"
