"""Constants for the MeteoSwiss Radar integration."""

DOMAIN = "meteoswiss_radar"
DATA_NOWCAST = f"{DOMAIN}_nowcast_data"

# Opt-in for the local nowcast entities (#197). Off by default: someone who
# installed this for the card should not also get five entities and a 5-minute
# poller -- the same reasoning that keeps the radar and weather integrations
# apart (weather ADR-0003: "users who want only the map should not get a
# weather entity, and vice versa").
OPT_NOWCAST_ENABLED = "nowcast_enabled"

# Minimum minutes the rain-protection signal stays on once raised (#212).
# Whatever it drives is usually a motor, and a shower clipping the location
# otherwise cycles it within minutes.
OPT_PROTECTION_MIN_HOLD = "protection_min_hold_minutes"

# Keep in sync with manifest.json and the card's CARD_VERSION.
VERSION = "0.15.0"

UPSTREAM_BASE = "https://www.meteoschweiz.admin.ch"

FRONTEND_URL_BASE = "/meteoswiss_radar/frontend"
CARD_FILENAME = "meteoswiss-radar-card.js"

PROXY_URL = "/api/meteoswiss_radar/proxy/{tail:.+}"
