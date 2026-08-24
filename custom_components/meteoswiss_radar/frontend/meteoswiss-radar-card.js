/* MeteoSwiss Radar Card
 * Precipitation radar animation on a swisstopo basemap, data from the
 * MeteoSwiss app API through the meteoswiss_radar integration's
 * authenticated proxy. Frame format: see FORMAT.md in the repository root.
 */

const CARD_VERSION = "0.9.0";
const FRONTEND_BASE = "/meteoswiss_radar/frontend";
const PROXY_BASE = "meteoswiss_radar/proxy"; // hass.callApi() prepends /api/

const TILE_URL =
  "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg";
const ATTRIBUTION = "Source: MeteoSwiss &middot; &copy; swisstopo";

// Byte budget for the decoded-frame cache. The heaviest single frame is ~518 KB
// decoded; a 291-frame live manifest is ~26 MB total, so 24 MB keeps ~270 frames
// resident and lets only the heaviest forecast tail rotate under eviction.
// With the single-buffer layout (issue #53) frameBytes now accounts for the real
// footprint; the Int32 ring-index overhead is negligible (~300 KB for 74 k rings).
// Keeping at 24 MB: same frame count as before, true browser memory drops ~32 %.
const DECODE_CACHE_BYTES = 24 * 1024 * 1024;
// Two window-mode loops (~24 frames each): cheap to rebuild (0.73 ms/frame),
// and _reset() clears it on every pan/zoom anyway, so a large pool buys nothing.
const PATH_CACHE_SIZE = 48; // projected Path2D sets per view (LRU), fixed cap
const PREFETCH_AHEAD = 6; // frames fetched ahead of the playhead
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // manifest re-check cadence
const FAIL_STREAK_LIMIT = 8; // consecutive frame failures before degrading
const FRAME_RETRY_BACKOFF_MS = 8000; // don't refetch a failed frame every tick
const RECOVERY_INTERVAL_MS = 15000; // probe cadence while failure-paused
const TEARDOWN_DEBOUNCE_MS = 2000; // grace before a detached card frees its map
const COLOR_FORECAST = "#ffb74d"; // forecast label chip
const RADAR_OPACITY = 0.75;

// App-parity overlay legend colors (display only; frame-carried colors are used for fills).
const OVERLAY_COLORS = {
  snow: "#C1DDDC",
  snowrain: "#6BEAFF",
  freezingrain: "#87C8FF",
};
const OVERLAY_LABELS = {
  snow: "Snow",
  snowrain: "Sleet",
  freezingrain: "Freezing rain",
};
// Overlay frame URL key on the frame object, keyed by overlay name.
const OVERLAY_URL_KEY = {
  snow: "snow_url",
  snowrain: "snowrain_url",
  freezingrain: "freezingrain_url",
};
// Z-order: rate layer first, then snow, snowrain, freezing-rain (app parity).
const OVERLAY_ORDER = ["snow", "snowrain", "freezingrain"];
// Config key enabling the toggle button for each overlay.
const OVERLAY_CONFIG_KEY = {
  snow: "layer_snow",
  snowrain: "layer_snowrain",
  freezingrain: "layer_freezing_rain",
};
// Config key for wall-tablet auto-on default.
const OVERLAY_ON_KEY = {
  snow: "layer_snow_on",
  snowrain: "layer_snowrain_on",
  freezingrain: "layer_freezing_rain_on",
};

let leafletLoader = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletLoader) {
    leafletLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${FRONTEND_BASE}/vendor/${CARD_VERSION}/leaflet.js`;
      script.onload = () => resolve(window.L);
      script.onerror = () => { leafletLoader = null; reject(new Error("Leaflet failed to load")); };
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
 * Writes n vertices (lat/lng interleaved) into verts starting at offset and
 * returns the next free offset. Caller pre-allocates verts to the right size.
 * A vertex sits on a gridline crossing: i even = on a vertical gridline
 * (fractional offset applies to y), i odd = on a horizontal one. Deltas in d
 * apply BETWEEN vertices: o.length vertices, o.length - 1 char pairs in d. */
function decodeContourInto(contour, grid, verts, offset) {
  let i = contour.i;
  let j = contour.j;
  const d = contour.d;
  const o = contour.o;
  const n = o.length;
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
    const ll = gridKmToLatLng(x, y);
    verts[offset + s * 2] = ll[0];
    verts[offset + s * 2 + 1] = ll[1];
    if (s < n - 1) {
      i += d.charCodeAt(2 * s) - 77;
      j += d.charCodeAt(2 * s + 1) - 77;
    }
  }
  return offset + n * 2;
}

/* Decode a frame into view-independent geometry: one entry per intensity band.
 * Each area carries a single Float32Array of lat/lng pairs (all rings, all
 * shapes concatenated) and an Int32Array of ring start indices with a sentinel
 * at the end — ring r spans verts[rings[r]..rings[r+1]).  Shapes within an
 * area are flattened: rendering uses evenodd fill, so the ring sequence (outer,
 * holes, next-shape outer, …) produces correct output regardless of grouping. */
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
  return frame.areas.map((area) => {
    // Count totals upfront so the Float32Array can be pre-allocated in one shot.
    let totalVerts = 0;
    let totalRings = 0;
    for (const shape of area.shapes)
      for (const ct of shape) {
        totalVerts += ct.o.length;
        totalRings++;
      }
    const verts = new Float32Array(totalVerts * 2);
    // rings[r] is the float index of the first vertex of ring r;
    // rings[totalRings] is the sentinel (= verts.length).
    const rings = new Int32Array(totalRings + 1);
    let ringIdx = 0;
    let vertOffset = 0;
    for (const shape of area.shapes)
      for (const ct of shape) {
        rings[ringIdx++] = vertOffset;
        vertOffset = decodeContourInto(ct, grid, verts, vertOffset);
      }
    rings[ringIdx] = vertOffset; // sentinel
    return { color: `#${area.color}`, verts, rings };
  });
}

