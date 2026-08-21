/* MeteoSwiss Radar Card
 * Precipitation radar animation on a swisstopo basemap, data from the
 * MeteoSwiss app API through the meteoswiss_radar integration's
 * authenticated proxy. Frame format: see FORMAT.md in the repository root.
 */

const CARD_VERSION = "0.4.0";
const FRONTEND_BASE = "/meteoswiss_radar/frontend";
const PROXY_BASE = "meteoswiss_radar/proxy"; // hass.callApi() prepends /api/

const TILE_URL =
  "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg";
const ATTRIBUTION = "Source: MeteoSwiss &middot; &copy; swisstopo";

const CACHE_SIZE = 130; // decoded frames kept in memory (LRU)
const PATH_CACHE_SIZE = 130; // projected Path2D sets per view (LRU)
const PREFETCH_AHEAD = 6; // frames fetched ahead of the playhead
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // manifest re-check cadence
const FAIL_STREAK_LIMIT = 8; // consecutive frame failures before degrading
const INTENSITY_QUEUE_GAP_MS = 60; // pause between background intensity loads
const COLOR_MEASUREMENT = "#90a4ae";
const COLOR_FORECAST = "#ffb74d";
const COLOR_PLAYHEAD = "#0277bd";
const COLOR_NOW = "#d32f2f";
const RADAR_OPACITY = 0.75;
const BAR_HEIGHT = 52;

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

/* Decode a frame into view-independent geometry: one entry per intensity
 * band, each shape an array of rings (ring 0 outer, later rings holes). */
function decodeFrame(frame) {
  const c = frame.coords;
  const grid = {
    xMin: c.x_min,
    xSpan: c.x_max - c.x_min,
    xCount: c.x_count,
    yMin: c.y_min,
    ySpan: c.y_max - c.y_min,
    yCount: c.y_count,
  };
  return frame.areas.map((area) => ({
    color: `#${area.color}`,
    shapes: area.shapes.map((shape) =>
      shape.map((ct) => decodeContour(ct, grid))
    ),
  }));
}

/* Even-odd ray cast across all rings of one shape (holes included).
 * Containment is topological, so testing in lat/lng space is exact. */
