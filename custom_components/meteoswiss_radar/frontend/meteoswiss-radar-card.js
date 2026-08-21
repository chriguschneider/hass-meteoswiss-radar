/* MeteoSwiss Radar Card
 * Precipitation radar animation on a swisstopo basemap, data from the
 * MeteoSwiss app API through the meteoswiss_radar integration's
 * authenticated proxy. Frame format: see FORMAT.md in the repository root.
 */

const CARD_VERSION = "0.2.0";
const FRONTEND_BASE = "/meteoswiss_radar/frontend";
const PROXY_BASE = "meteoswiss_radar/proxy"; // hass.callApi() prepends /api/

const TILE_URL =
  "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg";
const ATTRIBUTION = "Source: MeteoSwiss &middot; &copy; swisstopo";

const CACHE_SIZE = 130; // decoded frames kept in memory (LRU)
const PREFETCH_AHEAD = 6; // frames fetched ahead of the playhead
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // manifest re-check cadence
const COLOR_MEASUREMENT = "#90a4ae";
const COLOR_FORECAST = "#ffb74d";

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

const PLAY_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const PAUSE_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/></svg>';

class MeteoSwissRadarCard extends HTMLElement {
  constructor() {
    super();
    this._cache = new Map(); // radar_url -> [L.polygon]
    this._pending = new Map(); // radar_url -> Promise
    this._frames = [];
    this._frameIndex = 0;
    this._playing = false;
    this._lastManifest404Refresh = 0;
  }

