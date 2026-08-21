/* MeteoSwiss Radar Card
 * Precipitation radar on a swisstopo basemap, data from the MeteoSwiss app API
 * through the meteoswiss_radar integration's authenticated proxy.
 * Frame format: see FORMAT.md in the repository root.
 */

const CARD_VERSION = "0.1.0";
const FRONTEND_BASE = "/meteoswiss_radar/frontend";
const PROXY_BASE = "meteoswiss_radar/proxy"; // hass.callApi() prepends /api/

const TILE_URL =
  "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg";
const ATTRIBUTION = "Source: MeteoSwiss &middot; &copy; swisstopo";

let leafletLoader = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletLoader) {
    leafletLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${FRONTEND_BASE}/vendor/leaflet.js`;
      script.onload = () => resolve(window.L);
      script.onerror = () => reject(new Error("Leaflet failed to load"));
      document.head.appendChild(script);
    });
  }
  return leafletLoader;
}

/* Radar grid km (CH1903 values) -> LV95 m -> WGS84 (swisstopo approximation). */
function gridKmToLatLng(xKm, yKm) {
  const yp = (xKm * 1000 - 600000) / 1000000;
  const xp = (yKm * 1000 - 200000) / 1000000;
  const lambda =
    2.6779094 +
    4.728982 * yp +
    0.791484 * yp * xp +
    0.1306 * yp * xp * xp -
    0.0436 * yp * yp * yp;
  const phi =
    16.9023892 +
    3.238272 * xp -
    0.270978 * yp * yp -
    0.002528 * xp * xp -
    0.0447 * yp * yp * xp -
    0.014 * xp * xp * xp;
  return [(phi * 100) / 36, (lambda * 100) / 36];
}

/* Chain-code contour decoder (see FORMAT.md).
 * A vertex sits on a gridline crossing: i even = on a vertical gridline
 * (fractional offset applies to y), i odd = on a horizontal one. Deltas in d
 * apply BETWEEN vertices: o.length vertices, o.length - 1 char pairs in d. */
function decodeContour(contour, grid) {
  let i = contour.i;
  let j = contour.j;
  const d = contour.d;
  const o = contour.o;
  const n = o.length;
  const points = new Array(n);
  for (let s = 0; s < n; s++) {
    const off = (o.charCodeAt(s) - 48) / 10 + 0.05;
    let x, y;
    if (i % 2 === 0) {
      x = grid.xMin + (grid.xSpan * (i / 2)) / grid.xCount;
      y = grid.yMin + (grid.ySpan * ((j - 1) / 2 + off)) / grid.yCount;
    } else {
      x = grid.xMin + (grid.xSpan * ((i - 1) / 2 + off)) / grid.xCount;
      y = grid.yMin + (grid.ySpan * (j / 2)) / grid.yCount;
    }
    points[s] = gridKmToLatLng(x, y);
    if (s < n - 1) {
      i += d.charCodeAt(2 * s) - 77;
      j += d.charCodeAt(2 * s + 1) - 77;
    }
  }
  return points;
}

/* One multi-polygon per intensity band; contour 0 of a shape is the outer
 * ring, later contours are holes (evenodd fill handles them). */
function frameToPolygons(frame, L) {
  const c = frame.coords;
  const grid = {
    xMin: c.x_min,
    xSpan: c.x_max - c.x_min,
    xCount: c.x_count,
    yMin: c.y_min,
    ySpan: c.y_max - c.y_min,
    yCount: c.y_count,
  };
  return frame.areas.map((area) =>
    L.polygon(
      area.shapes.map((shape) => shape.map((ct) => decodeContour(ct, grid))),
      {
        stroke: false,
        fillColor: `#${area.color}`,
        fillOpacity: 0.75,
        fillRule: "evenodd",
        interactive: false,
      }
    )
  );
}

const HOUSE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26">' +
  '<path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" fill="#1976d2" stroke="#fff" stroke-width="1.6"/></svg>';

class MeteoSwissRadarCard extends HTMLElement {
  setConfig(config) {
    this._config = { height: 400, zoom: 8, ...(config || {}) };
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeInit();
  }

  connectedCallback() {
    this._maybeInit();
    if (this._map) requestAnimationFrame(() => this._map.invalidateSize());
  }

  getCardSize() {
    return 6;
  }

  static getStubConfig() {
    return {};
  }