/* Sum the real byte footprint of a decoded frame.
 * With single-buffer layout each area contributes its Float32 vertex data
 * and the Int32 ring-index array; both are measured here so the cache budget
 * tracks actual allocations, not just vertex bytes. */
function frameBytes(areas) {
  if (!Array.isArray(areas)) return 0;
  let b = 0;
  for (const area of areas)
    if (area) {
      if (area.verts) b += area.verts.byteLength;
      if (area.rings) b += area.rings.byteLength;
    }
  return b;
}

// One formatter instance reused across all calls avoids re-parsing the locale
// option bag and allocating a new Intl.DateTimeFormat on every frame tick.
const _weekdayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
function weekdayShort(ts) {
  return _weekdayFmt.format(new Date(ts * 1000));
}

/* Canvas layer that caches projected Path2D sets per frame and view.
 * Replaying a cached frame is one clearRect plus ~11 native fills. */
function makeRadarLayerClass(L) {
  return L.Layer.extend({
    initialize() {
      this._pathCache = new Map(); // url -> [{color, path}]
      this._pathCacheMax = PATH_CACHE_SIZE;
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
        const { verts, rings } = area;
        for (let r = 0; r < rings.length - 1; r++) {
          const start = rings[r];
          const end = rings[r + 1];
          for (let i = start; i < end; i += 2) {
            const pt = map.latLngToLayerPoint([verts[i], verts[i + 1]]);
            if (i === start) path.moveTo(pt.x, pt.y);
            else path.lineTo(pt.x, pt.y);
          }
          path.closePath();
        }
        return { color: area.color, path };
      });
      this._pathCache.set(url, paths);
      while (this._pathCache.size > this._pathCacheMax) {
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
    this._cacheSizes = new Map(); // radar_url -> byte size of that entry
    this._cacheBytes = 0; // running total decoded bytes
    this._cacheMax = Infinity; // entry-count ceiling; set to frames.length + 10 after manifest
    this._pending = new Map(); // radar_url -> Promise
    this._retryAfter = new Map(); // radar_url -> earliest retry timestamp (ms)
    this._frames = [];
    this._frameIndex = 0;
    this._playing = false;
    this._playMode = "paused";
    this._failStreak = 0;
    this._dataReady = false;
    this._lastManifest404Refresh = 0;
    // Generation counter: incremented by _teardown so async continuations
    // started by _maybeInit/_loadData can detect stale state and bail before
    // creating a map, starting the refresh timer, or spinning a play loop on
    // a card that has since been detached.
    this._epoch = 0;
    // Play mode remembered when a fail-streak paused playback, so recovery can
    // restart the same loop. null unless a network outage paused us.
    this._pausedByFailure = null;
    // Play mode active just before disconnectedCallback so connectedCallback
    // can resume it when the teardown debounce is cancelled (re-attach within
    // the grace window). null when the card was manually paused at disconnect.
    this._playModeBeforeDetach = null;
    // RadarLayer instances for precipitation-type overlay layers (snow, snowrain,
    // freezingrain). Created in _createMap for each layer enabled in config.
    this._overlayLayers = {};
    // Per-overlay toggle state: true = overlay is currently displayed on the map.
    // Initialised from layer_<x>_on config in _createMap; flipped by the map
    // toggle buttons. Independent of _overlayLayers (a layer can exist but be off).
    this._overlayActive = {};
  }

  setConfig(config) {
    const prev = this._config;
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
    // Validate and coerce zoom to [6, 15], default 8
    const z = Number(this._config.zoom);
    this._config.zoom = Number.isFinite(z) && z >= 6 && z <= 15 ? z : 8;
    // Validate center: must be array of exactly 2 finite numbers; coerce to numbers
    const c = this._config.center;
    if (Array.isArray(c) && c.length === 2) {
      const lat = Number(c[0]);
      const lng = Number(c[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        this._config.center = [lat, lng];
      } else {
        delete this._config.center; // will fall back to home coords in _createMap
      }
    } else {
      delete this._config.center; // will fall back to home coords in _createMap
    }
    // Editor preview: HA re-runs setConfig on the live element for every
    // keystroke. Apply display-only changes in place so the preview updates
    // without recreating the element (which re-ran Leaflet + a full data load
    // and leaked the predecessor). Only a changed time span reloads data.
    if (this._initialized) this._applyConfigInPlace(prev || {});
  }

  // Apply the config deltas that do not need a full re-init: map height,
  // legend/attribution/time-axis visibility, label size, and — the one data
  // change — a different past/forecast span. Frame-independent DOM only.
  _applyConfigInPlace(prev) {
    const c = this._config;
    if (Number(c.height) !== Number(prev.height)) {
      this._applyHeight();
      if (this._map) this._map.invalidateSize();
    }
    if (this._legendEl) this._legendEl.hidden = c.legend === false;
    if (this._attrib) this._attrib.hidden = c.attribution === false;
    const timeAxis = c.time_axis !== false;
    if (this._hoursRow) this._hoursRow.hidden = !timeAxis;
    if (this._datesRow) this._datesRow.hidden = !timeAxis;
    // Labels are only built when time_axis is on; rebuild when it is switched
    // back on so the (previously skipped) rows are populated.
    if (timeAxis && prev.time_axis === false) this._buildTimelineLabels();
    if (c.large_label !== prev.large_label) this._updateLabel();
    // Only a changed time span needs new frames. Compare as strings so an
    // absent bound on both sides reads as unchanged (Number(undefined) is NaN,
    // and NaN !== NaN would spuriously trigger a reload on every keystroke).
    const span = (cfg) => `${cfg.past_hours}|${cfg.forecast_hours}`;
    if (this._dataReady && span(c) !== span(prev)) {
      this._refreshManifest(true).catch(() => {});
    }
  }

  _applyHeight() {
    const h = Number(this._config.height) || 400;
    this.style.setProperty("--msr-map-height", h + "px");
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeInit();
  }

  connectedCallback() {
    // Re-attached inside the debounce window: cancel the pending teardown and
    // keep the live map rather than rebuilding it.
    if (this._teardownTimer) {
      clearTimeout(this._teardownTimer);
      this._teardownTimer = null;
      // Restore the play mode that was running before the detach. Manual pause
      // leaves _playModeBeforeDetach null, so it stays paused.
      if (this._playModeBeforeDetach) {
        this._startPlay(this._playModeBeforeDetach);
        this._playModeBeforeDetach = null;
      }
    }
    this._maybeInit(); // rebuilds from scratch if a teardown already fired
    if (this._map) requestAnimationFrame(() => this._map.invalidateSize());
    if (this._initialized && !this._refreshTimer) this._startRefreshTimer();
  }

  disconnectedCallback() {
    // Remember the running mode so connectedCallback can restart it if the
    // debounce fires quickly (tab switch / cached layout re-attach). Only set
    // when actively playing; a manual pause keeps the field null.
    this._playModeBeforeDetach = this._playing ? this._playMode : null;
    this._pause();
    this._stopRecoveryTimer();
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    // HA detaches and immediately re-attaches cards during layout shuffles
    // (view switches, drag reorder). Tearing the map down on every detach
    // would rebuild Leaflet and refetch on each one; debounce so only a real
    // removal — still detached after the grace period — frees the map.
    if (this._teardownTimer) clearTimeout(this._teardownTimer);
    this._teardownTimer = setTimeout(() => this._teardown(), TEARDOWN_DEBOUNCE_MS);
  }

  // Free everything a detached card would otherwise pin. Leaflet's map keeps
  // a window-level resize listener (trackResize) that holds the whole element
  // — the ~25 MB decode cache and the layer's Path2D cache — past GC;
  // map.remove() detaches those listeners and the tile layer. Reset the init
  // flags so connectedCallback rebuilds cleanly on re-attach.
  _teardown() {
    this._teardownTimer = null;
    if (!this._initialized) return;
    // Advance the generation so any _maybeInit/_loadData continuation that
    // resumes after this point sees stale state and returns without creating
    // a map, starting a timer, or spinning a play loop.
    this._epoch++;
    this._pause();
    this._stopRecoveryTimer();
    if (this._timelineResizeObserver) {
      this._timelineResizeObserver.disconnect();
      this._timelineResizeObserver = null;
    }
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._map) {
      this._map.remove();
      this._map = null;
    }
    this._radar = null;
    this._overlayLayers = {};
    this._overlayActive = {};
    this._cache.clear();
    this._cacheSizes.clear();
    this._cacheBytes = 0;
    this._pending.clear();
    this._retryAfter.clear();
    this._frames = [];
    this._frameIndex = 0;
    this._initialized = false;
    this._dataReady = false;
    this._autoplayStarted = false;
    this._playModeBeforeDetach = null;
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
    const epoch = this._epoch;
    this._renderShell();
    // Start the manifest + first-frame fetch before awaiting Leaflet so both
    // network chains overlap. Only _showFrame needs _radar; everything before
    // it can run while the script is still loading.
    const earlyFetch = (async () => {
      await this._refreshManifest(true);
      if (this._epoch !== epoch) return;
      await this._ensureFrame(this._frames[this._lastMeasurementIndex()].url);
    })();
    // Prevent an unhandled rejection while Leaflet is still loading.
    earlyFetch.catch(() => {});
    try {
      this._L = await this._loadLeaflet();
      // Guard: _teardown may have fired while we awaited Leaflet.
      if (this._epoch !== epoch) return;
      this._createMap(this._L);
    } catch (err) {
      // Guard: if teardown already cleaned up, do not reset _initialized
      // because a new _maybeInit may have set it again.
      if (this._epoch !== epoch) return;
      // Script load failed (e.g. flaky network). Reset so the next hass/
      // connectedCallback call retries rather than staying permanently broken.
      this._initialized = false;
      this._showError(err.message || String(err));
      return;
    }
    try {
      await this._loadData(earlyFetch);
    } catch (err) {
      if (this._epoch !== epoch) return;
      console.warn("meteoswiss-radar-card: initial data load failed:", err);
      this._showBanner("Radar data is currently unavailable");
    }
    if (this._epoch !== epoch) return;
    this._startRefreshTimer();
  }

  // Thin wrapper so tests can stub Leaflet loading without touching the
  // module-level leafletLoader singleton.
  _loadLeaflet() {
    return loadLeaflet();
  }

  _renderShell() {
    // A torn-down card is rebuilt into its existing shadow root; attachShadow
    // twice throws, so reuse it and let innerHTML replace the previous tree.
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    const c = this._config;
    const height = Number(c.height) || 400;
    root.innerHTML = `
      <link rel="stylesheet" href="${FRONTEND_BASE}/vendor/${CARD_VERSION}/leaflet.css">
      <style>
        ha-card { overflow: hidden; }
        .wrap { position: relative; }
        #map {
          height: var(--msr-map-height, ${height}px); width: 100%;
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
        #label .l1 { font-size: 12px; font-weight: 600; }
        #label.large .l1 { font-size: 15px; font-weight: 700; }
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
          position: absolute; top: -19px; bottom: 1px; width: 1px;
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
        #layertoggles {
          position: absolute; top: 8px; left: 8px; z-index: 1000;
          display: flex; flex-direction: column; gap: 4px;
        }
        #layertoggles .ltbtn {
          width: 28px; height: 28px; border-radius: 4px; border: none;
          cursor: pointer; display: flex; align-items: center; justify-content: center;
          background: var(--card-background-color, #fff); opacity: 0.85;
          box-shadow: 0 1px 4px rgba(0,0,0,0.3);
          transition: opacity 0.15s;
        }
        #layertoggles .ltbtn.active { opacity: 1; }
        #layertoggles .ltbtn svg { display: block; }
        #overlay-swatches { margin-top: 4px; border-top: 1px solid var(--divider-color, #e0e0e0); padding-top: 3px; }
        #overlay-swatches .cell { display: flex; align-items: center; gap: 5px; }
        #overlay-swatches .cell i {
          display: block; width: 18px; height: 7px; border-radius: 1px; margin: 1px 0;
        }
        #overlay-swatches .cell b {
          font-weight: normal; font-size: 9px;
          color: var(--secondary-text-color, #666);
        }
        #error { padding: 16px; color: var(--error-color, #b71c1c); }
        [hidden] { display: none !important; }
      </style>
      <ha-card>
        <div class="wrap">
          <div id="map"></div>
          <div id="label" hidden><div id="label-l1" class="l1"></div><div id="label-l2" class="l2" hidden></div></div>
          <div id="banner" hidden></div>
          <div id="layertoggles" hidden></div>
          <button id="play" aria-label="Play/Pause" hidden>${PLAY_SVG}</button>
          <div id="legend" hidden>
            <div class="title">mm/h</div>
            <div id="cells"></div>
            <div id="overlay-swatches" hidden></div>
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
    this._labelL1 = root.getElementById("label-l1");
    this._labelL2 = root.getElementById("label-l2");
    this._banner = root.getElementById("banner");
    this._layerTogglesEl = root.getElementById("layertoggles");
    this._overlaySwatch = root.getElementById("overlay-swatches");
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
    this._attrib = root.getElementById("attrib");
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
    // A cancelled touch (palm rejection, system gesture) fires pointercancel /
    // lostpointercapture instead of pointerup, leaving _trackScrubbing stuck.
    this._trackWrap.addEventListener("pointercancel", () => {
      this._trackScrubbing = false;
    });
    this._trackWrap.addEventListener("lostpointercapture", () => {
      this._trackScrubbing = false;
    });
    if (this._timelineResizeObserver) {
      this._timelineResizeObserver.disconnect();
    }
    if (typeof ResizeObserver !== "undefined") {
      this._timelineResizeObserver = new ResizeObserver(() => {
        this._buildTimelineLabels();
      });
      this._timelineResizeObserver.observe(this._hoursRow);
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
    // Rate layer first, then overlay layers in z-order (snow < snowrain < freezingrain).
    this._radar = new RadarLayer().addTo(this._map);
    this._overlayLayers = {};
    this._overlayActive = {};
    for (const key of OVERLAY_ORDER) {
      const cfgKey = OVERLAY_CONFIG_KEY[key];
      if (!this._config[cfgKey]) continue;
      this._overlayLayers[key] = new RadarLayer().addTo(this._map);
      this._overlayActive[key] = !!this._config[OVERLAY_ON_KEY[key]];
    }
    this._buildLayerToggles();

    // The shadow-DOM stylesheet may finish loading after map creation; without
    // a recalc the tiles render misaligned.
    const link = this.shadowRoot.querySelector("link");
    link.addEventListener("load", () => this._map.invalidateSize());
    requestAnimationFrame(() => this._map.invalidateSize());
  }

  _buildLayerToggles() {
    if (!this._layerTogglesEl) return;
    this._layerTogglesEl.textContent = "";
    let anyEnabled = false;
    for (const key of OVERLAY_ORDER) {
      if (!this._overlayLayers[key]) continue;
      anyEnabled = true;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ltbtn" + (this._overlayActive[key] ? " active" : "");
      btn.title = OVERLAY_LABELS[key];
      btn.setAttribute("aria-label", OVERLAY_LABELS[key]);
      btn.setAttribute("data-layer", key);
      // Coloured swatch SVG: filled when active, grey outline when inactive.
      btn.innerHTML = this._layerToggleSvg(key, this._overlayActive[key]);
      btn.addEventListener("click", () => this._toggleOverlay(key));
      this._layerTogglesEl.appendChild(btn);
    }
    this._layerTogglesEl.hidden = !anyEnabled;
  }

  _layerToggleSvg(key, active) {
    const fill = active ? OVERLAY_COLORS[key] : "none";
    const stroke = active ? OVERLAY_COLORS[key] : "#aaa";
    return `<svg width="18" height="18" viewBox="0 0 18 18">` +
      `<rect x="2" y="2" width="14" height="14" rx="2" ry="2"` +
      ` fill="${fill}" stroke="${stroke}" stroke-width="2"/>` +
      `</svg>`;
  }

  _toggleOverlay(key) {
    this._overlayActive[key] = !this._overlayActive[key];
    // Update the toggle button appearance.
    if (this._layerTogglesEl) {
      const btn = this._layerTogglesEl.querySelector(`[data-layer="${key}"]`);
      if (btn) {
        btn.classList.toggle("active", this._overlayActive[key]);
        btn.innerHTML = this._layerToggleSvg(key, this._overlayActive[key]);
      }
    }
    // Clear or redraw the overlay canvas immediately.
    const layer = this._overlayLayers[key];
    if (layer) {
      if (!this._overlayActive[key]) {
        layer.setFrame(null, null);
      } else {
        // Redraw the current frame with this overlay now active.
        this._showOverlaysForFrame(this._frameIndex);
      }
    }
    this._updateOverlayLegend();
  }

  /* ---------- data ---------- */

  async _loadData(earlyFetch) {
    const epoch = this._epoch;
    if (earlyFetch) {
      // Init path: manifest + first frame were already fetched in parallel with
      // Leaflet. Joining here avoids a redundant round-trip.
      await earlyFetch;
      if (this._epoch !== epoch) return;
      this._hideBanner();
    } else {
      // Refresh-timer path (or init retry after earlyFetch error): fetch fresh.
      await this._refreshManifest(true);
      // Guard: bail if _teardown fired while awaiting the manifest so we don't
      // show a stale frame, set _dataReady, or spin an autoplay loop on a card
      // that is no longer attached.
      if (this._epoch !== epoch) return;
      this._hideBanner();
      const idx = this._lastMeasurementIndex();
      await this._ensureFrame(this._frames[idx].url);
      if (this._epoch !== epoch) return;
    }
    const idx = this._lastMeasurementIndex();
    this._showFrame(idx);
    this._prefetch(idx);
    this._timeline.hidden = false;
    this._playBtn.hidden = false;
    // Set only after the first frame is confirmed shown so a failed frame
    // fetch keeps _dataReady false and the timer retries the full _loadData.
    this._dataReady = true;
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
      .map((p) => {
        const f = {
          url: p.radar_url.replace(/^\/+/, ""),
          type: p.data_type,
          day: p.day,
          timepoint: p.timepoint,
          ts: p.timestamp,
        };
        // All 216 forecast frames carry overlay URLs; measurement frames do not.
        // Store them (leading slash stripped) so _showFrame can fetch them.
        if (p.data_type === "forecast") {
          if (p.snow_url) f.snow_url = p.snow_url.replace(/^\/+/, "");
          if (p.snowrain_url) f.snowrain_url = p.snowrain_url.replace(/^\/+/, "");
          if (p.freezingrain_url) f.freezingrain_url = p.freezingrain_url.replace(/^\/+/, "");
        }
        return f;
      })
      .sort((a, b) => a.ts - b.ts);
    if (!frames.length) throw new Error("no frames in animation.json");

    frames = this._applyTimeSpan(frames);
    for (const f of frames) {
      f.shortLabel = `${weekdayShort(f.ts)} ${f.day.slice(0, 3)} · ${f.timepoint}`;
    }

    const prevTs = this._frames[this._frameIndex]
      ? this._frames[this._frameIndex].ts
      : null;
    this._animVersion = version;
    this._frames = frames;
    // Cap entry count at manifest size + margin; the byte budget (DECODE_CACHE_BYTES)
    // is the primary limit, but the entry count prevents growth on abnormally large
    // manifests. Path2D cache is deliberately NOT grown: it stays at PATH_CACHE_SIZE
    // because _reset() clears it on every pan/zoom and rebuild is ~0.73 ms.
    this._cacheMax = frames.length + 10;
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

    // Keep the playhead on the same moment across a manifest rollover, and
    // redraw so a paused card stops showing the previous version's imagery:
    // RadarLayer keeps rendering the last url it was handed, so re-anchoring
    // the label/knob alone leaves stale pixels under a moved marker.
    if (prevTs != null) {
      const idx = this._reanchorIndex(prevTs);
      if (this._playing) {
        // Playback redraws every tick in its advance loop; a jump here would
        // fight it, so only re-anchor the markers and let the loop continue.
        this._frameIndex = idx;
        this._moveMarkers(idx);
      } else {
        this._jumpTo(idx); // ensures + shows the frame and prefetches
      }
    }
    if (this._playMode === "window") this._computeWindow();
    // A successful manifest refresh means the network is back: resume the mode
    // an earlier outage paused (no-op otherwise).
    this._maybeResumeAfterFailure();
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
    this._updateOverlayLegend();
  }

  _updateOverlayLegend() {
    if (!this._overlaySwatch) return;
    // Respect an explicit legend:false — the swatches live inside the legend
    // panel, so forcing it visible below would override the user's config.
    const legendOff = this._config && this._config.legend === false;
    // Collect which overlays are currently active and have a layer.
    const active = legendOff
      ? []
      : OVERLAY_ORDER.filter(
          (key) => this._overlayLayers[key] && this._overlayActive[key]
        );
    this._overlaySwatch.textContent = "";
    if (!active.length) {
      this._overlaySwatch.hidden = true;
      return;
    }
    for (const key of active) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const chip = document.createElement("i");
      chip.style.background = OVERLAY_COLORS[key];
      const label = document.createElement("b");
      label.textContent = OVERLAY_LABELS[key];
      cell.appendChild(chip);
      cell.appendChild(label);
      this._overlaySwatch.appendChild(cell);
    }
    this._overlaySwatch.hidden = false;
    // Ensure the parent legend panel is visible (legend may be from a manifest
    // with no rate bands but the user still wants overlay swatches).
    if (this._legendEl) this._legendEl.hidden = false;
  }

  /* Hour labels sit right of a small separator at each 6-h mark; the date
   * label sits right of the day-change line, which runs continuously from
   * the bottom of the date row up through the hour row.
   *
   * Separators are positioned in pixels (not percentages) to snap to the
   * device pixel grid and render at consistent thickness. Positions are
   * recomputed on resize to stay aligned with labels when the card width
   * changes. */
  _buildTimelineLabels() {
    if (!this._config.time_axis || this._frames.length < 2) return;
    const frames = this._frames;
    const t0 = frames[0].ts;
    const t1 = frames[frames.length - 1].ts;
    const span = t1 - t0;
    const rowWidth = this._hoursRow.offsetWidth;
    this._hoursRow.textContent = "";
    this._datesRow.textContent = "";
    const firstHour = Math.ceil(t0 / 3600) * 3600;
    for (let t = firstHour; t <= t1; t += 3600) {
      const d = new Date(t * 1000);
      if (d.getHours() % 6 !== 0) continue;
      const percentX = ((t - t0) / span) * 100;
      if (percentX < 0.5 || percentX > 91) continue; // left-aligned labels need room
      if (d.getHours() !== 0) {
        // midnight gets the continuous day line instead of a short one
        const sep = document.createElement("div");
        sep.className = "hsep";
        sep.style.left = Math.round(percentX / 100 * rowWidth) + "px";
        this._hoursRow.appendChild(sep);
      }
      const b = document.createElement("b");
      b.style.left = (Math.round(percentX / 100 * rowWidth) + 4) + "px";
      b.textContent = String(d.getHours()).padStart(2, "0") + ":00";
      this._hoursRow.appendChild(b);
    }
    let t = t0;
    let first = true;
    while (t <= t1) {
      const ds = new Date(t * 1000);
      ds.setHours(0, 0, 0, 0);
      const dayStart = ds.getTime() / 1000;
      // Next local midnight by calendar arithmetic, not +86400s: on a DST
      // fall-back day midnight + 86400s is 23:00 of the same local day, so
      // the next iteration snaps back to the same midnight and the loop
      // spins forever (issue #66). setDate(+1) crosses the real day boundary
      // regardless of the day's length, and fixes the spring-forward day's
      // 01:00 separator offset for free.
      const nd = new Date(dayStart * 1000);
      nd.setDate(nd.getDate() + 1);
      nd.setHours(0, 0, 0, 0);
      const dayEnd = nd.getTime() / 1000;
      const visStart = Math.max(dayStart, t0);
      const visEnd = Math.min(dayEnd, t1);
      const width = ((visEnd - visStart) / span) * 100;
      const percentX = ((visStart - t0) / span) * 100;
      if (!first) {
        const sep = document.createElement("div");
        sep.className = "daysep";
        sep.style.left = Math.round(percentX / 100 * rowWidth) + "px";
        this._datesRow.appendChild(sep);
      }
      if (width >= 4) {
        const d = new Date(visStart * 1000);
        const b = document.createElement("b");
        const pixelOffset = Math.round(percentX / 100 * rowWidth);
        b.style.left = first ? "0" : (pixelOffset + 5) + "px";
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
      if (dayEnd <= t) break; // cheap insurance against any non-advancing step
      t = dayEnd;
    }
  }

  _lastMeasurementIndex() {
    for (let i = this._frames.length - 1; i >= 0; i--) {
      if (this._frames[i].type === "measurement") return i;
    }
    return this._frames.length - 1;
  }

  // Where the playhead lands after a manifest rollover. Usually the frame
  // nearest the moment we were showing. But a card paused for hours can sit
  // on a moment that has since scrolled off the (trimmed) timeline; the
  // nearest frame is then an unrelated edge frame, so a paused card snaps to
  // the latest measurement rather than showing a stale-but-wrong moment. A
  // playing card always tracks the nearest frame so its advance loop resumes
  // from the same position.
  _reanchorIndex(prevTs) {
    const nearest = this._nearestIndexByTs(prevTs);
    if (this._playing) return nearest;
    const first = this._frames[0];
    const last = this._frames[this._frames.length - 1];
    if (!first || !last) return nearest;
    if (prevTs < first.ts || prevTs > last.ts) return this._lastMeasurementIndex();
    return nearest;
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
        // Re-show the banner if the retry _loadData also fails mid-fetch
        // (e.g. frame 502 after manifest succeeded) so the user sees it.
        if (!this._dataReady) this._showBanner("Radar data is currently unavailable");
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
    // Remove and re-account an existing entry being overwritten.
    if (this._cache.has(url)) {
      this._cacheBytes -= this._cacheSizes.get(url) || 0;
      this._cacheSizes.delete(url);
      this._cache.delete(url);
    }
    const bytes = frameBytes(v);
    this._cache.set(url, v);
    this._cacheSizes.set(url, bytes);
    this._cacheBytes += bytes;
    // Evict LRU while either limit (byte budget or entry count) is exceeded.
    while (
      this._cache.size > this._cacheMax ||
      this._cacheBytes > DECODE_CACHE_BYTES
    ) {
      const oldest = this._cache.keys().next().value;
      this._cacheBytes -= this._cacheSizes.get(oldest) || 0;
      this._cacheSizes.delete(oldest);
      this._cache.delete(oldest);
    }
  }

  _ensureFrame(url) {
    const cached = this._cacheGet(url);
    if (cached) return Promise.resolve(cached);
    const pending = this._pending.get(url);
    if (pending) return pending;
    // Back off a recently failed frame: the playback loop asks for the same
    // url every ~300 ms, so without this a router reboot would burn the whole
    // fail streak in ~2 s and hammer the network. Hold the current frame and
    // let the next real attempt wait out FRAME_RETRY_BACKOFF_MS.
    const until = this._retryAfter.get(url);
    if (until != null && Date.now() < until) {
      return Promise.reject(new Error("frame retry backoff"));
    }
    const p = this._api(url)
      .then((frame) => {
        const areas = decodeFrame(frame);
        this._pending.delete(url);
        this._retryAfter.delete(url);
        this._cachePut(url, areas);
        this._failStreak = 0;
        if (this._dataReady) this._hideBanner();
        // Network is back: resume the mode the outage paused, if any.
        this._maybeResumeAfterFailure();
        return areas;
      })
      .catch((err) => {
        this._pending.delete(url);
        this._retryAfter.set(url, Date.now() + FRAME_RETRY_BACKOFF_MS);
        this._pruneRetryAfter();
        this._failStreak += 1;
        // A vanished frame usually means the manifest rolled over upstream.
        if (this._is404(err)) this._refreshAfter404();
        if (this._failStreak >= FAIL_STREAK_LIMIT) this._beginFailurePause();
        throw err;
      });
    this._pending.set(url, p);
    return p;
  }

  // Fetch an overlay frame best-effort: no fail-streak increment, no retry
  // backoff. Only radar_url drives degradation/recovery; overlay failures are
  // silently swallowed so they never pause playback or trigger the banner.
  _ensureOverlayFrame(url) {
    const cached = this._cacheGet(url);
    if (cached) return Promise.resolve(cached);
    const pending = this._pending.get(url);
    if (pending) return pending;
    const p = this._api(url)
      .then((frame) => {
        const areas = decodeFrame(frame);
        this._pending.delete(url);
        this._cachePut(url, areas);
        return areas;
      })
      .catch((err) => {
        this._pending.delete(url);
        throw err;
      });
    this._pending.set(url, p);
    return p;
  }

  // Keep _retryAfter from growing without bound over a long-running card:
  // frames roll off the manifest, so drop entries whose backoff has expired.
  _pruneRetryAfter() {
    if (this._retryAfter.size <= 128) return;
    const now = Date.now();
    for (const [u, t] of this._retryAfter) {
      if (t <= now) this._retryAfter.delete(u);
    }
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

  /* ---------- failure recovery ---------- */

  // Fail streak crossed the limit. Pause, but remember the active loop so a
  // later successful fetch or manifest refresh can restart it (defect: an
  // autoplay wall tablet used to stay frozen forever after a short outage).
  _beginFailurePause() {
    if (this._playing && (this._playMode === "window" || this._playMode === "full")) {
      this._pausedByFailure = this._playMode;
      this._pause();
      this._startRecoveryTimer();
    }
    this._showBanner("Radar frames unavailable — retrying");
  }

  // Called from both recovery signals the issue names: a first successful
  // frame fetch (_ensureFrame) and a successful manifest refresh. No-op unless
  // an outage paused us and the user has not since taken manual control.
  _maybeResumeAfterFailure() {
    const mode = this._pausedByFailure;
    if (!mode || this._playing) return;
    this._pausedByFailure = null;
    this._stopRecoveryTimer();
    this._hideBanner();
    this._startPlay(mode);
  }

  // User took manual control (play button or scrub): never auto-resume a
  // stale mode on top of their choice.
  _clearFailureRecovery() {
    this._pausedByFailure = null;
    this._stopRecoveryTimer();
  }

  // While failure-paused the RAF loop is gone and the manifest timer only
  // fires every 5 min, so probe on a shorter cadence. A live probe reaching
  // the network resumes via _maybeResumeAfterFailure and stops this timer.
  _startRecoveryTimer() {
    if (this._recoveryTimer) return;
    this._recoveryTimer = setInterval(() => {
      this._refreshManifest(true).catch(() => {});
      const f = this._frames[this._frameIndex];
      if (f) this._ensureFrame(f.url).catch(() => {});
    }, RECOVERY_INTERVAL_MS);
  }

  _stopRecoveryTimer() {
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }
  }

  /* ---------- playback ---------- */

  /* The play button cycles: paused -> window (the configured relevant
   * range around now, looping) -> full timeline -> paused. */
  _togglePlay() {
    // Manual control overrides any pending failure auto-resume.
    this._clearFailureRecovery();
    if (this._playMode === "window") this._startPlay("full");
    else if (this._playMode === "full") this._pause();
    else this._startPlay("window");
  }

  _computeWindow() {
    const lastMeas = this._frames[this._lastMeasurementIndex()];
    const now = lastMeas ? lastMeas.ts : this._t0;
    const past = Number(this._config.play_past_hours);
    const fc = Number(this._config.play_forecast_hours);
    let endTs = now + (Number.isFinite(fc) ? fc : 8) * 3600;
    // play_forecast_until ("HH:MM"): play at least until the next
    // occurrence of that clock time - the longer of the two bounds wins.
    const until = this._config.play_forecast_until;
    if (typeof until === "string" && /^\d{1,2}:\d{2}/.test(until)) {
      const parts = until.split(":");
      const d = new Date(now * 1000);
      d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
      let ts = d.getTime() / 1000;
      if (ts <= now) ts += 86400;
      if (ts > endTs) endTs = ts;
    }
    this._winStart = this._nearestIndexByTs(
      now - (Number.isFinite(past) ? past : 1) * 3600
    );
    this._winEnd = this._nearestIndexByTs(endTs);
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
    // Scrubbing is a manual pause; never auto-resume over it.
    this._clearFailureRecovery();
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
    const upcoming = [];
    if (this._playMode === "window" && this._winEnd !== undefined) {
      // In window mode wrap within [_winStart, _winEnd] so near the window end
      // we warm the loop-start frames instead of out-of-window frames.
      const len = this._winEnd - this._winStart + 1;
      if (len <= 0) return;
      for (let k = 1; k <= PREFETCH_AHEAD; k++) {
        const pos = ((idx - this._winStart + k * s) % len + len) % len;
        const f = this._frames[this._winStart + pos];
        if (f) { this._ensureFrame(f.url).catch(() => {}); upcoming.push(f); }
      }
    } else {
      for (let k = 1; k <= PREFETCH_AHEAD; k++) {
        const f = this._frames[(idx + k * s) % this._frames.length];
        if (f) { this._ensureFrame(f.url).catch(() => {}); upcoming.push(f); }
      }
    }
    // Prefetch overlay frames for upcoming positions, best-effort.
    for (const key of OVERLAY_ORDER) {
      if (!this._overlayLayers[key] || !this._overlayActive[key]) continue;
      for (const f of upcoming) {
        const url = f[OVERLAY_URL_KEY[key]];
        if (url) this._ensureOverlayFrame(url).catch(() => {});
      }
    }
  }

  _showFrame(idx) {
    const f = this._frames[idx];
    const areas = this._cacheGet(f.url);
    if (!areas || !this._radar) return;
    this._frameIndex = idx;
    this._radar.setFrame(f.url, areas);
    this._moveMarkers(idx);
    this._showOverlaysForFrame(idx);
  }

  _showOverlaysForFrame(idx) {
    const f = this._frames[idx];
    if (!f) return;
    for (const key of OVERLAY_ORDER) {
      const layer = this._overlayLayers[key];
      if (!layer) continue;
      if (!this._overlayActive[key]) {
        layer.setFrame(null, null);
        continue;
      }
      const url = f[OVERLAY_URL_KEY[key]];
      if (!url) {
        // Measurement frame or frame without this overlay — clear the canvas.
        layer.setFrame(null, null);
        continue;
      }
      const areas = this._cacheGet(url);
      if (areas) {
        layer.setFrame(url, areas);
      } else {
        // Fetch best-effort; draw when ready if the playhead still matches.
        this._ensureOverlayFrame(url)
          .then((a) => { if (this._frameIndex === idx) layer.setFrame(url, a); })
          .catch(() => {});
      }
    }
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
    // shortLabel is precomputed at manifest-parse time; fall back for safety.
    const mainText = f.shortLabel || `${weekdayShort(f.ts)} ${f.day.slice(0, 3)} · ${f.timepoint}`;
    const large = !!this._config.large_label;
    this._label.classList.toggle("large", large);
    // Only write textContent when the value actually changed to avoid layout thrash.
    if (this._labelL1 && this._labelL1.textContent !== mainText) this._labelL1.textContent = mainText;
    if (this._labelL2) {
      this._labelL2.hidden = !large;
      // Compact label: chip color already tells measurement vs forecast.
      if (large && this._labelL2.textContent !== type) this._labelL2.textContent = type;
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
  play_forecast_until: "Window: at least until (HH:MM, optional)",
  legend: "Legend",
  attribution: "Attribution",
  time_axis: "Time labels",
  large_label: "Large time label",
  layer_snow: "Snow overlay",
  layer_snowrain: "Sleet overlay",
  layer_freezing_rain: "Freezing rain overlay",
  layer_lightning: "Lightning overlay",
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
  // Layer toggles: false = overlay button hidden; true = button shown, overlay starts off.
  layer_snow: false,
  layer_snowrain: false,
  layer_freezing_rain: false,
  layer_lightning: false,
  // Wall-tablet auto-on: true = overlay toggled on at card load (requires matching layer_<x>: true).
  layer_snow_on: false,
  layer_snowrain_on: false,
  layer_freezing_rain_on: false,
  layer_lightning_on: false,
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

const AUTOPLAY_FIELD = {
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
};

const WINDOW_GRID = {
  type: "grid",
  name: "",
  schema: [
    { name: "play_past_hours", selector: { number: { min: 0, max: 12, step: 0.5, mode: "box" } } },
    { name: "play_forecast_hours", selector: { number: { min: 0, max: 33, step: 0.5, mode: "box" } } },
  ],
};

const WINDOW_UNTIL_FIELD = {
  name: "play_forecast_until",
  selector: { text: {} },
};

const SPEED_GRID = {
  type: "grid",
  name: "",
  schema: [
    { name: "frame_duration", selector: { number: { min: 100, max: 1500, step: 50, mode: "box" } } },
    { name: "frame_stride", selector: { number: { min: 1, max: 6, step: 1, mode: "box" } } },
  ],
};

const EDITOR_SECTIONS = [
  {
    key: "playback",
    icon: "mdi:play-circle-outline",
    title: "Playback",
    reset: [
      "autoplay_mode",
      "play_past_hours",
      "play_forecast_hours",
      "play_forecast_until",
      "frame_duration",
      "frame_stride",
      "autoplay",
    ],
    // Window bounds only make sense in window mode - the schema is
    // rebuilt when the autoplay mode changes.
    buildSchema: (data) => [
      AUTOPLAY_FIELD,
      ...(data.autoplay_mode === "window" ? [WINDOW_GRID, WINDOW_UNTIL_FIELD] : []),
      SPEED_GRID,
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
  {
    key: "layers",
    icon: "mdi:layers-outline",
    title: "Layers",
    reset: [
      "layer_snow", "layer_snowrain", "layer_freezing_rain", "layer_lightning",
      "layer_snow_on", "layer_snowrain_on", "layer_freezing_rain_on", "layer_lightning_on",
    ],
    // defaultOff: true → chip shows ON when value === true (default is false = hidden).
    chips: [
      { key: "layer_snow", label: "Snow", defaultOff: true },
      { key: "layer_snowrain", label: "Sleet", defaultOff: true },
      { key: "layer_freezing_rain", label: "Freezing rain", defaultOff: true },
      { key: "layer_lightning", label: "Lightning", defaultOff: true },
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
      } else if (key in EDITOR_DEFAULTS && config[key] === EDITOR_DEFAULTS[key]) {
        // Drop keys left at their default so we do not bloat the user's YAML
        // and future default changes still reach them. Non-default values
        // (including booleans set to false) survive the strict equality check.
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

  _makeForm(schema, def) {
    const form = document.createElement("ha-form");
    form.computeLabel = (item) => EDITOR_LABELS[item.name] || item.name;
    if (schema) form.schema = schema;
    if (def) form._sectionDef = def;
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
        def.chips ? this._makeChips(def) : this._makeForm(def.schema, def)
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
        if (chip.defaultOff) {
          // Default is false/hidden: chip ON means value === true.
          const on = this._data()[chip.key] === true;
          if (on) delete config[chip.key]; // restore to default (false)
          else config[chip.key] = true;    // enable
        } else {
          // Default is true/shown: chip ON means value !== false.
          const on = this._data()[chip.key] !== false;
          if (on) config[chip.key] = false;
          else delete config[chip.key]; // restore to default (true)
        }
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
      const def = form._sectionDef;
      if (def && def.buildSchema && form._schemaMode !== data.autoplay_mode) {
        form.schema = def.buildSchema(data);
        form._schemaMode = data.autoplay_mode;
      }
      form.data = data;
    }
    if (!this._summaryEls) return;
    const playback =
      (data.autoplay_mode === "window"
        ? `Window −${data.play_past_hours} h → +${data.play_forecast_hours} h` +
          (data.play_forecast_until
            ? ` or until ${String(data.play_forecast_until).slice(0, 5)}`
            : "")
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
      // Collect all chip definitions to determine each chip's defaultOff flag.
      const chipDefs = {};
      for (const def of EDITOR_SECTIONS) {
        if (def.chips) for (const chip of def.chips) chipDefs[chip.key] = chip;
      }
      for (const key of Object.keys(this._chipEls)) {
        const chip = chipDefs[key];
        const on = chip && chip.defaultOff
          ? data[key] === true
          : data[key] !== false;
        this._chipEls[key].classList.toggle("on", on);
      }
    }
    // Build the layers summary line.
    if (this._summaryEls && this._summaryEls.layers) {
      const activeLayerLabels = [
        data.layer_snow === true && "Snow",
        data.layer_snowrain === true && "Sleet",
        data.layer_freezing_rain === true && "Freezing rain",
        data.layer_lightning === true && "Lightning",
      ].filter(Boolean);
      this._summaryEls.layers.textContent = activeLayerLabels.length
        ? activeLayerLabels.join(" · ")
        : "all off";
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