function pointInShape(shape, lat, lng) {
  let inside = false;
  for (const ring of shape) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0];
      const xi = ring[i][1];
      const yj = ring[j][0];
      const xj = ring[j][1];
      if (
        yi > lat !== yj > lat &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/* Highest intensity band containing the point, or null when dry.
 * Bar height maps the band's position on the legend scale. */
function bandAtPoint(areas, lat, lng) {
  for (let i = areas.length - 1; i >= 0; i--) {
    for (const shape of areas[i].shapes) {
      if (pointInShape(shape, lat, lng)) {
        return { color: areas[i].color, frac: (i + 1) / areas.length };
      }
    }
  }
  return null;
}

function relTime(ts) {
  const diffMin = Math.round((ts * 1000 - Date.now()) / 60000);
  const abs = Math.abs(diffMin);
  if (abs < 1) return "now";
  let span;
  if (abs < 60) span = `${abs} min`;
  else {
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    span = h < 10 && m ? `${h} h ${m} min` : `${h} h`;
  }
  return diffMin > 0 ? `in ${span}` : `${span} ago`;
}

function weekdayShort(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-GB", { weekday: "short" });
}

/* Canvas layer that caches projected Path2D sets per frame and view.
 * Replaying a cached frame is one clearRect plus ~11 native fills. */
function makeRadarLayerClass(L) {
  return L.Layer.extend({
    initialize() {
      this._pathCache = new Map(); // url -> [{color, path}]
    },

    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create("canvas", "leaflet-zoom-hide");
      this._canvas.style.pointerEvents = "none";
      map.getPane("overlayPane").appendChild(this._canvas);
      map.on("moveend zoomend resize viewreset", this._reset, this);
      this._reset();
      return this;
    },

    onRemove(map) {
      map.off("moveend zoomend resize viewreset", this._reset, this);
      L.DomUtil.remove(this._canvas);
    },

    setFrame(url, areas) {
      this._url = url;
      this._areas = areas;
      this._redraw();
    },

    _viewKey() {
      const o = this._map.getPixelOrigin();
      return `${this._map.getZoom()}:${o.x}:${o.y}`;
    },

    _reset() {
      const key = this._viewKey();
      if (key !== this._key) {
        this._key = key;
        this._pathCache.clear(); // layer-point space changed
      }
      const size = this._map.getSize();
      if (this._canvas.width !== size.x) this._canvas.width = size.x;
      if (this._canvas.height !== size.y) this._canvas.height = size.y;
      this._origin = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, this._origin);
      this._redraw();
    },

    _getPaths(url, areas) {
      let paths = this._pathCache.get(url);
      if (paths) {
        this._pathCache.delete(url);
        this._pathCache.set(url, paths);
        return paths;
      }
      const map = this._map;
      paths = areas.map((area) => {
        const path = new Path2D();
        for (const shape of area.shapes) {
          for (const ring of shape) {
            for (let i = 0; i < ring.length; i++) {
              const pt = map.latLngToLayerPoint(ring[i]);
              if (i === 0) path.moveTo(pt.x, pt.y);
              else path.lineTo(pt.x, pt.y);
            }
            path.closePath();
          }
        }
        return { color: area.color, path };
      });
      this._pathCache.set(url, paths);
      while (this._pathCache.size > PATH_CACHE_SIZE) {
        this._pathCache.delete(this._pathCache.keys().next().value);
      }
      return paths;
    },

    _redraw() {
      if (!this._canvas || !this._map) return;
      const ctx = this._canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      if (!this._areas || !this._url) return;
      ctx.setTransform(1, 0, 0, 1, -this._origin.x, -this._origin.y);
      ctx.globalAlpha = RADAR_OPACITY;
      for (const p of this._getPaths(this._url, this._areas)) {
        ctx.fillStyle = p.color;
        ctx.fill(p.path, "evenodd");
      }
    },
  });
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
    this._cache = new Map(); // radar_url -> decoded areas
    this._pending = new Map(); // radar_url -> Promise
    this._intensity = new Map(); // radar_url -> {color, frac} | null | false
    this._frames = [];
    this._frameIndex = 0;
    this._playing = false;
    this._failStreak = 0;
    this._dataReady = false;
    this._lastManifest404Refresh = 0;
  }

  setConfig(config) {
    this._config = {
      height: 400,
      zoom: 8,
      frame_duration: 300,
      frame_stride: 1,
      autoplay: false,
      legend: true,
      rain_bars: true,
      time_axis: true,
      time_bubble: true,
      large_label: true,
      progress_bar: true,
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
    if (this._initialized && !this._refreshTimer) this._startRefreshTimer();
    if (this._dataReady) this._runIntensityQueue();
  }

  disconnectedCallback() {
    this._pause();
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._labelTicker) {
      clearInterval(this._labelTicker);
      this._labelTicker = null;
    }
  }

  getCardSize() {
    return this._config && this._config.rain_bars ? 8 : 7;
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
    } catch (err) {
      // Vendored asset missing/broken — not recoverable at runtime.
      this._showError(err.message || String(err));
      return;
    }
    try {
      await this._loadData();
    } catch (err) {
      console.warn("meteoswiss-radar-card: initial data load failed:", err);
      this._showBanner("Radar data is currently unavailable");
    }
    this._startRefreshTimer();
    if (this._config.large_label && !this._labelTicker) {
      // Keep the relative time fresh while paused.
      this._labelTicker = setInterval(() => this._updateLabel(), 60000);
    }
  }

  _renderShell() {
    const root = this.attachShadow({ mode: "open" });
    const c = this._config;
    const height = Number(c.height) || 400;
    root.innerHTML = `
      <link rel="stylesheet" href="${FRONTEND_BASE}/vendor/leaflet.css">
      <style>
        ha-card { overflow: hidden; }
        .wrap { position: relative; }
        #map {
          height: ${height}px; width: 100%;
          background: var(--card-background-color, #dddddd);
        }
        #label {
          position: absolute; left: 8px; bottom: 28px; z-index: 1000;
          background: var(--card-background-color, rgba(255, 255, 255, 0.88));
          color: var(--primary-text-color, #333);
          padding: ${c.large_label ? "4px 10px" : "2px 8px"};
          border-radius: ${c.large_label ? "6px" : "4px"};
          font-size: 12px;
          font-family: var(--primary-font-family, sans-serif);
          opacity: 0.94; pointer-events: none;
        }
        #label .l1 { font-size: ${c.large_label ? "15px" : "12px"};
          font-weight: ${c.large_label ? "700" : "400"}; }
        #label .l2 { font-size: 11px; }
        #label[data-type="forecast"] {
          background: ${COLOR_FORECAST}; color: #4e342e; opacity: 0.96;
        }
        #banner {
          position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
          z-index: 1000; max-width: 90%;
          background: var(--warning-color, #ffa600); color: #fff;
          padding: 4px 12px; border-radius: 4px; font-size: 12px;
          font-family: var(--primary-font-family, sans-serif);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); pointer-events: none;
        }
        #timebar {
          position: relative; height: ${c.progress_bar ? "7px" : "4px"};
          background: var(--divider-color, #e0e0e0);
        }
        #elapsed {
          position: absolute; left: 0; top: 0; bottom: 0; width: 0;
          background: rgba(2, 60, 90, 0.30); pointer-events: none;
        }
        #tbdot {
          position: absolute; top: 50%; width: 13px; height: 13px;
          border-radius: 50%; background: #fff;
          border: 3px solid ${COLOR_PLAYHEAD};
          transform: translate(-50%, -50%);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); pointer-events: none;
        }
        #controls {
          display: flex; align-items: center; gap: 10px;
          padding: ${c.time_bubble ? "30px" : "8px"} 12px 4px;
        }
        #play {
          position: absolute; right: 8px; bottom: 8px; z-index: 1000;
          display: flex; align-items: center; justify-content: center;
          width: 44px; height: 44px;
          border: none; border-radius: 50%; cursor: pointer;
          background: var(--primary-color, #03a9f4); color: #fff;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
        }
        #sliderwrap { position: relative; flex: 1; min-width: 0; }
        #slider {
          width: 100%; height: 28px; margin: 0; cursor: pointer;
          accent-color: var(--primary-color, #03a9f4); display: block;
        }
        #barswrap { position: relative; flex: 1; min-width: 0; }
        #bars {
          display: block; width: 100%; height: ${BAR_HEIGHT}px;
          cursor: pointer; touch-action: none;
          border-bottom: 1px solid var(--divider-color, #dadce0);
        }
        #bubble {
          position: absolute; top: -26px; transform: translateX(-50%);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #333);
          font-size: 12px; font-weight: 600; padding: 2px 8px;
          border-radius: 5px; white-space: nowrap;
          font-family: var(--primary-font-family, sans-serif);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
          pointer-events: none; z-index: 2;
        }
        #bubble[data-type="forecast"] { background: ${COLOR_FORECAST}; color: #4e342e; }
        #bubble:after {
          content: ""; position: absolute; left: 50%; bottom: -5px;
          transform: translateX(-50%);
          border: 5px solid transparent; border-bottom: none;
          border-top-color: var(--card-background-color, #fff);
        }
        #bubble[data-type="forecast"]:after { border-top-color: ${COLOR_FORECAST}; }
        #axisrow {
          position: relative; height: 26px;
          margin: 2px 12px 0 12px;
          font-family: var(--primary-font-family, sans-serif);
        }
        #axisrow .tick {
          position: absolute; top: 0; width: 1px; height: 5px;
          background: var(--secondary-text-color, #9aa0a6);
        }
        #axisrow .tlab {
          position: absolute; top: 5px; font-size: 9px;
          color: var(--secondary-text-color, #5f6368);
          transform: translateX(-50%);
        }
        #axisrow .dlab {
          position: absolute; top: 15px; font-size: 9px; font-weight: 700;
          color: var(--primary-text-color, #202124);
          transform: translateX(-50%);
        }
        #axisrow .nowlab {
          position: absolute; top: 15px; transform: translateX(-50%);
          font-size: 9px; font-weight: 700; color: ${COLOR_NOW};
        }
        #legend {
          display: flex; align-items: flex-end; gap: 8px;
          padding: 4px 12px 8px;
          font-family: var(--primary-font-family, sans-serif);
        }
        #cells { display: flex; flex: 1; }
        #cells .cell { flex: 1; min-width: 0; }
        #cells .cell i { display: block; height: 8px; border-radius: 1px; }
        #cells .cell b {
          display: block; font-weight: normal; font-size: 9px;
          color: var(--secondary-text-color, #666); text-align: left;
        }
        #unit, #modehint {
          flex: none; font-size: 9px;
          color: var(--secondary-text-color, #666);
        }
        #modehint { color: var(--warning-color, #b26a00); }
        #error { padding: 16px; color: var(--error-color, #b71c1c); }
        [hidden] { display: none !important; }
      </style>
      <ha-card>
        <div class="wrap">
          <div id="map"></div>
          <div id="label" hidden></div>
          <div id="banner" hidden></div>
          <button id="play" aria-label="Play/Pause" hidden>${PLAY_SVG}</button>
        </div>
        <div id="timebar">
          <div id="elapsed" hidden></div>
          <div id="tbdot" hidden></div>
        </div>
        <div id="controls" hidden>
          <div id="sliderwrap" ${c.rain_bars ? "hidden" : ""}>
            <input id="slider" type="range" min="0" max="0" step="1" value="0"
                   aria-label="Radar timeline">
          </div>
          <div id="barswrap" ${c.rain_bars ? "" : "hidden"}>
            <canvas id="bars" height="${BAR_HEIGHT}"></canvas>
          </div>
        </div>
        <div id="axisrow" hidden></div>
        <div id="legend" hidden>
          <div id="cells"></div>
          <span id="modehint" hidden>measurement only</span>
          <span id="unit">mm/h</span>
        </div>
        <div id="error" hidden></div>
      </ha-card>
    `;
    this._label = root.getElementById("label");
    this._banner = root.getElementById("banner");
    this._timebar = root.getElementById("timebar");
    this._elapsed = root.getElementById("elapsed");
    this._tbDot = root.getElementById("tbdot");
    this._controls = root.getElementById("controls");
    this._playBtn = root.getElementById("play");
    this._slider = root.getElementById("slider");
    this._barsWrap = root.getElementById("barswrap");
    this._barCanvas = root.getElementById("bars");
    this._axisRow = root.getElementById("axisrow");
    this._legendEl = root.getElementById("legend");
    this._cellsEl = root.getElementById("cells");
    this._modeHint = root.getElementById("modehint");
    this._playBtn.addEventListener("click", () => this._togglePlay());
    this._slider.addEventListener("input", (ev) =>
      this._onScrub(Number(ev.target.value))
    );
    if (c.time_bubble) {
      this._bubble = document.createElement("div");
      this._bubble.id = "bubble";
      this._bubble.hidden = true;
      (c.rain_bars ? this._barsWrap : root.getElementById("sliderwrap")).appendChild(
        this._bubble
      );
    }
    if (c.rain_bars) {
      const scrubFromEvent = (ev) => {
        const rect = this._barCanvas.getBoundingClientRect();
        const frac = Math.min(
          1,
          Math.max(0, (ev.clientX - rect.left) / rect.width)
        );
        const idx = Math.round(frac * (this._frames.length - 1));
        if (Number.isFinite(idx) && this._frames.length) this._onScrub(idx);
      };
      this._barCanvas.addEventListener("pointerdown", (ev) => {
        try {
          this._barCanvas.setPointerCapture(ev.pointerId);
        } catch (e) {
          // synthetic events carry no active pointer — scrubbing still works
        }
        this._barScrubbing = true;
        scrubFromEvent(ev);
      });
      this._barCanvas.addEventListener("pointermove", (ev) => {
        if (this._barScrubbing) scrubFromEvent(ev);
      });
      this._barCanvas.addEventListener("pointerup", () => {
        this._barScrubbing = false;
      });
    }
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
      zoomSnap: 0.5,
      attributionControl: false,
    });
    // Bottom-right is occupied by the floating play button.
    L.control
      .attribution({ position: "bottomleft", prefix: false })
      .addTo(this._map);
    L.tileLayer(TILE_URL, {
      attribution: ATTRIBUTION,
      minZoom: 6,
      maxZoom: 15,
    }).addTo(this._map);
    L.marker([this._hass.config.latitude, this._hass.config.longitude], {
      icon: L.divIcon({
        className: "",
        html: HOUSE_ICON_SVG,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      interactive: false,
    }).addTo(this._map);
    const RadarLayer = makeRadarLayerClass(L);
    this._radar = new RadarLayer().addTo(this._map);

    // The shadow-DOM stylesheet may finish loading after map creation; without
    // a recalc the tiles render misaligned.
    const link = this.shadowRoot.querySelector("link");
    link.addEventListener("load", () => this._map.invalidateSize());
    requestAnimationFrame(() => this._map.invalidateSize());
  }

  /* ---------- data ---------- */

  async _loadData() {
    await this._refreshManifest(true);
    this._dataReady = true;
    this._hideBanner();
    const idx = this._lastMeasurementIndex();
    await this._ensureFrame(this._frames[idx].url);
    this._showFrame(idx);
    this._prefetch(idx);
    this._controls.hidden = false;
    this._playBtn.hidden = false;
    this._runIntensityQueue();
    if (this._config.autoplay && !this._autoplayStarted) {
      this._autoplayStarted = true;
      this._play();
    }
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
    let frames = pictures
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

    frames = this._applyTimeSpan(frames);

    const prevTs = this._frames[this._frameIndex]
      ? this._frames[this._frameIndex].ts
      : null;
    this._animVersion = version;
    this._frames = frames;
    this._slider.max = String(frames.length - 1);
    const measCount = frames.filter((f) => f.type === "measurement").length;
    this._measFraction = measCount / frames.length;
    const b = (this._measFraction * 100).toFixed(2);
    this._timebar.style.background =
      `linear-gradient(to right, ${COLOR_MEASUREMENT} 0%, ${COLOR_MEASUREMENT} ${b}%, ` +
      `${COLOR_FORECAST} ${b}%, ${COLOR_FORECAST} 100%)`;
    this._modeHint.hidden = measCount !== frames.length;
    this._renderLegend(animation.legend);
    this._buildAxis();

    // Drop cached intensities for frames no longer on the timeline.
    const urls = new Set(frames.map((f) => f.url));
    for (const key of [...this._intensity.keys()]) {
      if (!urls.has(key)) this._intensity.delete(key);
    }
    this._runIntensityQueue();

    // Keep the playhead on the same moment across a manifest rollover.
    if (prevTs != null) {
      this._frameIndex = this._nearestIndexByTs(prevTs);
      this._slider.value = String(this._frameIndex);
    }
    this._repaintBars();
  }

  /* past_hours / forecast_hours config: trim the timeline around the most
   * recent measurement. forecast_hours: 0 gives a measurement-only card. */
  _applyTimeSpan(frames) {
    const past = Number(this._config.past_hours);
    const forecast = Number(this._config.forecast_hours);
    const hasPast = Number.isFinite(past) && past >= 0;
    const hasForecast = Number.isFinite(forecast) && forecast >= 0;
    if (!hasPast && !hasForecast) return frames;
    const lastMeas = frames.filter((f) => f.type === "measurement").pop();
    const anchor = lastMeas ? lastMeas.ts : frames[frames.length - 1].ts;
    const kept = frames.filter((f) => {
      if (f.type === "measurement") {
        return !hasPast || f.ts >= anchor - past * 3600;
      }
      return !hasForecast || f.ts <= anchor + forecast * 3600;
    });
    if (kept.length) return kept;
    return lastMeas ? [lastMeas] : frames.slice(-1);
  }

  _renderLegend(legend) {
    if (
      this._config.legend === false ||
      !Array.isArray(legend) ||
      !legend.length
    ) {
      this._legendEl.hidden = true;
      return;
    }
    const bands = [...legend].sort((a, b) => (a.min || 0) - (b.min || 0));
    this._cellsEl.textContent = "";
    for (const band of bands) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const chip = document.createElement("i");
      chip.style.background = String(band.color);
      const tick = document.createElement("b");
      tick.textContent = String(band.min || 0);
      cell.appendChild(chip);
      cell.appendChild(tick);
      this._cellsEl.appendChild(cell);
    }
    this._legendEl.hidden = false;
  }

  /* Hour ticks (labels every 6 h), day labels below, red "now" marker at
   * the measurement/forecast boundary. Fractions of the frame timeline. */
  _buildAxis() {
    if (!this._config.time_axis || this._frames.length < 2) {
      this._axisRow.hidden = true;
      return;
    }
    const frames = this._frames;
    const t0 = frames[0].ts;
    const t1 = frames[frames.length - 1].ts;
    const span = t1 - t0;
    this._axisRow.textContent = "";
    const firstHour = Math.ceil(t0 / 3600) * 3600;
    for (let t = firstHour; t <= t1; t += 3600) {
      const x = ((t - t0) / span) * 100;
      const d = new Date(t * 1000);
      const hour = d.getHours();
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = x + "%";
      if (hour % 6 !== 0) tick.style.height = "3px";
      this._axisRow.appendChild(tick);
      if (hour % 6 === 0) {
        const lab = document.createElement("div");
        lab.className = "tlab";
        lab.style.left = x + "%";
        lab.textContent = String(hour).padStart(2, "0") + ":00";
        this._axisRow.appendChild(lab);
        if (hour === 0) {
          const day = document.createElement("div");
          day.className = "dlab";
          day.style.left = x + "%";
          day.textContent =
            weekdayShort(t) + " " + String(d.getDate()).padStart(2, "0") + ".";
          this._axisRow.appendChild(day);
        }
      }
    }
    const nowTs = frames[Math.round(this._measFraction * frames.length) - 1];
    const nowX = this._measFraction * 100;
    const nowLab = document.createElement("div");
    nowLab.className = "nowlab";
    nowLab.style.left = nowX + "%";
    nowLab.textContent = "▲ now";
    this._axisRow.appendChild(nowLab);
    this._axisRow.hidden = false;
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
    this._refreshTimer = setInterval(async () => {
      try {
        if (this._dataReady) {
          await this._refreshManifest(false);
        } else {
          await this._loadData(); // initial load failed — keep retrying
        }
      } catch (err) {
        // Degraded state stays; next tick retries. Existing frames keep
        // playing from cache even when the manifest refresh fails.
      }
    }, REFRESH_INTERVAL_MS);
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
        const areas = decodeFrame(frame);
        this._pending.delete(url);
        this._cachePut(url, areas);
        this._failStreak = 0;
        if (this._dataReady) this._hideBanner();
        return areas;
      })
      .catch((err) => {
        this._pending.delete(url);
        this._failStreak += 1;
        // A vanished frame usually means the manifest rolled over upstream.
        if (this._is404(err)) this._refreshAfter404();
        if (this._failStreak >= FAIL_STREAK_LIMIT) {
          if (this._playing) this._pause();
          this._showBanner("Radar frames unavailable — retrying");
        }
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

  /* ---------- rain bars at the home location ---------- */

  /* Background queue: fetch every frame once, compute the intensity band at
   * the house, keep only the tiny result. Uses the shared decode cache when
   * a frame is already loaded but never evicts playback frames for this. */
  async _runIntensityQueue() {
    if (!this._config.rain_bars || this._intensityRunning) return;
    this._intensityRunning = true;
    let sinceRepaint = 0;
    try {
      while (this.isConnected && this._config.rain_bars) {
        const frame = this._frames.find((f) => !this._intensity.has(f.url));
        if (!frame) break;
        try {
          let areas = this._cache.get(frame.url);
          if (!areas) {
            areas = decodeFrame(await this._api(frame.url));
          }
          this._intensity.set(
            frame.url,
            bandAtPoint(
              areas,
              this._hass.config.latitude,
              this._hass.config.longitude
            )
          );
        } catch (err) {
          this._intensity.set(frame.url, false); // failed — render as gap
        }
        if (++sinceRepaint >= 5) {
          sinceRepaint = 0;
          this._repaintBars();
        }
        await new Promise((r) => setTimeout(r, INTENSITY_QUEUE_GAP_MS));
      }
    } finally {
      this._intensityRunning = false;
      this._repaintBars();
    }
  }

  _repaintBars() {
    const cv = this._barCanvas;
    if (!cv || !this._config.rain_bars || !this._frames.length) return;
    const w = cv.clientWidth || cv.width;
    if (cv.width !== w) cv.width = w;
    const h = BAR_HEIGHT;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    const n = this._frames.length;
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const info = this._intensity.get(this._frames[i].url);
      if (!info) continue;
      const bh = Math.max(3, info.frac * (h - 10));
      ctx.fillStyle = info.color;
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.4), bh);
    }
    // red dashed "now" line at the measurement/forecast boundary
    if (this._measFraction < 1) {
      const nx = Math.round(this._measFraction * w) + 0.5;
      ctx.strokeStyle = COLOR_NOW;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(nx, 0);
      ctx.lineTo(nx, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // blue playhead
    const px = Math.round(((this._frameIndex + 0.5) / n) * w) + 0.5;
    ctx.strokeStyle = COLOR_PLAYHEAD;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
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
    const areas = this._cacheGet(f.url);
    if (!areas) {
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
    this._moveMarkers(idx); // markers track the finger even before decode
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
    const areas = this._cacheGet(f.url);
    if (!areas || !this._radar) return;
    this._frameIndex = idx;
    this._radar.setFrame(f.url, areas);
    this._moveMarkers(idx);
  }

  /* Slider, timebar progress, bubble, bars playhead and label for idx. */
  _moveMarkers(idx) {
    const f = this._frames[idx];
    if (!f) return;
    this._frameIndex = idx;
    this._slider.value = String(idx);
    this._updateLabel();
    const frac = this._frames.length > 1 ? idx / (this._frames.length - 1) : 0;
    if (this._config.progress_bar) {
      this._elapsed.style.width = (frac * 100).toFixed(2) + "%";
      this._tbDot.style.left = (frac * 100).toFixed(2) + "%";
      this._elapsed.hidden = false;
      this._tbDot.hidden = false;
    }
    if (this._bubble) {
      const x = Math.min(94, Math.max(6, frac * 100));
      this._bubble.style.left = x + "%";
      this._bubble.textContent = `${weekdayShort(f.ts)} ${f.timepoint}`;
      this._bubble.dataset.type = f.type;
      this._bubble.hidden = false;
    }
    this._repaintBars();
  }

  _updateLabel() {
    const f = this._frames[this._frameIndex];
    if (!f || !this._label) return;
    const type = f.type === "measurement" ? "Measurement" : "Forecast";
    if (this._config.large_label) {
      this._label.textContent = "";
      const l1 = document.createElement("div");
      l1.className = "l1";
      l1.textContent = `${weekdayShort(f.ts)} ${f.day.slice(0, 6)} · ${f.timepoint}`;
      const l2 = document.createElement("div");
      l2.className = "l2";
      l2.textContent = `${type} · ${relTime(f.ts)}`;
      this._label.appendChild(l1);
      this._label.appendChild(l2);
    } else {
      this._label.textContent = `${type} · ${f.day} ${f.timepoint}`;
    }
    this._label.dataset.type = f.type;
    this._label.hidden = false;
  }

  /* ---------- status UI ---------- */

  _showBanner(message) {
    if (!this._banner) return;
    this._banner.textContent = message;
    this._banner.hidden = false;
  }

  _hideBanner() {
    if (this._banner) this._banner.hidden = true;
  }

  _showError(message) {
    const el = this.shadowRoot && this.shadowRoot.getElementById("error");
    if (el) {
      el.textContent = `MeteoSwiss Radar: ${message}`;
      el.hidden = false;
    }
  }

  _api(path) {
    return this._hass.callApi("GET", `${PROXY_BASE}/${path}`);
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