  async _maybeInit() {
    if (this._initialized || !this._hass || !this.isConnected) return;
    this._initialized = true;
    this._renderShell();
    try {
      const L = await loadLeaflet();
      this._createMap(L);
      await this._loadData(L);
    } catch (err) {
      console.error("meteoswiss-radar-card:", err);
      this._showError(err.message || String(err));
    }
  }

  _renderShell() {
    const root = this.attachShadow({ mode: "open" });
    const height = Number(this._config.height) || 400;
    root.innerHTML = `
      <link rel="stylesheet" href="${FRONTEND_BASE}/vendor/leaflet.css">
      <style>
        ha-card { overflow: hidden; }
        .wrap { position: relative; }
        #map { height: ${height}px; width: 100%; background: #dddddd; }
        #label {
          position: absolute; left: 8px; bottom: 8px; z-index: 1000;
          background: rgba(255, 255, 255, 0.85); color: #333;
          padding: 2px 8px; border-radius: 4px; font-size: 12px;
          font-family: var(--primary-font-family, sans-serif);
          pointer-events: none;
        }
        #error { padding: 16px; color: var(--error-color, #b71c1c); }
      </style>
      <ha-card>
        <div class="wrap">
          <div id="map"></div>
          <div id="label" hidden></div>
        </div>
        <div id="error" hidden></div>
      </ha-card>
    `;
  }

  _createMap(L) {
    const container = this.shadowRoot.getElementById("map");
    const center = this._config.center || [
      this._hass.config.latitude,
      this._hass.config.longitude,
    ];
    this._map = L.map(container, {
      center,
      zoom: this._config.zoom,
      preferCanvas: true,
      zoomSnap: 0.5,
    });
    L.tileLayer(TILE_URL, {
      attribution: ATTRIBUTION,
      minZoom: 6,
      maxZoom: 15,
    }).addTo(this._map);
    L.marker(center, {
      icon: L.divIcon({
        className: "",
        html: HOUSE_ICON_SVG,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      interactive: false,
    }).addTo(this._map);
    this._radarLayer = L.layerGroup().addTo(this._map);

    // The shadow-DOM stylesheet may finish loading after map creation; without
    // a recalc the tiles render misaligned.
    const link = this.shadowRoot.querySelector("link");
    link.addEventListener("load", () => this._map.invalidateSize());
    requestAnimationFrame(() => this._map.invalidateSize());
  }

  async _loadData(L) {
    const versions = await this._api("product/output/versions.json");
    const version = versions["precipitation/animation"];
    if (!version) throw new Error("versions.json has no precipitation/animation entry");
    const animation = await this._api(
      `product/output/precipitation/animation/version__${version}/de/animation.json`
    );
    const pictures = (animation.map_images && animation.map_images[0]
      ? animation.map_images[0].pictures
      : []) || [];
    const measurements = pictures.filter(
      (p) => p.data_type === "measurement" && p.radar_url
    );
    if (!measurements.length) throw new Error("no measurement frames in animation.json");
    const latest = measurements[measurements.length - 1];
    const frame = await this._api(latest.radar_url.replace(/^\/+/, ""));
    this._radarLayer.clearLayers();
    for (const poly of frameToPolygons(frame, L)) poly.addTo(this._radarLayer);
    const label = this.shadowRoot.getElementById("label");
    label.textContent = `Measurement ${latest.day} ${latest.timepoint}`;
    label.hidden = false;
  }

  _api(path) {
    return this._hass.callApi("GET", `${PROXY_BASE}/${path}`);
  }

  _showError(message) {
    const el = this.shadowRoot && this.shadowRoot.getElementById("error");
    if (el) {
      el.textContent = `MeteoSwiss Radar: ${message}`;
      el.hidden = false;
    }
  }
}

if (!customElements.get("meteoswiss-radar-card")) {
  customElements.define("meteoswiss-radar-card", MeteoSwissRadarCard);
}
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "meteoswiss-radar-card")) {
  window.customCards.push({
    type: "meteoswiss-radar-card",
    name: "MeteoSwiss Radar Card",
    description: "MeteoSwiss precipitation radar on a swisstopo map",
  });
}
console.info(
  `%c METEOSWISS-RADAR-CARD %c v${CARD_VERSION} `,
  "background:#d32f2f;color:#fff;padding:2px 4px;border-radius:2px 0 0 2px",
  "background:#555;color:#fff;padding:2px 4px;border-radius:0 2px 2px 0"
);