  setConfig(config) {
    this._config = {
      height: 400,
      zoom: 8,
      frame_duration: 300,
      frame_stride: 1,
      ...(config || {}),
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeInit();
  }

  connectedCallback() {
    this._maybeInit();
    if (this._map) requestAnimationFrame(() => this._map.invalidateSize());
    if (this._frames.length && !this._refreshTimer) this._startRefreshTimer();
  }

  disconnectedCallback() {
    this._pause();
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  getCardSize() {
    return 7;
  }

  static getStubConfig() {
    return {};
  }

  _frameDurationMs() {
    const v = Number(this._config.frame_duration);
    return Number.isFinite(v) && v >= 50 ? v : 300;
  }

  _strideN() {
    const v = Math.floor(Number(this._config.frame_stride));
    return Number.isFinite(v) && v >= 1 ? v : 1;
  }

  async _maybeInit() {
    if (this._initialized || !this._hass || !this.isConnected) return;
    this._initialized = true;
    this._renderShell();
    try {
      this._L = await loadLeaflet();
      this._createMap(this._L);
      await this._loadData();
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
          background: rgba(255, 255, 255, 0.88); color: #333;
          padding: 2px 8px; border-radius: 4px; font-size: 12px;
          font-family: var(--primary-font-family, sans-serif);
          pointer-events: none;
        }
        #label[data-type="forecast"] {
          background: rgba(255, 183, 77, 0.92); color: #4e342e;
        }
        #timebar { height: 4px; background: var(--divider-color, #e0e0e0); }
        #controls {
          display: flex; align-items: center; gap: 10px; padding: 6px 12px 8px;
        }
        #play {
          display: flex; align-items: center; justify-content: center;
          width: 40px; height: 40px; flex: none;
          border: none; border-radius: 50%; cursor: pointer;
          background: var(--primary-color, #03a9f4); color: #fff;
        }
        #slider {
          flex: 1; min-width: 0; height: 28px; margin: 0; cursor: pointer;
          accent-color: var(--primary-color, #03a9f4);
        }
        #error { padding: 16px; color: var(--error-color, #b71c1c); }
      </style>
      <ha-card>
        <div class="wrap">
          <div id="map"></div>
          <div id="label" hidden></div>
        </div>
        <div id="timebar"></div>
        <div id="controls" hidden>
          <button id="play" aria-label="Play/Pause">${PLAY_SVG}</button>
          <input id="slider" type="range" min="0" max="0" step="1" value="0"
                 aria-label="Radar timeline">
        </div>
        <div id="error" hidden></div>
      </ha-card>
    `;
    this._label = root.getElementById("label");
    this._timebar = root.getElementById("timebar");
    this._controls = root.getElementById("controls");
    this._playBtn = root.getElementById("play");
    this._slider = root.getElementById("slider");
    this._playBtn.addEventListener("click", () => this._togglePlay());
    this._slider.addEventListener("input", (ev) =>
      this._onScrub(Number(ev.target.value))
    );
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

  /* ---------- data ---------- */

  async _loadData() {
    await this._refreshManifest(true);
    const idx = this._lastMeasurementIndex();
    await this._ensureFrame(this._frames[idx].url);
    this._showFrame(idx);
    this._prefetch(idx);
    this._controls.hidden = false;
    this._startRefreshTimer();
  }

  async _refreshManifest(force) {
    const versions = await this._api("product/output/versions.json");
    const version = versions["precipitation/animation"];
    if (!version) throw new Error("versions.json has no precipitation/animation entry");
    if (!force && version === this._animVersion) return;
    const animation = await this._api(
      `product/output/precipitation/animation/version__${version}/de/animation.json`
    );
    const pictures = (animation.map_images && animation.map_images[0]
      ? animation.map_images[0].pictures
      : []) || [];
    const frames = pictures
      .filter(
        (p) =>
          p.radar_url &&
          (p.data_type === "measurement" || p.data_type === "forecast")
      )
      .map((p) => ({
        url: p.radar_url.replace(/^\/+/, ""),
        type: p.data_type,
        day: p.day,
        timepoint: p.timepoint,
        ts: p.timestamp,
      }))
      .sort((a, b) => a.ts - b.ts);
    if (!frames.length) throw new Error("no frames in animation.json");

    const prevTs = this._frames[this._frameIndex]
      ? this._frames[this._frameIndex].ts
      : null;
    this._animVersion = version;
    this._frames = frames;
    this._slider.max = String(frames.length - 1);
    const measCount = frames.filter((f) => f.type === "measurement").length;
    const b = ((measCount / frames.length) * 100).toFixed(2);
    this._timebar.style.background =
      `linear-gradient(to right, ${COLOR_MEASUREMENT} 0%, ${COLOR_MEASUREMENT} ${b}%, ` +
      `${COLOR_FORECAST} ${b}%, ${COLOR_FORECAST} 100%)`;

    // Keep the playhead on the same moment across a manifest rollover.
    if (prevTs != null) {
      this._frameIndex = this._nearestIndexByTs(prevTs);
      this._slider.value = String(this._frameIndex);
    }
  }

  _lastMeasurementIndex() {
    for (let i = this._frames.length - 1; i >= 0; i--) {
      if (this._frames[i].type === "measurement") return i;
    }
    return this._frames.length - 1;
  }

  _nearestIndexByTs(ts) {
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < this._frames.length; i++) {
      const diff = Math.abs(this._frames[i].ts - ts);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }

  _startRefreshTimer() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(
      () => this._refreshManifest(false).catch(() => {}),
      REFRESH_INTERVAL_MS
    );
  }

  _cacheGet(url) {
    const v = this._cache.get(url);
    if (v) {
      this._cache.delete(url);
      this._cache.set(url, v);
    }
    return v;
  }

  _cachePut(url, v) {
    this._cache.set(url, v);
    while (this._cache.size > CACHE_SIZE) {
      this._cache.delete(this._cache.keys().next().value);
    }
  }

  _ensureFrame(url) {
    const cached = this._cacheGet(url);
    if (cached) return Promise.resolve(cached);
    const pending = this._pending.get(url);
    if (pending) return pending;
    const p = this._api(url)
      .then((frame) => {
        const polys = frameToPolygons(frame, this._L);
        this._pending.delete(url);
        this._cachePut(url, polys);
        return polys;
      })
      .catch((err) => {
        this._pending.delete(url);
        // A vanished frame usually means the manifest rolled over upstream.
        if (this._is404(err)) this._refreshAfter404();
        throw err;
      });
    this._pending.set(url, p);
    return p;
  }

  _is404(err) {
    return (
      (err && (err.status_code === 404 || err.code === 404)) ||
      /404/.test(String((err && (err.message || err.error)) || ""))
    );
  }

  _refreshAfter404() {
    const now = Date.now();
    if (now - this._lastManifest404Refresh < 60000) return;
    this._lastManifest404Refresh = now;
    this._refreshManifest(true).catch(() => {});
  }

  /* ---------- playback ---------- */

  _togglePlay() {
    if (this._playing) this._pause();
    else this._play();
  }

  _play() {
    if (this._playing || !this._frames.length) return;
    this._playing = true;
    this._playBtn.innerHTML = PAUSE_SVG;
    this._lastStepTs = performance.now();
    const loop = (ts) => {
      if (!this._playing) return;
      this._raf = requestAnimationFrame(loop);
      if (ts - this._lastStepTs >= this._frameDurationMs()) {
        this._lastStepTs = ts;
        this._advance();
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  _pause() {
    this._playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this._playBtn) this._playBtn.innerHTML = PLAY_SVG;
  }

  _advance() {
    if (!this._frames.length) return;
    const next = (this._frameIndex + this._strideN()) % this._frames.length;
    const f = this._frames[next];
    const polys = this._cacheGet(f.url);
    if (!polys) {
      // Hold the current frame until the next one is decoded.
      this._ensureFrame(f.url).catch(() => {});
      return;
    }
    this._showFrame(next);
    this._prefetch(next);
  }

  _onScrub(idx) {
    this._pause();
    this._scrubTarget = idx;
    const f = this._frames[idx];
    if (!f) return;
    if (this._cacheGet(f.url)) {
      this._showFrame(idx);
      this._prefetch(idx);
      return;
    }
    this._ensureFrame(f.url)
      .then(() => {
        if (this._scrubTarget === idx) {
          this._showFrame(idx);
          this._prefetch(idx);
        }
      })
      .catch(() => {});
  }

  _prefetch(idx) {
    const s = this._strideN();
    for (let k = 1; k <= PREFETCH_AHEAD; k++) {
      const f = this._frames[(idx + k * s) % this._frames.length];
      if (f) this._ensureFrame(f.url).catch(() => {});
    }
  }

  _showFrame(idx) {
    const f = this._frames[idx];
    const polys = this._cacheGet(f.url);
    if (!polys || !this._map) return;
    this._frameIndex = idx;
    this._radarLayer.clearLayers();
    for (const p of polys) p.addTo(this._radarLayer);
    this._slider.value = String(idx);
    this._label.textContent = `${
      f.type === "measurement" ? "Measurement" : "Forecast"
    } · ${f.day} ${f.timepoint}`;
    this._label.dataset.type = f.type;
    this._label.hidden = false;
  }

  /* ---------- misc ---------- */

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

/* HA (2026.8+) swaps window.customElements for a scoped-registry polyfill
 * during app boot. This module loads early (add_extra_js_url), so a define
 * issued immediately can land in the native registry before the swap — the
 * polyfill's get()/whenDefined() never see it and Lovelace renders "Custom
 * element doesn't exist". Gate the define on the app's root element: once
 * <home-assistant> is defined, the final registry is in place. Standalone
 * pages (dev harness) have no <home-assistant> and define immediately. */
function defineCard() {
  if (!window.customElements.get("meteoswiss-radar-card")) {
    window.customElements.define("meteoswiss-radar-card", MeteoSwissRadarCard);
  }
}

function defineWhenRegistryReady() {
  if (document.querySelector("home-assistant")) {
    Promise.race([
      customElements.whenDefined("home-assistant"),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]).then(defineCard);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", defineWhenRegistryReady, {
      once: true,
    });
  } else {
    defineCard();
  }
}

defineWhenRegistryReady();
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "meteoswiss-radar-card")) {
  window.customCards.push({
    type: "meteoswiss-radar-card",
    name: "MeteoSwiss Radar Card",
    description: "MeteoSwiss precipitation radar animation on a swisstopo map",
  });
}
console.info(
  `%c METEOSWISS-RADAR-CARD %c v${CARD_VERSION} `,
  "background:#d32f2f;color:#fff;padding:2px 4px;border-radius:2px 0 0 2px",
  "background:#555;color:#fff;padding:2px 4px;border-radius:0 2px 2px 0"
);
