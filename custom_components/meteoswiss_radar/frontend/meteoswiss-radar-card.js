/* MeteoSwiss Radar Card
 * Precipitation radar animation on a swisstopo basemap, data from the
 * MeteoSwiss app API through the meteoswiss_radar integration's
 * authenticated proxy. Frame format: see FORMAT.md in the repository root.
 */

const CARD_VERSION = "0.7.3";
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
const COLOR_FORECAST = "#ffb74d"; // forecast label chip
const RADAR_OPACITY = 0.75;

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
    this._frames = [];
    this._frameIndex = 0;
    this._playing = false;
    this._playMode = "paused";
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
      autoplay_mode: "off",
      play_past_hours: 1,
      play_forecast_hours: 8,
      legend: true,
      attribution: true,
      time_axis: true,
      large_label: true,
      ...(config || {}),
    };
    if ((config || {}).autoplay === true && !(config || {}).autoplay_mode) {
      this._config.autoplay_mode = "full"; // legacy autoplay: true
    }
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeInit();
  }

  connectedCallback() {
    this._maybeInit();
    if (this._map) requestAnimationFrame(() => this._map.invalidateSize());
    if (this._initialized && !this._refreshTimer) this._startRefreshTimer();
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

  static getConfigElement() {
    return document.createElement("meteoswiss-radar-card-editor");
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
          position: absolute; left: 8px; bottom: 8px; z-index: 1000;
          background: #b5c2c9; color: #263238;
          padding: 4px 10px; border-radius: 6px;
          font-size: 12px;
          font-family: var(--primary-font-family, sans-serif);
          opacity: 0.95; pointer-events: none;
        }
        #label .l1 { font-size: ${c.large_label ? "15px" : "12px"};
          font-weight: ${c.large_label ? "700" : "600"}; }
        #label .l2 { font-size: 11px; opacity: 0.9; }
        #label[data-type="forecast"] {
          background: #c1eafc; color: #01579b;
        }
        #banner {
          position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
          z-index: 1000; max-width: 90%;
          background: var(--warning-color, #ffa600); color: #fff;
          padding: 4px 12px; border-radius: 4px; font-size: 12px;
          font-family: var(--primary-font-family, sans-serif);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); pointer-events: none;
        }
        #timeline {
          padding: 10px 12px 8px;
          font-family: var(--primary-font-family, sans-serif);
        }
        #trackwrap { padding: 6px 0; cursor: pointer; touch-action: none; }
        #track { position: relative; height: 6px; border-radius: 3px; }
        #track .zone { position: absolute; top: 0; bottom: 0; }
        #tmeas { left: 0; background: #78909c; opacity: 0.55; border-radius: 3px 0 0 3px; }
        #tfc { right: 0; background: #4fc3f7; opacity: 0.35; border-radius: 0 3px 3px 0; }
        #telapsed {
          position: absolute; left: 0; top: 0; bottom: 0; width: 0;
          background: var(--primary-color, #03a9f4); border-radius: 3px;
        }
        #tnow {
          position: absolute; top: -13px; width: 0; height: 0;
          transform: translateX(-50%);
          border: 9px solid transparent; border-bottom: none;
          border-top-color: #f44336;
          pointer-events: none; z-index: 2;
        }
        #knob {
          position: absolute; top: 50%; left: 0; width: 16px; height: 16px;
          border-radius: 50%; background: var(--primary-color, #03a9f4);
          border: 2px solid #fff; box-sizing: border-box;
          transform: translate(-50%, -50%);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4); pointer-events: none;
        }
        #hoursrow { position: relative; height: 15px; margin-top: 4px; }
        #hoursrow .hsep {
          position: absolute; top: 1px; height: 12px; width: 1px;
          background: var(--secondary-text-color, #999); opacity: 0.35;
        }
        #hoursrow b {
          position: absolute; top: 1px;
          font-size: 11px; font-weight: 400;
          color: var(--secondary-text-color, #666); white-space: nowrap;
        }
        #datesrow { position: relative; height: 15px; }
        #datesrow .daysep {
          position: absolute; top: -19px; bottom: 1px; width: 1.5px;
          background: var(--secondary-text-color, #999); opacity: 0.65;
        }
        #datesrow b {
          position: absolute; top: 1px;
          font-size: 10.5px; font-weight: 700;
          color: var(--primary-text-color, #333); white-space: nowrap;
        }
        #play {
          position: absolute; right: 8px; bottom: 8px; z-index: 1000;
          display: flex; align-items: center; justify-content: center;
          width: 44px; height: 44px;
          border: none; border-radius: 50%; cursor: pointer;
          background: var(--primary-color, #03a9f4); color: #fff;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
        }
        #play b.mode {
          position: absolute; right: -3px; bottom: -3px;
          font-size: 8px; font-weight: 700; line-height: 1;
          background: #fff; color: var(--primary-color, #03a9f4);
          padding: 2px 4px; border-radius: 6px;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
        }
        #legend {
          position: absolute; top: 8px; right: 8px; z-index: 1000;
          background: var(--card-background-color, #fff); opacity: 0.93;
          border-radius: 6px; padding: 5px 7px;
          font-family: var(--primary-font-family, sans-serif);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
          pointer-events: none;
        }
        #legend .title {
          font-size: 9px; text-align: right; margin-bottom: 2px;
          color: var(--secondary-text-color, #666);
        }
        #cells .cell { display: flex; align-items: center; gap: 5px; }
        #cells .cell i {
          display: block; width: 18px; height: 7px; border-radius: 1px;
          margin: 1px 0;
        }
        #cells .cell b {
          font-weight: normal; font-size: 9px;
          color: var(--secondary-text-color, #666);
        }
        #modehint {
          display: block; font-size: 9px; text-align: right; margin-top: 2px;
          color: var(--warning-color, #b26a00);
        }
        #attrib {
          position: absolute; left: 50%; bottom: 8px;
          transform: translateX(-50%); z-index: 1000;
          background: var(--card-background-color, #fff);
          color: var(--secondary-text-color, #888);
          opacity: 0.85; padding: 2px 8px; border-radius: 4px;
          font-size: 9px; white-space: nowrap; pointer-events: none;
          font-family: var(--primary-font-family, sans-serif);
        }
        #error { padding: 16px; color: var(--error-color, #b71c1c); }
        [hidden] { display: none !important; }
      </style>
      <ha-card>
        <div class="wrap">
          <div id="map"></div>
          <div id="label" hidden></div>
          <div id="banner" hidden></div>
          <button id="play" aria-label="Play/Pause" hidden>${PLAY_SVG}</button>
          <div id="legend" hidden>
            <div class="title">mm/h</div>
            <div id="cells"></div>
            <span id="modehint" hidden>measurement only</span>
          </div>
          <div id="attrib" ${c.attribution === false ? "hidden" : ""}>${ATTRIBUTION}</div>
        </div>
        <div id="timeline" hidden>
          <div id="trackwrap">
            <div id="track">
              <div class="zone" id="tmeas"></div>
              <div class="zone" id="tfc"></div>
              <div id="telapsed"></div>
              <div id="tnow" hidden></div>
              <div id="knob"></div>
            </div>
          </div>
          <div id="hoursrow" ${c.time_axis ? "" : "hidden"}></div>
          <div id="datesrow" ${c.time_axis ? "" : "hidden"}></div>
        </div>
        <div id="error" hidden></div>
      </ha-card>
    `;
    this._label = root.getElementById("label");
    this._banner = root.getElementById("banner");
    this._timeline = root.getElementById("timeline");
    this._trackWrap = root.getElementById("trackwrap");
    this._tMeas = root.getElementById("tmeas");
    this._tFc = root.getElementById("tfc");
    this._tNow = root.getElementById("tnow");
    this._tElapsed = root.getElementById("telapsed");
    this._knob = root.getElementById("knob");
    this._hoursRow = root.getElementById("hoursrow");
    this._datesRow = root.getElementById("datesrow");
    this._playBtn = root.getElementById("play");
    this._legendEl = root.getElementById("legend");
    this._cellsEl = root.getElementById("cells");
    this._modeHint = root.getElementById("modehint");
    this._playBtn.addEventListener("click", () => this._togglePlay());
    const scrubFromEvent = (ev) => {
      const rect = this._trackWrap.getBoundingClientRect();
      const frac = Math.min(
        1,
        Math.max(0, (ev.clientX - rect.left) / rect.width)
      );
      if (!this._frames.length || !this._span) return;
      const idx = this._nearestIndexByTs(this._t0 + frac * this._span);
      this._onScrub(idx);
    };
    this._trackWrap.addEventListener("pointerdown", (ev) => {
      try {
        this._trackWrap.setPointerCapture(ev.pointerId);
      } catch (e) {
        // synthetic events carry no active pointer - scrubbing still works
      }
      this._trackScrubbing = true;
      scrubFromEvent(ev);
    });
    this._trackWrap.addEventListener("pointermove", (ev) => {
      if (this._trackScrubbing) scrubFromEvent(ev);
    });
    this._trackWrap.addEventListener("pointerup", () => {
      this._trackScrubbing = false;
    });
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
      // Attribution lives in the card footer; the map corners stay free
      // for the label (bottom left) and the play button (bottom right).
      attributionControl: false,
    });
    L.tileLayer(TILE_URL, {
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
    this._timeline.hidden = false;
    this._playBtn.hidden = false;
    const mode = this._config.autoplay_mode;
    if ((mode === "window" || mode === "full") && !this._autoplayStarted) {
      this._autoplayStarted = true;
      this._startPlay(mode);
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
    const measCount = frames.filter((f) => f.type === "measurement").length;
    // Positions map TIME, not frame index: the cadence is mixed (5-min
    // measurement, 5/10-min forecast), so index fractions drift off the axis.
    this._t0 = frames[0].ts;
    this._span = Math.max(1, frames[frames.length - 1].ts - this._t0);
    const lastMeas = frames.filter((f) => f.type === "measurement").pop();
    const measFrac = lastMeas ? (lastMeas.ts - this._t0) / this._span : 0;
    const b = (measFrac * 100).toFixed(2);
    this._tMeas.style.width = b + "%";
    this._tFc.style.width = (100 - Number(b)).toFixed(2) + "%";
    this._tNow.style.left = b + "%";
    this._tNow.hidden = measCount === frames.length;
    this._modeHint.hidden = measCount !== frames.length;
    this._renderLegend(animation.legend);
    this._buildTimelineLabels();

    // Keep the playhead on the same moment across a manifest rollover.
    if (prevTs != null) {
      this._frameIndex = this._nearestIndexByTs(prevTs);
      this._moveMarkers(this._frameIndex);
    }
    if (this._playMode === "window") this._computeWindow();
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
    const bands = [...legend].sort((a, b) => (b.min || 0) - (a.min || 0));
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

  /* Hour labels sit right of a small separator at each 6-h mark; the date
   * label sits right of the day-change line, which runs continuously from
   * the bottom of the date row up through the hour row. */
  _buildTimelineLabels() {
    if (!this._config.time_axis || this._frames.length < 2) return;
    const frames = this._frames;
    const t0 = frames[0].ts;
    const t1 = frames[frames.length - 1].ts;
    const span = t1 - t0;
    this._hoursRow.textContent = "";
    this._datesRow.textContent = "";
    const firstHour = Math.ceil(t0 / 3600) * 3600;
    for (let t = firstHour; t <= t1; t += 3600) {
      const d = new Date(t * 1000);
      if (d.getHours() % 6 !== 0) continue;
      const x = ((t - t0) / span) * 100;
      if (x < 0.5 || x > 91) continue; // left-aligned labels need room
      if (d.getHours() !== 0) {
        // midnight gets the continuous day line instead of a short one
        const sep = document.createElement("div");
        sep.className = "hsep";
        sep.style.left = x + "%";
        this._hoursRow.appendChild(sep);
      }
      const b = document.createElement("b");
      b.style.left = `calc(${x.toFixed(2)}% + 4px)`;
      b.textContent = String(d.getHours()).padStart(2, "0") + ":00";
      this._hoursRow.appendChild(b);
    }
    let t = t0;
    let first = true;
    while (t <= t1) {
      const ds = new Date(t * 1000);
      ds.setHours(0, 0, 0, 0);
      const dayStart = ds.getTime() / 1000;
      const dayEnd = dayStart + 86400;
      const visStart = Math.max(dayStart, t0);
      const visEnd = Math.min(dayEnd, t1);
      const width = ((visEnd - visStart) / span) * 100;
      const x = ((visStart - t0) / span) * 100;
      if (!first) {
        const sep = document.createElement("div");
        sep.className = "daysep";
        sep.style.left = x + "%";
        this._datesRow.appendChild(sep);
      }
      if (width >= 4) {
        const d = new Date(visStart * 1000);
        const b = document.createElement("b");
        b.style.left = first ? "0" : `calc(${x.toFixed(2)}% + 5px)`;
        b.textContent =
          width < 8
            ? weekdayShort(visStart)
            : weekdayShort(visStart) +
              " " +
              String(d.getDate()).padStart(2, "0") +
              ".";
        this._datesRow.appendChild(b);
      }
      first = false;
      t = dayEnd;
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

  /* ---------- playback ---------- */

  /* The play button cycles: paused -> window (the configured relevant
   * range around now, looping) -> full timeline -> paused. */
  _togglePlay() {
    if (this._playMode === "window") this._startPlay("full");
    else if (this._playMode === "full") this._pause();
    else this._startPlay("window");
  }

  _computeWindow() {
    const lastMeas = this._frames[this._lastMeasurementIndex()];
    const now = lastMeas ? lastMeas.ts : this._t0;
    const past = Number(this._config.play_past_hours);
    const fc = Number(this._config.play_forecast_hours);
    this._winStart = this._nearestIndexByTs(
      now - (Number.isFinite(past) ? past : 1) * 3600
    );
    this._winEnd = this._nearestIndexByTs(
      now + (Number.isFinite(fc) ? fc : 8) * 3600
    );
    if (this._winEnd <= this._winStart) {
      this._winStart = 0;
      this._winEnd = this._frames.length - 1;
    }
  }

  _startPlay(mode) {
    if (!this._frames.length) return;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._playMode = mode;
    this._playing = true;
    if (mode === "window") {
      this._computeWindow();
      this._jumpTo(this._winStart);
    }
    this._updatePlayBtn();
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
    this._playMode = "paused";
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._updatePlayBtn();
  }

  _updatePlayBtn() {
    if (!this._playBtn) return;
    if (!this._playing) {
      this._playBtn.innerHTML = PLAY_SVG;
      return;
    }
    const badge =
      this._playMode === "window"
        ? `${Number(this._config.play_forecast_hours) || 8}h`
        : "all";
    this._playBtn.innerHTML = `${PAUSE_SVG}<b class="mode">${badge}</b>`;
  }

  _jumpTo(idx) {
    const f = this._frames[idx];
    if (!f) return;
    this._frameIndex = idx;
    this._moveMarkers(idx);
    this._ensureFrame(f.url)
      .then(() => {
        if (this._frameIndex === idx) this._showFrame(idx);
      })
      .catch(() => {});
    this._prefetch(idx);
  }

  _advance() {
    if (!this._frames.length) return;
    let next = this._frameIndex + this._strideN();
    if (this._playMode === "window") {
      if (next > this._winEnd) next = this._winStart;
    } else {
      next = next % this._frames.length;
    }
    const f = this._frames[next];
    if (!f) return;
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

  /* Track fill, knob and label for idx. */
  _moveMarkers(idx) {
    const f = this._frames[idx];
    if (!f) return;
    this._frameIndex = idx;
    this._updateLabel();
    const frac = this._span ? (f.ts - this._t0) / this._span : 0;
    const pct = (frac * 100).toFixed(2) + "%";
    this._tElapsed.style.width = pct;
    this._knob.style.left = pct;
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
      l2.textContent = type;
      this._label.appendChild(l1);
      this._label.appendChild(l2);
    } else {
      // Compact label: the chip color already tells measurement vs forecast.
      this._label.textContent = `${weekdayShort(f.ts)} ${f.day.slice(0, 6)} · ${f.timepoint}`;
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


/* ---------- visual config editor ----------
 * Follows the weather-station-card editor pattern: basics always
 * visible on top, everything else in collapsible ha-expansion-panels
 * whose headers carry an icon, the section title, a one-line state
 * summary readable while collapsed, and a per-section reset button. */

const EDITOR_LABELS = {
  height: "Map height (px)",
  zoom: "Initial zoom",
  frame_duration: "Frame duration (ms)",
  frame_stride: "Frame stride",
  past_hours: "History (h)",
  forecast_hours: "Forecast (h)",
  autoplay_mode: "Autoplay on open",
  play_past_hours: "Window: history (h)",
  play_forecast_hours: "Window: forecast (h)",
  legend: "Legend",
  attribution: "Attribution",
  time_axis: "Time labels",
  large_label: "Large time label",
};

const EDITOR_DEFAULTS = {
  height: 400,
  zoom: 8,
  frame_duration: 300,
  frame_stride: 1,
  autoplay_mode: "off",
  play_past_hours: 1,
  play_forecast_hours: 8,
  legend: true,
  attribution: true,
  time_axis: true,
  large_label: true,
};

const BASICS_SCHEMA = [
  {
    type: "grid",
    name: "",
    schema: [
      { name: "height", selector: { number: { min: 200, max: 900, step: 10, mode: "box" } } },
      { name: "zoom", selector: { number: { min: 6, max: 14, step: 0.5, mode: "box" } } },
    ],
  },
];

const EDITOR_SECTIONS = [
  {
    key: "playback",
    icon: "mdi:play-circle-outline",
    title: "Playback",
    reset: [
      "autoplay_mode",
      "play_past_hours",
      "play_forecast_hours",
      "frame_duration",
      "frame_stride",
      "autoplay",
    ],
    schema: [
      {
        name: "autoplay_mode",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "off", label: "Off — start paused" },
              { value: "window", label: "Window — play the configured range on open" },
              { value: "full", label: "Full — play the whole timeline on open" },
            ],
          },
        },
      },
      {
        type: "grid",
        name: "",
        schema: [
          { name: "play_past_hours", selector: { number: { min: 0, max: 12, step: 0.5, mode: "box" } } },
          { name: "play_forecast_hours", selector: { number: { min: 0, max: 33, step: 0.5, mode: "box" } } },
          { name: "frame_duration", selector: { number: { min: 100, max: 1500, step: 50, mode: "box" } } },
          { name: "frame_stride", selector: { number: { min: 1, max: 6, step: 1, mode: "box" } } },
        ],
      },
    ],
  },
  {
    key: "display",
    icon: "mdi:eye-outline",
    title: "Display",
    reset: ["legend", "attribution", "time_axis", "large_label"],
    chips: [
      { key: "legend", label: "Legend" },
      { key: "attribution", label: "Attribution" },
      { key: "time_axis", label: "Time labels" },
      { key: "large_label", label: "Large label" },
    ],
  },
];

class MeteoSwissRadarCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
    this._updateForms();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._forms) for (const f of this._forms) f.hass = hass;
  }

  connectedCallback() {
    this._render();
    this._updateForms();
  }

  _data() {
    return { ...EDITOR_DEFAULTS, ...(this._config || {}) };
  }

  _emit(config) {
    for (const key of Object.keys(config)) {
      if (config[key] === undefined || config[key] === null || config[key] === "") {
        delete config[key];
      }
    }
    this._config = config;
    this._updateForms();
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _makeForm(schema) {
    const form = document.createElement("ha-form");
    form.computeLabel = (item) => EDITOR_LABELS[item.name] || item.name;
    form.schema = schema;
    form.addEventListener("value-changed", (ev) => {
      // Every form is fed the full data object, so the emitted value is
      // the full config with this form's change applied.
      this._emit({ type: this._config.type, ...(ev.detail.value || {}) });
    });
    this._forms.push(form);
    return form;
  }

  _resetSection(def) {
    const config = { ...this._config };
    for (const key of def.reset) delete config[key];
    this._emit(config);
  }

  _render() {
    if (!this._config || !this.isConnected || this._built) return;
    this._built = true;
    this._forms = [];
    this._summaryEls = {};
    this.textContent = "";
    const style = document.createElement("style");
    style.textContent = `
      .msr-basics { display: block; margin-bottom: 14px; }
      ha-expansion-panel.msr-panel { display: block; margin-bottom: 8px; }
      .msr-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 2px 0; }
      .msr-head ha-icon { color: var(--secondary-text-color); }
      .msr-titles { flex: 1; min-width: 0; }
      .msr-title { font-size: 14px; font-weight: 500; }
      .msr-summary { font-size: 12px; color: var(--secondary-text-color); }
      .msr-body { padding: 12px 8px 8px; }
      .msr-chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .msr-chip {
        border: 1px solid var(--divider-color, #c3ccd1); border-radius: 16px;
        padding: 7px 14px; font-size: 13px; cursor: pointer; user-select: none;
        color: var(--primary-text-color, #333); background: transparent;
        font-family: inherit; line-height: 1;
      }
      .msr-chip.on {
        background: var(--primary-color, #03a9f4); color: #fff;
        border-color: var(--primary-color, #03a9f4);
      }
    `;
    this.appendChild(style);

    const basics = this._makeForm(BASICS_SCHEMA);
    basics.classList.add("msr-basics");
    this.appendChild(basics);

    for (const def of EDITOR_SECTIONS) {
      const panel = document.createElement("ha-expansion-panel");
      panel.className = "msr-panel";
      panel.outlined = true;

      const head = document.createElement("div");
      head.slot = "header";
      head.className = "msr-head";
      const icon = document.createElement("ha-icon");
      icon.icon = def.icon;
      const titles = document.createElement("div");
      titles.className = "msr-titles";
      const title = document.createElement("div");
      title.className = "msr-title";
      title.textContent = def.title;
      const summary = document.createElement("div");
      summary.className = "msr-summary";
      titles.appendChild(title);
      titles.appendChild(summary);
      this._summaryEls[def.key] = summary;
      const reset = document.createElement("ha-icon-button");
      reset.title = "Reset section to defaults";
      const resetIcon = document.createElement("ha-icon");
      resetIcon.icon = "mdi:restore";
      reset.appendChild(resetIcon);
      reset.addEventListener("click", (ev) => {
        ev.stopPropagation(); // the header itself toggles the panel
        this._resetSection(def);
      });
      head.appendChild(icon);
      head.appendChild(titles);
      head.appendChild(reset);
      panel.appendChild(head);

      const body = document.createElement("div");
      body.className = "msr-body";
      body.appendChild(
        def.chips ? this._makeChips(def) : this._makeForm(def.schema)
      );
      panel.appendChild(body);
      this.appendChild(panel);
      panel.expanded = true;
    }
  }

  _makeChips(def) {
    if (!this._chipEls) this._chipEls = {};
    const wrap = document.createElement("div");
    wrap.className = "msr-chips";
    for (const chip of def.chips) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "msr-chip";
      el.textContent = chip.label;
      el.addEventListener("click", () => {
        const config = { ...this._config };
        const on = this._data()[chip.key] !== false;
        if (on) config[chip.key] = false;
        else delete config[chip.key]; // default is on
        this._emit(config);
      });
      this._chipEls[chip.key] = el;
      wrap.appendChild(el);
    }
    return wrap;
  }

  _updateForms() {
    if (!this._forms) return;
    const data = this._data();
    for (const form of this._forms) {
      if (this._hass) form.hass = this._hass;
      form.data = data;
    }
    if (!this._summaryEls) return;
    const playback =
      (data.autoplay_mode === "window"
        ? `Window −${data.play_past_hours} h → +${data.play_forecast_hours} h`
        : data.autoplay_mode === "full"
          ? "Full timeline on open"
          : "Autoplay off") +
      ` · ${data.frame_duration} ms` +
      (Number(data.frame_stride) > 1 ? ` · every ${data.frame_stride}. frame` : "");
    const shown = [
      data.legend !== false && "legend",
      data.attribution !== false && "attribution",
      data.time_axis !== false && "time labels",
      data.large_label !== false && "large label",
    ].filter(Boolean);
    this._summaryEls.playback.textContent = playback;
    this._summaryEls.display.textContent = shown.length ? shown.join(" · ") : "minimal";
    if (this._chipEls) {
      for (const key of Object.keys(this._chipEls)) {
        this._chipEls[key].classList.toggle("on", data[key] !== false);
      }
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
  if (!window.customElements.get("meteoswiss-radar-card-editor")) {
    window.customElements.define(
      "meteoswiss-radar-card-editor",
      MeteoSwissRadarCardEditor
    );
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
    preview: true,
  });
}
console.info(
  `%c METEOSWISS-RADAR-CARD %c v${CARD_VERSION} `,
  "background:#d32f2f;color:#fff;padding:2px 4px;border-radius:2px 0 0 2px",
  "background:#555;color:#fff;padding:2px 4px;border-radius:0 2px 2px 0"
);
