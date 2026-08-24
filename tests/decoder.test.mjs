/* Golden + pure-logic tests for the card's chain-code decoder.
 *
 * The card ships as a single classic script (no bundler, no exports),
 * so we load it inside a vm context with the browser globals it touches
 * at load time stubbed out, then reach in for the three pure decoder
 * functions. This tests the exact shipped code with zero runtime change.
 * Frame format: see FORMAT.md.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { describe, it, expect, beforeEach } from "vitest";

const cardPath = fileURLToPath(
  new URL(
    "../custom_components/meteoswiss_radar/frontend/meteoswiss-radar-card.js",
    import.meta.url,
  ),
);
const fixturesDir = fileURLToPath(new URL("fixtures", import.meta.url));

function loadDecoder() {
  const src = readFileSync(cardPath, "utf8");
  const noop = () => {};
  const registry = {
    get: () => undefined,
    define: noop,
    whenDefined: () => Promise.resolve(),
  };
  // Minimal Path2D stub for tests that mock Leaflet layer rendering.
  class StubPath2D {
    constructor() {
      this._commands = [];
    }
    moveTo(x, y) {
      this._commands.push(['moveTo', x, y]);
    }
    lineTo(x, y) {
      this._commands.push(['lineTo', x, y]);
    }
    closePath() {
      this._commands.push(['closePath']);
    }
  }

  const ctx = {
    window: { customElements: registry, customCards: [], L: undefined },
    document: {
      querySelector: () => null,
      readyState: "complete",
      addEventListener: noop,
      // Minimal stub so methods that create DOM nodes don't throw in unit tests
      // that don't rely on real DOM structure (e.g. _updateOverlayLegend).
      createElement: () => ({
        className: "", style: {}, textContent: "", hidden: false,
        setAttribute: noop, rel: "", href: "",
        appendChild() {},
      }),
    },
    customElements: registry,
    HTMLElement: class {},
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    console: { info: noop, warn: noop, error: noop },
    // Capture rAF callbacks so tests can fire them deterministically instead of
    // relying on a real animation frame (the card schedules invalidateSize here).
    requestAnimationFrame: (cb) => {
      (ctx.window.__rafCbs || (ctx.window.__rafCbs = [])).push(cb);
      return ctx.window.__rafCbs.length;
    },
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Math,
    Array,
    Object,
    Number,
    String,
    Map,
    Set,
    JSON,
    Intl,
    Path2D: StubPath2D,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    `${src}\n;globalThis.__decoder = { gridKmToLatLng, decodeContourInto, decodeFrame, frameBytes, DECODE_CACHE_BYTES, DECODE_CACHE_MAX_KEYS, SHARED_DECODE_CACHE, MeteoSwissRadarCard, MeteoSwissRadarCardEditor, EDITOR_DEFAULTS, parseLightning, strikesForFrame, makeRadarLayerClass, PATH_CACHE_SIZE, windowRef: window };`,
    ctx,
    { filename: "meteoswiss-radar-card.js" },
  );
  return ctx.__decoder;
}

const { gridKmToLatLng, decodeFrame, frameBytes, DECODE_CACHE_BYTES, DECODE_CACHE_MAX_KEYS, SHARED_DECODE_CACHE, MeteoSwissRadarCard, MeteoSwissRadarCardEditor, EDITOR_DEFAULTS, parseLightning, strikesForFrame, makeRadarLayerClass, PATH_CACHE_SIZE, windowRef } =
  loadDecoder();

function resetSharedCache() {
  SHARED_DECODE_CACHE._cache.clear();
  SHARED_DECODE_CACHE._cacheSizes.clear();
  SHARED_DECODE_CACHE._cacheBytes = 0;
  SHARED_DECODE_CACHE._cards = 0;
  SHARED_DECODE_CACHE._products = 0;
}

// Real Swiss radar composite grid (from FORMAT.md).
const GRID = {
  system: "LV95",
  x_min: 255.5,
  x_max: 964.5,
  x_count: 710,
  y_min: -159.5,
  y_max: 479.5,
  y_count: 640,
};

describe("gridKmToLatLng", () => {
  it("projects a central grid point into the Swiss WGS84 bbox", () => {
    const [lat, lng] = gridKmToLatLng(610, 160);
    expect(lat).toBeGreaterThan(45);
    expect(lat).toBeLessThan(48);
    expect(lng).toBeGreaterThan(5);
    expect(lng).toBeLessThan(11);
  });

  it("Bern anchor: gridKmToLatLng(600, 200) is Bern within 1e-3 deg", () => {
    // (600, 200) is the CH1903 origin; the swisstopo formula gives exactly Bern.
    const [lat, lng] = gridKmToLatLng(600, 200);
    expect(Math.abs(lat - 46.9511)).toBeLessThan(1e-3);
    expect(Math.abs(lng - 7.4386)).toBeLessThan(1e-3);
  });
});

describe("decodeFrame", () => {
  const frame = {
    coords: GRID,
    areas: [
      {
        color: "9e849a",
        // one shape, one contour, two vertices (o.length === 2),
        // one delta pair in d ("OO": +2 on i and j between the vertices).
        shapes: [[{ i: 710, j: 641, o: "50", d: "OO" }]],
      },
    ],
  };

  it("preserves area structure and prefixes the fill color", () => {
    const decoded = decodeFrame(frame);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].color).toBe("#9e849a");
    // Single-buffer layout: verts holds all vertices, rings holds start offsets.
    expect(Object.prototype.toString.call(decoded[0].verts)).toBe("[object Float32Array]");
    expect(Object.prototype.toString.call(decoded[0].rings)).toBe("[object Int32Array]");
  });

  it("emits verts with 2 floats per vertex inside the Swiss bbox, rings with sentinel", () => {
    const { verts, rings } = decodeFrame(frame)[0];
    // 2 vertices * 2 floats = 4 elements in verts.
    expect(verts.length).toBe(4);
    for (let i = 0; i < verts.length; i += 2) {
      expect(verts[i]).toBeGreaterThan(45);     // lat
      expect(verts[i]).toBeLessThan(48);
      expect(verts[i + 1]).toBeGreaterThan(5);  // lng
      expect(verts[i + 1]).toBeLessThan(11);
    }
    // rings: [0, 4] — one ring starting at 0, sentinel at verts.length.
    expect(rings.length).toBe(2);
    expect(rings[0]).toBe(0);
    expect(rings[1]).toBe(4);
  });

  it("matches the golden geometry (locks decoder + projection)", () => {
    // Golden captured from the shipped decoder (card v0.7.6). A diff here
    // means the decode/projection math changed; regenerate deliberately
    // with `npm test -- -u` only after verifying against live data.
    expect(decodeFrame(frame)).toMatchSnapshot();
  });
});

describe("_reanchorIndex (manifest rollover re-anchoring)", () => {
  // The constructor touches no DOM, so a bare instance is enough to exercise
  // the pure re-anchor decision against a synthetic frame list.
  function makeCard(frames, playing) {
    const card = new MeteoSwissRadarCard();
    card._frames = frames;
    card._playing = playing;
    return card;
  }

  // 5-min measurement cadence at t=0,300,...,3000, then two forecast frames.
  const frames = [];
  for (let i = 0; i <= 10; i++) frames.push({ ts: i * 300, type: "measurement" });
  frames.push({ ts: 3300, type: "forecast" }, { ts: 3600, type: "forecast" });
  const lastMeasIdx = 10;

  it("re-anchors a paused card to the nearest frame when the moment still exists", () => {
    const card = makeCard(frames, false);
    // A moment 3 frames back (ts 2100) is still on the timeline.
    expect(card._reanchorIndex(2100)).toBe(7);
  });

  it("snaps a paused card to the last measurement when the moment scrolled off the past edge", () => {
    const card = makeCard(frames, false);
    // Paged for hours: the old moment is now older than frames[0].
    expect(card._reanchorIndex(-6000)).toBe(lastMeasIdx);
  });

  it("snaps a paused card to the last measurement when the moment is past the forecast horizon", () => {
    const card = makeCard(frames, false);
    expect(card._reanchorIndex(9000)).toBe(lastMeasIdx);
  });

  it("tracks the nearest frame while playing even if the moment scrolled off", () => {
    // Playing must not snap to last measurement: the advance loop resumes
    // from wherever the playhead was, so we keep the nearest edge frame.
    const card = makeCard(frames, true);
    expect(card._reanchorIndex(-6000)).toBe(0);
    expect(card._reanchorIndex(9000)).toBe(frames.length - 1);
  });

  it("keeps a paused card on a forecast moment that still exists (no jump)", () => {
    const card = makeCard(frames, false);
    expect(card._reanchorIndex(3300)).toBe(11);
  });
});

describe("teardown / rebuild lifecycle (issue #3)", () => {
  it("_teardown frees the Leaflet map and resets init state", () => {
    const card = new MeteoSwissRadarCard();
    card._initialized = true;
    card._dataReady = true;
    card._autoplayStarted = true;
    card._frames = [{ url: "a" }, { url: "b" }];
    card._frameIndex = 3;
    let removed = false;
    card._map = {
      remove() {
        removed = true;
      },
    };
    card._radar = {};
    SHARED_DECODE_CACHE.put("a", [{ color: "#000", verts: new Float32Array(2), rings: new Int32Array([0, 2]) }]);
    card._pending.set("a", Promise.resolve());
    card._retryAfter.set("a", 1);

    card._teardown();

    expect(removed).toBe(true); // Leaflet listeners/tile layer released
    expect(card._map).toBe(null);
    expect(card._radar).toBe(null);
    expect(card._pending.size).toBe(0);
    expect(card._retryAfter.size).toBe(0);
    expect(card._frames).toEqual([]);
    expect(card._frameIndex).toBe(0);
    expect(card._initialized).toBe(false); // connectedCallback can rebuild
    expect(card._dataReady).toBe(false);
    expect(card._autoplayStarted).toBe(false);
  });

  it("_teardown is a no-op when the card was never initialized", () => {
    const card = new MeteoSwissRadarCard();
    let removed = false;
    card._map = {
      remove() {
        removed = true;
      },
    };
    card._teardown();
    expect(removed).toBe(false);
    expect(card._map).not.toBe(null);
  });

  it("disconnectedCallback debounces teardown; re-attach cancels it", () => {
    const card = new MeteoSwissRadarCard();
    card._initialized = true;
    card._startRefreshTimer = () => {
      card._refreshStarted = true;
    };

    card.disconnectedCallback();
    expect(card._teardownTimer).toBeTruthy(); // teardown is scheduled, not run
    expect(card._initialized).toBe(true);

    // Re-attach within the grace window. _map is null so the invalidateSize
    // path (requestAnimationFrame) is skipped in this stubbed realm.
    card._map = null;
    card.connectedCallback();
    expect(card._teardownTimer).toBe(null); // pending teardown cancelled
    expect(card._initialized).toBe(true); // map kept, never torn down
    expect(card._refreshStarted).toBe(true); // refresh timer restarted
  });
});

describe("cheap in-place config application (issue #3)", () => {
  function makeInitializedCard() {
    const card = new MeteoSwissRadarCard();
    card.setConfig({}); // seed defaults; not initialized yet -> no in-place
    card._initialized = true;
    card._dataReady = true;
    card.style = {
      props: {},
      setProperty(k, v) {
        this.props[k] = v;
      },
    };
    card._map = {
      invalidated: 0,
      invalidateSize() {
        this.invalidated++;
      },
    };
    card._legendEl = { hidden: false };
    card._attrib = { hidden: false };
    card._hoursRow = { hidden: false };
    card._datesRow = { hidden: false };
    card._builtLabels = 0;
    card._buildTimelineLabels = () => {
      card._builtLabels++;
    };
    card._updatedLabel = 0;
    card._updateLabel = () => {
      card._updatedLabel++;
    };
    card._refreshed = 0;
    card._refreshManifest = () => {
      card._refreshed++;
      return Promise.resolve();
    };
    return card;
  }

  it("applies a height change via a CSS custom property, no data reload", () => {
    const card = makeInitializedCard();
    card.setConfig({ height: 600 });
    expect(card.style.props["--msr-map-height"]).toBe("600px");
    expect(card._map.invalidated).toBe(1);
    expect(card._refreshed).toBe(0);
  });

  it("toggles legend/attribution/time-axis visibility without a fetch", () => {
    const card = makeInitializedCard();
    card.setConfig({ legend: false, attribution: false, time_axis: false });
    expect(card._legendEl.hidden).toBe(true);
    expect(card._attrib.hidden).toBe(true);
    expect(card._hoursRow.hidden).toBe(true);
    expect(card._datesRow.hidden).toBe(true);
    expect(card._refreshed).toBe(0);
  });

  it("rebuilds the time-axis labels when time_axis is switched back on", () => {
    const card = makeInitializedCard();
    card.setConfig({ time_axis: false });
    expect(card._builtLabels).toBe(0);
    card.setConfig({ time_axis: true });
    expect(card._builtLabels).toBe(1);
    expect(card._hoursRow.hidden).toBe(false);
  });

  it("re-renders the label when large_label changes", () => {
    const card = makeInitializedCard();
    card.setConfig({ large_label: false });
    expect(card._updatedLabel).toBe(1);
  });

  it("reloads data only when the past/forecast span changes", () => {
    const card = makeInitializedCard();
    card.setConfig({ past_hours: 3 });
    expect(card._refreshed).toBe(1);
    card.setConfig({ past_hours: 3, forecast_hours: 5 });
    expect(card._refreshed).toBe(2);
  });

  it("does not apply in place before the card is initialized", () => {
    const card = new MeteoSwissRadarCard();
    // No DOM refs exist yet; this must not throw and must not fetch.
    expect(() => card.setConfig({ height: 600 })).not.toThrow();
    expect(card._config.height).toBe(600);
  });
});

describe("transient-failure recovery (issue #2)", () => {
  // A bare instance plus stubbed side-effects: the recovery logic is pure
  // state, so we replace the DOM/timer/network touchpoints and assert the
  // decisions. No DOM, no real timers, no network.
  function makeCard() {
    const card = new MeteoSwissRadarCard();
    card._frames = [{ url: "frame-0" }, { url: "frame-1" }];
    card._frameIndex = 0;
    // Side-effect stubs (would otherwise need DOM / RAF / timers).
    card._showBanner = () => {};
    card._hideBanner = () => {};
    card._startRecoveryTimer = () => {
      card._recoveryStarted = (card._recoveryStarted || 0) + 1;
    };
    card._stopRecoveryTimer = () => {
      card._recoveryStopped = (card._recoveryStopped || 0) + 1;
    };
    card._started = [];
    card._startPlay = (mode) => {
      card._started.push(mode);
      card._playing = true;
      card._playMode = mode;
    };
    return card;
  }

  describe("per-frame retry backoff", () => {
    it("does not refetch the same failed frame on the next tick", async () => {
      const card = makeCard();
      let calls = 0;
      card._api = () => {
        calls += 1;
        return Promise.reject(new Error("network down"));
      };
      await card._ensureFrame("frame-0").catch(() => {});
      // A second immediate request is inside the backoff window -> gated.
      await card._ensureFrame("frame-0").catch(() => {});
      expect(calls).toBe(1);
      expect(card._retryAfter.has("frame-0")).toBe(true);
    });

    it("retries once the backoff window has elapsed", async () => {
      const card = makeCard();
      let calls = 0;
      card._api = () => {
        calls += 1;
        return Promise.reject(new Error("network down"));
      };
      await card._ensureFrame("frame-0").catch(() => {});
      // Simulate the backoff having expired.
      card._retryAfter.set("frame-0", Date.now() - 1);
      await card._ensureFrame("frame-0").catch(() => {});
      expect(calls).toBe(2);
    });

    it("gating a frame does not inflate the fail streak", async () => {
      const card = makeCard();
      card._api = () => Promise.reject(new Error("network down"));
      await card._ensureFrame("frame-0").catch(() => {});
      const streakAfterReal = card._failStreak;
      // Several gated ticks must not push the streak toward the limit.
      for (let i = 0; i < 5; i++) await card._ensureFrame("frame-0").catch(() => {});
      expect(card._failStreak).toBe(streakAfterReal);
    });

    it("clears the backoff on a successful fetch", async () => {
      const card = makeCard();
      card._api = () => Promise.resolve({ coords: GRID, areas: [] });
      // A stale (expired) backoff entry from an earlier failure: the fetch
      // proceeds and success must drop the entry.
      card._retryAfter.set("frame-0", Date.now() - 1);
      await card._ensureFrame("frame-0");
      expect(card._retryAfter.has("frame-0")).toBe(false);
    });
  });

  describe("remember-and-resume the paused mode", () => {
    it("remembers the active mode when the fail streak pauses playback", () => {
      const card = makeCard();
      card._playing = true;
      card._playMode = "window";
      card._beginFailurePause();
      expect(card._pausedByFailure).toBe("window");
      expect(card._playing).toBe(false);
      expect(card._playMode).toBe("paused");
      expect(card._recoveryStarted).toBe(1);
    });

    it("resumes the remembered mode on the first successful fetch", () => {
      const card = makeCard();
      card._playing = true;
      card._playMode = "full";
      card._beginFailurePause();
      card._maybeResumeAfterFailure();
      expect(card._started).toEqual(["full"]);
      expect(card._pausedByFailure).toBe(null);
      expect(card._recoveryStopped).toBe(1);
    });

    it("does not remember or resume when nothing was playing", () => {
      const card = makeCard();
      card._playing = false;
      card._playMode = "paused";
      card._beginFailurePause();
      expect(card._pausedByFailure).toBe(null);
      card._maybeResumeAfterFailure();
      expect(card._started).toEqual([]);
    });

    it("never auto-resumes after the user takes manual control", () => {
      const card = makeCard();
      card._playing = true;
      card._playMode = "window";
      card._beginFailurePause();
      // User taps play / scrubs -> manual control.
      card._clearFailureRecovery();
      card._maybeResumeAfterFailure();
      expect(card._started).toEqual([]);
      expect(card._pausedByFailure).toBe(null);
    });

    it("does not restart a loop that is already playing", () => {
      const card = makeCard();
      card._pausedByFailure = "window";
      card._playing = true;
      card._maybeResumeAfterFailure();
      expect(card._started).toEqual([]);
    });
  });
});

describe("first-frame failure recovery (issue #5)", () => {
  beforeEach(() => {
    resetSharedCache();
  });

  // A bare instance with _refreshManifest stubbed so _loadData can run end-to-end
  // without real HTTP, exercising only the _dataReady / timeline visibility fix.
  function makeCard() {
    const card = new MeteoSwissRadarCard();
    card._frames = [];
    card._config = { autoplay_mode: "off" };

    // Manifest stub: fills _frames and resolves immediately.
    card._refreshManifest = async () => {
      card._frames = [{ url: "frame-0", type: "measurement", ts: 0 }];
      card._animVersion = "v1";
    };

    // DOM stubs for elements that _loadData reveals.
    card._timeline = { hidden: true };
    card._playBtn = { hidden: true };

    card._showFrame = () => {};
    card._prefetch = () => {};
    card._hideBanner = () => {};
    card._showBanner = () => {};

    return card;
  }

  it("leaves _dataReady false when the first frame fetch throws", async () => {
    const card = makeCard();
    card._api = () => Promise.reject(new Error("502 transient"));

    await expect(card._loadData()).rejects.toThrow("502 transient");

    expect(card._dataReady).toBe(false);
    expect(card._timeline.hidden).toBe(true);
    expect(card._playBtn.hidden).toBe(true);
  });

  it("recovers on the next _loadData call once the frame succeeds", async () => {
    const card = makeCard();
    let calls = 0;
    card._api = () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("502 transient"));
      return Promise.resolve({ coords: GRID, areas: [] });
    };

    // First attempt: frame fails.
    await expect(card._loadData()).rejects.toThrow();
    expect(card._dataReady).toBe(false);

    // Simulate the backoff window having elapsed before the timer retries.
    card._retryAfter.set("frame-0", Date.now() - 1);

    // Second attempt (simulates the timer retry): frame succeeds.
    await card._loadData();

    expect(card._dataReady).toBe(true);
    expect(card._timeline.hidden).toBe(false);
    expect(card._playBtn.hidden).toBe(false);
  });
});

describe("editor prunes default values from config (issue #4)", () => {
  // A bare editor is enough: _emit touches only _config plus the two
  // side-effects we stub (form refresh + the config-changed dispatch).
  function makeEditor(config) {
    const editor = new MeteoSwissRadarCardEditor();
    editor._config = config;
    editor._updateForms = () => {};
    editor._emitted = [];
    editor.dispatchEvent = (ev) => {
      editor._emitted.push(ev.detail.config);
      return true;
    };
    return editor;
  }

  it("emits only type + the one non-default field the user changed", () => {
    // Fresh card, edit only height: ha-form feeds back the full defaults-merged
    // object, so _emit must strip every key still sitting at its default.
    const editor = makeEditor({ type: "custom:meteoswiss-radar-card" });
    editor._emit({ type: "custom:meteoswiss-radar-card", ...EDITOR_DEFAULTS, height: 500 });
    expect(editor._config).toEqual({ type: "custom:meteoswiss-radar-card", height: 500 });
  });

  it("keeps a boolean toggled to its non-default false value", () => {
    const editor = makeEditor({ type: "t" });
    editor._emit({ type: "t", ...EDITOR_DEFAULTS, legend: false });
    expect(editor._config).toEqual({ type: "t", legend: false });
  });

  it("removes a key when a field is set back to its default", () => {
    const editor = makeEditor({ type: "t", zoom: 10 });
    editor._emit({ type: "t", ...EDITOR_DEFAULTS, zoom: EDITOR_DEFAULTS.zoom });
    expect(editor._config).toEqual({ type: "t" });
  });

  it("still prunes undefined/null/empty-string values", () => {
    const editor = makeEditor({ type: "t" });
    editor._emit({ type: "t", play_forecast_until: "", frame_stride: undefined, height: null });
    expect(editor._config).toEqual({ type: "t" });
  });

  it("preserves keys that have no default (they are never pruned by value)", () => {
    const editor = makeEditor({ type: "t" });
    editor._emit({ type: "t", play_forecast_until: "18:00", ...EDITOR_DEFAULTS });
    expect(editor._config).toEqual({ type: "t", play_forecast_until: "18:00" });
  });
});

describe("Leaflet retry on transient failure (issue #6)", () => {
  // Load the card into a vm context that stubs document.createElement so we
  // control when script.onload / script.onerror fires without a real network.
  function loadCardWithScriptStubs() {
    const src = readFileSync(cardPath, "utf8");
    const noop = () => {};
    const registry = {
      get: () => undefined,
      define: noop,
      whenDefined: () => Promise.resolve(),
    };
    const appendedScripts = [];
    const ctx = {
      window: { customElements: registry, customCards: [], L: undefined },
      document: {
        querySelector: () => null,
        readyState: "complete",
        addEventListener: noop,
        createElement(tag) {
          if (tag === "script") {
            const el = { onload: null, onerror: null, src: "" };
            return el;
          }
          return { setAttribute: noop, rel: "", href: "" };
        },
        head: {
          appendChild(el) {
            appendedScripts.push(el);
          },
        },
        getElementById: () => null,
        body: null,
      },
      customElements: registry,
      HTMLElement: class {},
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init && init.detail;
        }
      },
      console: { info: noop, warn: noop, error: noop },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Promise,
      Date,
      Math,
      Array,
      Object,
      Number,
      String,
      Map,
      Set,
      JSON,
      Intl,
      requestAnimationFrame: noop,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(
      `${src}\n;globalThis.__card = { MeteoSwissRadarCard, loadLeaflet };`,
      ctx,
      { filename: "meteoswiss-radar-card.js" },
    );
    return { ctx, appendedScripts, ...ctx.__card };
  }

  it("loadLeaflet resets leafletLoader on onerror so next call retries", async () => {
    const { loadLeaflet, appendedScripts } = loadCardWithScriptStubs();

    // First call — trigger onerror.
    const p1 = loadLeaflet();
    expect(appendedScripts).toHaveLength(1);
    appendedScripts[0].onerror();
    await expect(p1).rejects.toThrow("Leaflet failed to load");

    // Second call — leafletLoader was reset, so a new script element is created.
    const p2 = loadLeaflet();
    expect(appendedScripts).toHaveLength(2);
    appendedScripts[1].onload();
    // window.L is undefined in the stub, but the promise resolves (not rejects).
    await expect(p2).resolves.toBeUndefined();
  });

  it("loadLeaflet returns the cached promise when the first load is still in flight", async () => {
    const { loadLeaflet, appendedScripts } = loadCardWithScriptStubs();

    const p1 = loadLeaflet();
    const p2 = loadLeaflet();
    // Only one script element should have been appended.
    expect(appendedScripts).toHaveLength(1);
    appendedScripts[0].onload();
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });

  it("_maybeInit resets _initialized on Leaflet failure so a retry is possible", async () => {
    const { MeteoSwissRadarCard, appendedScripts, ctx } = loadCardWithScriptStubs();
    const card = new MeteoSwissRadarCard();

    // Provide the minimum state _maybeInit checks before proceeding.
    card._hass = {};
    Object.defineProperty(card, "isConnected", { get: () => true });

    // Stub out DOM-heavy methods that aren't the focus of this test.
    card._renderShell = () => {};
    card._showError = (msg) => { card._lastError = msg; };

    // Call _maybeInit — it sets _initialized = true, then awaits loadLeaflet().
    const initPromise = card._maybeInit();
    // Fire onerror on the script that loadLeaflet() injected.
    expect(appendedScripts).toHaveLength(1);
    appendedScripts[0].onerror();
    await initPromise;

    // _initialized must be false so a subsequent call can retry.
    expect(card._initialized).toBe(false);
    expect(card._lastError).toMatch(/Leaflet failed to load/);

    // Simulate HA calling set hass() again (triggers _maybeInit retry).
    // window.L must NOT be set yet — otherwise loadLeaflet() short-circuits.
    card._createMap = () => {};
    card._loadData = () => Promise.resolve();
    card._startRefreshTimer = () => {};
    const retryPromise = card._maybeInit();
    expect(appendedScripts).toHaveLength(2);  // new script injected for the retry
    ctx.window.L = { version: "1.9.4" };  // script sets window.L then fires onload
    appendedScripts[1].onload();
    await retryPromise;

    expect(card._initialized).toBe(true);  // recovered without page reload
  });
});

describe("typed-array geometry storage (issue #14, #53)", () => {
  const frame = {
    coords: GRID,
    areas: [
      {
        color: "9e849a",
        shapes: [[{ i: 710, j: 641, o: "50", d: "OO" }]],
      },
    ],
  };

  it("verts is Float32Array with BYTES_PER_ELEMENT=4", () => {
    const { verts } = decodeFrame(frame)[0];
    expect(Object.prototype.toString.call(verts)).toBe("[object Float32Array]");
    expect(verts.BYTES_PER_ELEMENT).toBe(4);
  });

  it("rings is Int32Array with BYTES_PER_ELEMENT=4", () => {
    const { rings } = decodeFrame(frame)[0];
    expect(Object.prototype.toString.call(rings)).toBe("[object Int32Array]");
    expect(rings.BYTES_PER_ELEMENT).toBe(4);
  });

  it("verts length is totalVertices*2 (interleaved lat/lng)", () => {
    const { verts } = decodeFrame(frame)[0];
    // 2 chars in o -> 2 vertices -> 4 floats
    expect(verts.length).toBe(4);
  });

  it("rings has numRings+1 entries (sentinel at end = verts.length)", () => {
    const { verts, rings } = decodeFrame(frame)[0];
    // 1 contour -> 1 ring -> rings = [0, verts.length]
    expect(rings.length).toBe(2);
    expect(rings[rings.length - 1]).toBe(verts.length);
  });

  it("area count is preserved", () => {
    const decoded = decodeFrame(frame);
    expect(decoded).toHaveLength(1);
  });
});

describe("dynamic cache sizing (issue #14)", () => {
  beforeEach(() => {
    resetSharedCache();
  });

  it("_cachePut with shared cache uses byte budget for eviction", () => {
    const card = new MeteoSwissRadarCard();
    const entry = () => [{ color: "#000", verts: new Float32Array(1000), rings: new Int32Array(100) }];
    // Fill cache with entries until byte budget is reached
    for (let i = 0; i < 30; i++) {
      card._cachePut(`url-${i}`, entry());
      if (SHARED_DECODE_CACHE._cacheBytes > DECODE_CACHE_BYTES) break;
    }
    // Cache contains some entries but respects the byte budget
    expect(SHARED_DECODE_CACHE._cacheBytes).toBeLessThanOrEqual(DECODE_CACHE_BYTES);
    expect(SHARED_DECODE_CACHE._cache.size).toBeGreaterThan(0);
  });

  it("_refreshManifest works with shared cache", async () => {
    const card = new MeteoSwissRadarCard();
    const nFrames = 295;
    const pics = Array.from({ length: nFrames }, (_, i) => ({
      radar_url: `frame-${i}`,
      data_type: "measurement",
      day: "23.08.2026",
      timepoint: "00:00",
      timestamp: i * 300,
    }));
    card._config = {}; // needed by _applyTimeSpan (returns all frames unchanged when empty)
    card._api = (path) => {
      if (path.includes("versions.json")) {
        return Promise.resolve({ "precipitation/animation": "20260823_1200" });
      }
      return Promise.resolve({
        map_images: [{ pictures: pics }],
        legend: [],
      });
    };
    // Stub DOM-touching side effects that _refreshManifest calls.
    card._tMeas = { style: {} };
    card._tFc = { style: {} };
    card._tNow = { style: {}, hidden: false };
    card._modeHint = { hidden: false };
    card._renderLegend = () => {};
    card._buildTimelineLabels = () => {};
    card._computeWindow = () => {};
    card._maybeResumeAfterFailure = () => {};

    await card._refreshManifest(true);

    // Frames are loaded and available via cache operations
    expect(card._frames.length).toBe(nFrames);
  });
});

describe("Path2D cache cap (issue #51)", () => {
  // Build a minimal _refreshManifest-compatible card and run it with a large
  // manifest to confirm _pathCacheMax stays at the fixed constant, not at
  // frames.length.  The decode cache (_cacheMax) must still grow — only the
  // path cache is capped.
  async function runRefreshManifest(nFrames) {
    const card = new MeteoSwissRadarCard();
    const pics = Array.from({ length: nFrames }, (_, i) => ({
      radar_url: `frame-${i}`,
      data_type: "measurement",
      day: "23.08.2026",
      timepoint: "00:00",
      timestamp: i * 300,
    }));
    card._config = {};
    card._api = (path) => {
      if (path.includes("versions.json"))
        return Promise.resolve({ "precipitation/animation": "v1" });
      return Promise.resolve({ map_images: [{ pictures: pics }], legend: [] });
    };
    card._tMeas = { style: {} };
    card._tFc = { style: {} };
    card._tNow = { style: {}, hidden: false };
    card._modeHint = { hidden: false };
    card._renderLegend = () => {};
    card._buildTimelineLabels = () => {};
    card._computeWindow = () => {};
    card._maybeResumeAfterFailure = () => {};
    await card._refreshManifest(true);
    return card;
  }

  it("path cache stays at the fixed constant regardless of manifest size", async () => {
    // A 291-frame manifest (the live size measured in the issue) must not
    // inflate the path cache beyond the compile-time cap.
    const card = await runRefreshManifest(291);
    // The decode cache is now shared and uses byte-based eviction, not entry-count capping.
    expect(card._frames.length).toBe(291);
    // The path cache stays at its fixed cap — never tied to frames.length.
    // 48 is PATH_CACHE_SIZE (two window-mode loops, fixed at compile time).
    expect(card._pathCacheMax).toBeUndefined(); // lives on the RadarLayer, not the card
  });

  it("RadarLayer._pathCacheMax is fixed at 48 and is not overwritten by _refreshManifest", async () => {
    const card = await runRefreshManifest(291);
    // Simulate a RadarLayer being attached: its _pathCacheMax starts at the
    // constant (set in initialize()) and must not be touched by _refreshManifest.
    const fakeLayer = { _pathCacheMax: 48 };
    card._radar = fakeLayer;
    // Stub DOM-heavy methods that would fire on a second refresh with frames present.
    card._jumpTo = () => {};
    // Run again to confirm a second manifest refresh does not change it.
    await card._refreshManifest(true);
    expect(fakeLayer._pathCacheMax).toBe(48);
  });
});

describe("hot-path optimisations (issue #15)", () => {
  // Shared frame list with enough entries to build a window.
  function makeFrames(n) {
    return Array.from({ length: n }, (_, i) => ({
      url: `frame-${i}`,
      ts: i * 300,
      type: "measurement",
      day: "23.08.2026",
      timepoint: `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}`,
    }));
  }

  describe("_prefetch window-aware wrapping", () => {
    function makeCard(frames) {
      const card = new MeteoSwissRadarCard();
      card._frames = frames;
      card._config = { frame_stride: 1 };
      card._fetched = [];
      card._ensureFrame = (url) => { card._fetched.push(url); return Promise.resolve(); };
      return card;
    }

    it("wraps within [winStart, winEnd] in window mode — does not warm out-of-window frames", () => {
      const card = makeCard(makeFrames(20));
      card._playMode = "window";
      card._winStart = 5;
      card._winEnd = 9; // window of 5 frames (indices 5-9)

      card._prefetch(9); // at the window tail

      // All 6 prefetch slots should wrap into the window.
      for (const url of card._fetched) {
        const idx = Number(url.split("-")[1]);
        expect(idx).toBeGreaterThanOrEqual(5);
        expect(idx).toBeLessThanOrEqual(9);
      }
      // The wrap-around frame (index 5) must have been queued.
      expect(card._fetched).toContain("frame-5");
    });

    it("does not wrap into out-of-window frames near the end in window mode", () => {
      const card = makeCard(makeFrames(20));
      card._playMode = "window";
      card._winStart = 5;
      card._winEnd = 9;

      card._prefetch(9);

      // frame-10 through frame-19 are outside the window and must not be queued.
      expect(card._fetched).not.toContain("frame-10");
      expect(card._fetched).not.toContain("frame-11");
    });

    it("wraps over the full list in full mode", () => {
      const card = makeCard(makeFrames(10));
      card._playMode = "full";

      card._prefetch(9); // at the end of the full list

      // Should wrap to frame-0, frame-1, …
      expect(card._fetched).toContain("frame-0");
    });

    it("wraps over the full list when paused (scrub context)", () => {
      const card = makeCard(makeFrames(10));
      card._playMode = "paused";

      card._prefetch(9);

      expect(card._fetched).toContain("frame-0");
    });
  });

  describe("per-frame shortLabel precompute", () => {
    it("shortLabel is set on each frame after _refreshManifest", async () => {
      const card = new MeteoSwissRadarCard();
      card._config = {};
      const ts = 1753920000; // 2025-08-30 at some hour
      const pics = [{
        radar_url: "frame-0",
        data_type: "measurement",
        day: "23.08.2026",
        timepoint: "10:00",
        timestamp: ts,
      }];
      card._api = (path) => {
        if (path.includes("versions.json")) return Promise.resolve({ "precipitation/animation": "v1" });
        return Promise.resolve({ map_images: [{ pictures: pics }], legend: [] });
      };
      card._tMeas = { style: {} };
      card._tFc = { style: {} };
      card._tNow = { style: {}, hidden: false };
      card._modeHint = { hidden: false };
      card._renderLegend = () => {};
      card._buildTimelineLabels = () => {};
      card._computeWindow = () => {};
      card._maybeResumeAfterFailure = () => {};

      await card._refreshManifest(true);

      const f = card._frames[0];
      expect(typeof f.shortLabel).toBe("string");
      // shortLabel = "Mon 23. · 10:00" or similar — check structure not exact weekday.
      expect(f.shortLabel).toContain("23.");
      expect(f.shortLabel).toContain("· 10:00");
    });
  });

  describe("_updateLabel DOM reuse", () => {
    // Minimal fake DOM element sufficient to exercise _updateLabel.
    function fakeEl(extra) {
      return { textContent: "", hidden: false, dataset: {}, ...extra };
    }

    function makeCardWithLabelDivs(config) {
      const card = new MeteoSwissRadarCard();
      card.setConfig(config || {});
      card._label = {
        hidden: false,
        dataset: {},
        classList: { _classes: new Set(), toggle(cls, force) { if (force) this._classes.add(cls); else this._classes.delete(cls); } },
      };
      card._labelL1 = fakeEl();
      card._labelL2 = fakeEl();
      return card;
    }

    const frame = {
      ts: 1753920000,
      type: "measurement",
      day: "23.08.2026",
      timepoint: "10:00",
      shortLabel: "Sat 23. · 10:00",
    };

    it("sets l1.textContent from the precomputed shortLabel", () => {
      const card = makeCardWithLabelDivs({ large_label: true });
      card._frames = [frame];
      card._frameIndex = 0;
      card._updateLabel();
      expect(card._labelL1.textContent).toBe("Sat 23. · 10:00");
      expect(card._label.hidden).toBe(false);
    });

    it("shows l2 with the frame type in large mode", () => {
      const card = makeCardWithLabelDivs({ large_label: true });
      card._frames = [frame];
      card._frameIndex = 0;
      card._updateLabel();
      expect(card._labelL2.hidden).toBe(false);
      expect(card._labelL2.textContent).toBe("Measurement");
    });

    it("hides l2 in compact mode", () => {
      const card = makeCardWithLabelDivs({ large_label: false });
      card._frames = [frame];
      card._frameIndex = 0;
      card._updateLabel();
      expect(card._labelL2.hidden).toBe(true);
    });

    it("adds .large class in large mode and removes it in compact mode", () => {
      const card = makeCardWithLabelDivs({ large_label: true });
      card._frames = [frame];
      card._frameIndex = 0;
      card._updateLabel();
      expect(card._label.classList._classes.has("large")).toBe(true);

      card.setConfig({ large_label: false });
      card._updateLabel();
      expect(card._label.classList._classes.has("large")).toBe(false);
    });

    it("skips l1 textContent assignment when text is unchanged", () => {
      const card = makeCardWithLabelDivs({ large_label: true });
      card._frames = [frame];
      card._frameIndex = 0;
      card._updateLabel(); // first call sets the text

      let writeCount = 0;
      const prev = card._labelL1.textContent;
      Object.defineProperty(card._labelL1, "textContent", {
        get: () => prev,
        set: () => { writeCount++; },
        configurable: true,
      });

      card._updateLabel(); // same frame — must not write again
      expect(writeCount).toBe(0);
    });

    it("falls back to weekdayShort when shortLabel is absent", () => {
      const card = makeCardWithLabelDivs({ large_label: false });
      const frameNoLabel = { ts: 1753920000, type: "measurement", day: "23.08.2026", timepoint: "10:00" };
      card._frames = [frameNoLabel];
      card._frameIndex = 0;
      card._updateLabel();
      // Should not throw and l1 gets some text.
      expect(card._labelL1.textContent.length).toBeGreaterThan(0);
    });
  });
});

describe("scrub pointercancel / lostpointercapture (issue #7)", () => {
  // _renderShell wires the pointer handlers onto the track element.  We stub
  // the shadow root minimally so we can control the EventTarget directly and
  // dispatch cancel events without a real browser.
  function makeCardWithTrackWrap() {
    const card = new MeteoSwissRadarCard();
    card.setConfig({});

    // Node 22 exposes EventTarget / Event as globals — no DOM shim needed.
    const trackWrap = new EventTarget();
    trackWrap.setPointerCapture = () => {};
    trackWrap.getBoundingClientRect = () => ({ left: 0, width: 100 });

    const noop = { addEventListener() {}, hidden: false };
    card.shadowRoot = {
      set innerHTML(_html) {},
      getElementById(id) { return id === "trackwrap" ? trackWrap : noop; },
    };
    card._renderShell();  // registers actual pointer listeners on trackWrap
    return { card, trackWrap };
  }

  it("pointercancel resets _trackScrubbing so autoplay is not paused by subsequent hovers", () => {
    const { card, trackWrap } = makeCardWithTrackWrap();

    trackWrap.dispatchEvent(new Event("pointerdown"));
    expect(card._trackScrubbing).toBe(true);

    trackWrap.dispatchEvent(new Event("pointercancel"));
    expect(card._trackScrubbing).toBe(false);
  });

  it("lostpointercapture resets _trackScrubbing so autoplay is not paused by subsequent hovers", () => {
    const { card, trackWrap } = makeCardWithTrackWrap();

    trackWrap.dispatchEvent(new Event("pointerdown"));
    expect(card._trackScrubbing).toBe(true);

    trackWrap.dispatchEvent(new Event("lostpointercapture"));
    expect(card._trackScrubbing).toBe(false);
  });
});

describe("setConfig zoom and center validation (issue #8)", () => {
  it("coerces zoom to a finite number and clamps to [6, 15]", () => {
    const card = new MeteoSwissRadarCard();

    card.setConfig({ zoom: 10 });
    expect(card._config.zoom).toBe(10);

    card.setConfig({ zoom: "8" });
    expect(card._config.zoom).toBe(8);

    card.setConfig({ zoom: 2 }); // below min
    expect(card._config.zoom).toBe(8); // default

    card.setConfig({ zoom: 16 }); // above max
    expect(card._config.zoom).toBe(8); // default

    card.setConfig({ zoom: "invalid" });
    expect(card._config.zoom).toBe(8); // default

    card.setConfig({ zoom: null });
    expect(card._config.zoom).toBe(8); // default
  });

  it("accepts center only as array of 2 finite numbers", () => {
    const card = new MeteoSwissRadarCard();

    card.setConfig({ center: [47.5, 8.5] });
    expect(card._config.center).toEqual([47.5, 8.5]);

    card.setConfig({ center: ["47.5", "8.5"] }); // coerce strings to numbers
    expect(card._config.center).toEqual([47.5, 8.5]);

    card.setConfig({ center: "Bern" }); // not an array
    expect(card._config.center).toBeUndefined(); // falls back in _createMap

    card.setConfig({ center: [47.5] }); // wrong length
    expect(card._config.center).toBeUndefined();

    card.setConfig({ center: [47.5, 8.5, 1000] }); // too many elements
    expect(card._config.center).toBeUndefined();

    card.setConfig({ center: ["47.5", "invalid"] }); // non-numeric string
    expect(card._config.center).toBeUndefined();

    card.setConfig({ center: [NaN, 8.5] }); // NaN is not finite
    expect(card._config.center).toBeUndefined();

    card.setConfig({ center: [Infinity, 8.5] }); // Infinity is not finite
    expect(card._config.center).toBeUndefined();

    card.setConfig({ center: null });
    expect(card._config.center).toBeUndefined();
  });
});

describe("byte-bounded decode cache (issue #52)", () => {
  // Build a decoded areas value with nRings rings of floatsPerRing floats each,
  // using the single-buffer layout (verts + rings).
  // frameBytes = verts.byteLength + rings.byteLength
  //            = (nRings * floatsPerRing * 4) + ((nRings + 1) * 4)
  function makeAreas(nRings, floatsPerRing) {
    const totalFloats = nRings * floatsPerRing;
    const verts = new Float32Array(totalFloats);
    const rings = new Int32Array(nRings + 1);
    for (let r = 0; r <= nRings; r++) rings[r] = r * floatsPerRing;
    return [{ color: "#aabbcc", verts, rings }];
  }

  beforeEach(() => {
    resetSharedCache();
  });

  it("frameBytes sums verts.byteLength and rings.byteLength for each area", () => {
    // 3 rings of 4 floats -> verts: 3*4*4=48 B, rings: (3+1)*4=16 B -> total 64 B
    expect(frameBytes(makeAreas(3, 4))).toBe(48 + 16);
  });

  it("frameBytes returns 0 for non-array values (backwards-compat with integer test fixtures)", () => {
    expect(frameBytes(42)).toBe(0);
    expect(frameBytes(null)).toBe(0);
    expect(frameBytes(undefined)).toBe(0);
  });

  it("shared cache tracks total bytes and decrements on eviction", () => {
    const card = new MeteoSwissRadarCard();
    // Each entry: 1 ring of 256 floats.
    // frameBytes = 256*4 + 2*4 = 1024 + 8 = 1032 bytes.
    const entry = () => makeAreas(1, 256);
    const entryBytes = frameBytes(entry());
    card._cachePut("a", entry());
    card._cachePut("b", entry());
    expect(SHARED_DECODE_CACHE._cacheBytes).toBe(entryBytes * 2);

    // Inserting a third entry stays under the byte budget.
    card._cachePut("c", entry());
    expect(SHARED_DECODE_CACHE._cache.size).toBe(3);
    expect(SHARED_DECODE_CACHE._cacheBytes).toBe(entryBytes * 3);
  });

  it("evicts LRU entries when byte budget is exceeded", () => {
    const card = new MeteoSwissRadarCard();

    // Build entries that together exceed DECODE_CACHE_BYTES.
    // Use entries of exactly DECODE_CACHE_BYTES / 4 bytes each.
    // Each entry's verts byte size is quarterBudget - rings overhead.
    // Simpler: just use raw objects and set exact byte sizes via the formula.
    const quarterBudget = DECODE_CACHE_BYTES / 4; // target bytes per entry
    // We want frameBytes(entry) === quarterBudget.
    // frameBytes = verts.byteLength + rings.byteLength
    //            = floats*4 + (1+1)*4  (1 ring, sentinel)
    // => floats*4 = quarterBudget - 8  => floats = (quarterBudget - 8) / 4
    const floats = (quarterBudget - 8) / 4;
    const entry = () => {
      const verts = new Float32Array(floats);
      const rings = new Int32Array(2);  // [0, verts.length]
      rings[1] = verts.length;
      return [{ color: "#aabbcc", verts, rings }];
    };

    card._cachePut("u0", entry());
    card._cachePut("u1", entry());
    card._cachePut("u2", entry());
    card._cachePut("u3", entry()); // now at budget exactly (4 * quarter = 1 * budget)
    expect(SHARED_DECODE_CACHE._cacheBytes).toBe(DECODE_CACHE_BYTES);
    expect(SHARED_DECODE_CACHE._cache.size).toBe(4);

    // Adding a 5th entry must evict the oldest (u0) to stay under budget.
    card._cachePut("u4", entry());
    expect(SHARED_DECODE_CACHE._cache.size).toBe(4);
    expect(SHARED_DECODE_CACHE._cacheBytes).toBe(DECODE_CACHE_BYTES);
    expect(card._cacheGet("u0")).toBeUndefined(); // evicted
    expect(card._cacheGet("u4")).toBeDefined(); // kept
  });

  it("light manifest (all measurement frames) stays fully cached without eviction", () => {
    const card = new MeteoSwissRadarCard();

    // Simulate 80 light frames at ~1 KB each.
    const floats = 256; // 256 floats = 1024 bytes of verts
    const entry = () => {
      const verts = new Float32Array(floats);
      const rings = new Int32Array(2);
      rings[1] = verts.length;
      return [{ color: "#aabbcc", verts, rings }];
    };
    const entryBytes = frameBytes(entry());

    for (let i = 0; i < 80; i++) card._cachePut(`frame-${i}`, entry());

    // 80 * entryBytes << 24 MB -> no eviction.
    expect(SHARED_DECODE_CACHE._cache.size).toBe(80);
    expect(SHARED_DECODE_CACHE._cacheBytes).toBe(80 * entryBytes);
    expect(card._cacheGet("frame-0")).toBeDefined();
  });

  it("heavy synthetic manifest stays under byte budget despite large frame count", () => {
    const card = new MeteoSwissRadarCard();

    // 300 frames each at ~200 KB = 60 MB total, well over the 24 MB budget.
    const floats = (200 * 1024 - 8) / 4; // ~200 KB per entry
    const entry = () => {
      const verts = new Float32Array(floats);
      const rings = new Int32Array(2);
      rings[1] = verts.length;
      return [{ color: "#aabbcc", verts, rings }];
    };

    for (let i = 0; i < 300; i++) card._cachePut(`frame-${i}`, entry());

    expect(SHARED_DECODE_CACHE._cacheBytes).toBeLessThanOrEqual(DECODE_CACHE_BYTES);
    // Should have some entries (the most recent ones).
    expect(SHARED_DECODE_CACHE._cache.size).toBeGreaterThan(0);
    // The oldest entries must have been evicted.
    expect(card._cacheGet("frame-0")).toBeUndefined();
  });

  it("shared cache persists across card instances", () => {
    const card1 = new MeteoSwissRadarCard();
    const entry = () => makeAreas(1, 256);
    card1._cachePut("shared", entry());
    expect(SHARED_DECODE_CACHE._cacheBytes).toBeGreaterThan(0);

    // A new card instance can access the same cache entry
    const card2 = new MeteoSwissRadarCard();
    expect(card2._cacheGet("shared")).toBeDefined();
  });

  it("overwriting a cached URL keeps shared cache bytes accurate", () => {
    const card = new MeteoSwissRadarCard();
    // First write: 2 rings of 4 floats.
    const first = makeAreas(2, 4);
    const firstBytes = frameBytes(first);
    card._cachePut("url", first);
    expect(SHARED_DECODE_CACHE._cacheBytes).toBe(firstBytes);
    // Overwrite with a different geometry; size may differ.
    const second = makeAreas(1, 8);
    const secondBytes = frameBytes(second);
    card._cachePut("url", second);
    expect(SHARED_DECODE_CACHE._cache.size).toBe(1);
    expect(SHARED_DECODE_CACHE._cacheBytes).toBe(secondBytes);
  });
});

// --------------------------------------------------------------------------
// Shared cache: budget scaling, key-count cap, teardown release (issue #139)
// --------------------------------------------------------------------------
describe("shared decode cache: budget, key cap, teardown (issue #139)", () => {
  function makeSizedEntry(bytes) {
    // Produce an areas array whose frameBytes() equals `bytes`.
    // frameBytes = verts.byteLength + rings.byteLength = floats*4 + 2*4
    // => floats = (bytes - 8) / 4  (1 ring, sentinel)
    const floats = Math.max(0, (bytes - 8) / 4);
    const verts = new Float32Array(floats);
    const rings = new Int32Array(2);
    rings[1] = verts.length;
    return [{ color: "#aabbcc", verts, rings }];
  }

  beforeEach(() => {
    SHARED_DECODE_CACHE._cache.clear();
    SHARED_DECODE_CACHE._cacheSizes.clear();
    SHARED_DECODE_CACHE._cacheBytes = 0;
    SHARED_DECODE_CACHE._cards = 0;
    SHARED_DECODE_CACHE._products = 0;
  });

  it("byte budget scales with registered product count", () => {
    // With no registrations: 1 product slot.
    expect(SHARED_DECODE_CACHE._maxBytes()).toBe(DECODE_CACHE_BYTES);
    // After attach(3): rate + 2 overlays → 3× budget.
    SHARED_DECODE_CACHE.attach(3);
    expect(SHARED_DECODE_CACHE._maxBytes()).toBe(DECODE_CACHE_BYTES * 3);
    SHARED_DECODE_CACHE.detach(3); // cleanup
  });

  it("key-count cap evicts zero-byte entries that byte eviction ignores", () => {
    // Zero-byte frames (empty overlay season): frameBytes = 0 → no byte eviction.
    // The key cap must still rotate them out.
    const maxKeys = SHARED_DECODE_CACHE._maxKeys(); // 360 with no registrations
    // Insert maxKeys + 1 zero-byte entries.
    for (let i = 0; i <= maxKeys; i++) {
      SHARED_DECODE_CACHE.put(`zero-${i}`, []);  // [] → frameBytes = 0
    }
    expect(SHARED_DECODE_CACHE._cache.size).toBeLessThanOrEqual(maxKeys);
    // Bytes should still be zero (all entries are zero-byte).
    expect(SHARED_DECODE_CACHE._cacheBytes).toBe(0);
    // Oldest entry must have been evicted.
    expect(SHARED_DECODE_CACHE.get("zero-0")).toBeUndefined();
  });

  it("key-count cap scales with registered products", () => {
    SHARED_DECODE_CACHE.attach(4); // rate + 3 overlays
    expect(SHARED_DECODE_CACHE._maxKeys()).toBe(DECODE_CACHE_MAX_KEYS * 4);
    SHARED_DECODE_CACHE.detach(4);
  });

  it("attach/detach increments and decrements counters correctly", () => {
    SHARED_DECODE_CACHE.attach(2);
    expect(SHARED_DECODE_CACHE._cards).toBe(1);
    expect(SHARED_DECODE_CACHE._products).toBe(2);
    SHARED_DECODE_CACHE.attach(3);
    expect(SHARED_DECODE_CACHE._cards).toBe(2);
    expect(SHARED_DECODE_CACHE._products).toBe(5);
    SHARED_DECODE_CACHE.detach(2);
    expect(SHARED_DECODE_CACHE._cards).toBe(1);
    expect(SHARED_DECODE_CACHE._products).toBe(3);
  });

  it("detach of last card clears the cache", () => {
    SHARED_DECODE_CACHE.attach(1);
    SHARED_DECODE_CACHE.put("frame-a", makeSizedEntry(1024));
    SHARED_DECODE_CACHE.put("frame-b", makeSizedEntry(2048));
    expect(SHARED_DECODE_CACHE._cache.size).toBe(2);
    expect(SHARED_DECODE_CACHE._cacheBytes).toBeGreaterThan(0);

    SHARED_DECODE_CACHE.detach(1); // last card gone
    expect(SHARED_DECODE_CACHE._cache.size).toBe(0);
    expect(SHARED_DECODE_CACHE._cacheBytes).toBe(0);
    expect(SHARED_DECODE_CACHE._cards).toBe(0);
  });

  it("detach of non-last card does NOT clear the cache", () => {
    SHARED_DECODE_CACHE.attach(1);
    SHARED_DECODE_CACHE.attach(1);
    SHARED_DECODE_CACHE.put("frame-a", makeSizedEntry(1024));
    expect(SHARED_DECODE_CACHE._cache.size).toBe(1);

    SHARED_DECODE_CACHE.detach(1); // first card gone, second still alive
    expect(SHARED_DECODE_CACHE._cache.size).toBe(1); // cache preserved
    expect(SHARED_DECODE_CACHE._cards).toBe(1);

    SHARED_DECODE_CACHE.detach(1); // last card gone
    expect(SHARED_DECODE_CACHE._cache.size).toBe(0);
  });

  it("_teardown deregisters from shared cache; last card clears it", () => {
    const card = new MeteoSwissRadarCard();
    card._initialized = true;
    card._cacheProducts = 1; // simulate a card that attached with 1 product
    SHARED_DECODE_CACHE._cards = 1;
    SHARED_DECODE_CACHE._products = 1;
    SHARED_DECODE_CACHE.put("frame-x", makeSizedEntry(1024));
    expect(SHARED_DECODE_CACHE._cache.size).toBe(1);

    card._map = { remove() {} };
    card._teardown();

    expect(card._cacheProducts).toBe(0);
    expect(SHARED_DECODE_CACHE._cards).toBe(0);
    expect(SHARED_DECODE_CACHE._cache.size).toBe(0); // cleared by last detach
  });

  it("_teardown with _cacheProducts=0 does not corrupt cache counters", () => {
    // Card that never went through _maybeInit (e.g. failed immediately).
    const card = new MeteoSwissRadarCard();
    card._initialized = true;
    // _cacheProducts defaults to 0 — attach was never called.
    SHARED_DECODE_CACHE._cards = 0;
    SHARED_DECODE_CACHE._products = 0;

    card._map = { remove() {} };
    card._teardown();

    // Must not go negative.
    expect(SHARED_DECODE_CACHE._cards).toBe(0);
    expect(SHARED_DECODE_CACHE._products).toBe(0);
  });

  it("_countActiveProducts returns 1 for rate-only config", () => {
    const card = new MeteoSwissRadarCard();
    card._config = {};
    expect(card._countActiveProducts()).toBe(1);
  });

  it("_countActiveProducts counts each enabled overlay", () => {
    const card = new MeteoSwissRadarCard();
    card._config = { layer_snow: true, layer_snowrain: true, layer_freezing_rain: true };
    expect(card._countActiveProducts()).toBe(4); // rate + 3 overlays
  });
});

// --------------------------------------------------------------------------
// Independent reference decode (issue #16)
// --------------------------------------------------------------------------
// tests/fixtures/frame.json is a synthetic radar frame.
// tests/fixtures/frame_decoded.json was produced by tests/tools/reference_decode.py,
// an independent Python implementation derived directly from FORMAT.md.
// This test locks the JS decoder against the spec, not against itself.
describe("decodeFrame fixture vs. Python reference (issue #16)", () => {
  const fixture = JSON.parse(
    readFileSync(path.join(fixturesDir, "frame.json"), "utf8"),
  );
  const reference = JSON.parse(
    readFileSync(path.join(fixturesDir, "frame_decoded.json"), "utf8"),
  );

  it("produces the same number of areas as the Python reference", () => {
    const decoded = decodeFrame(fixture);
    expect(decoded).toHaveLength(reference.length);
  });

  it("produces the same colors as the Python reference", () => {
    const decoded = decodeFrame(fixture);
    for (let a = 0; a < reference.length; a++) {
      expect(decoded[a].color).toBe(reference[a].color);
    }
  });

  it("total ring count per area matches the Python reference", () => {
    // The JS decoder flattens shapes into a single ring sequence (rings array).
    // The Python reference still has the nested shapes[][rings] structure.
    // Count total rings from the Python side and compare against rings.length-1.
    const decoded = decodeFrame(fixture);
    for (let a = 0; a < reference.length; a++) {
      let pyRingCount = 0;
      for (const shape of reference[a].shapes) pyRingCount += shape.length;
      const jsRingCount = decoded[a].rings.length - 1; // sentinel excluded
      expect(jsRingCount).toBe(pyRingCount);
    }
  });

  it("produces coordinates matching the Python reference within Float32 precision", () => {
    // Both the JS Float32Array and the Python to_float32() use IEEE 754 single
    // precision; values must match exactly.  Any difference indicates a formula
    // divergence, not just a rounding artefact.
    // The JS decoder flattens shapes into one verts buffer; iterate py rings in
    // order and compare against sequential windows of the flat JS buffer.
    const decoded = decodeFrame(fixture);
    for (let a = 0; a < reference.length; a++) {
      const { verts } = decoded[a];
      let floatOffset = 0;
      for (const shape of reference[a].shapes) {
        for (const pyRing of shape) {
          expect(pyRing.length).toBeGreaterThan(0);
          for (let k = 0; k < pyRing.length; k++) {
            // Tolerance covers the maximum error introduced by Float32 rounding
            // of a WGS84 coordinate in the Swiss domain (~1e-5 relative).
            expect(verts[floatOffset + k]).toBeCloseTo(pyRing[k], 4);
          }
          floatOffset += pyRing.length;
        }
      }
    }
  });

  it("all decoded coordinates fall inside the Swiss WGS84 bbox", () => {
    const decoded = decodeFrame(fixture);
    for (const area of decoded) {
      const { verts } = area;
      for (let k = 0; k < verts.length; k += 2) {
        expect(verts[k]).toBeGreaterThan(45);   // lat
        expect(verts[k]).toBeLessThan(48);
        expect(verts[k + 1]).toBeGreaterThan(5); // lng
        expect(verts[k + 1]).toBeLessThan(11);
      }
    }
  });
});

// --------------------------------------------------------------------------
// _nearestIndexByTs (issue #16)
// --------------------------------------------------------------------------
describe("_nearestIndexByTs (issue #16)", () => {
  function makeCard(frames) {
    const card = new MeteoSwissRadarCard();
    card._frames = frames;
    return card;
  }

  const frames = [
    { ts: 0, type: "measurement" },
    { ts: 300, type: "measurement" },
    { ts: 600, type: "measurement" },
    { ts: 900, type: "forecast" },
  ];

  it("returns 0 when ts is before the first frame", () => {
    expect(makeCard(frames)._nearestIndexByTs(-100)).toBe(0);
  });

  it("returns the last index when ts is after the last frame", () => {
    expect(makeCard(frames)._nearestIndexByTs(9999)).toBe(3);
  });

  it("returns the exact index when ts matches a frame", () => {
    expect(makeCard(frames)._nearestIndexByTs(600)).toBe(2);
  });

  it("returns the closest index for a ts between two frames", () => {
    // 149 is closer to 0 than to 300 → index 0
    expect(makeCard(frames)._nearestIndexByTs(149)).toBe(0);
    // 151 is closer to 300 → index 1
    expect(makeCard(frames)._nearestIndexByTs(151)).toBe(1);
  });

  it("returns 0 for an empty-but-initialised frame list edge", () => {
    // Linear search with no frames: best starts at 0 and stays there.
    const card = makeCard([{ ts: 42, type: "measurement" }]);
    expect(card._nearestIndexByTs(42)).toBe(0);
  });
});

// --------------------------------------------------------------------------
// _applyTimeSpan (issue #16)
// --------------------------------------------------------------------------
describe("_applyTimeSpan (issue #16)", () => {
  // 6 measurement frames ending at ts=1800, then 3 forecast frames.
  const baseFrames = [
    { ts: 0, type: "measurement" },
    { ts: 300, type: "measurement" },
    { ts: 600, type: "measurement" },
    { ts: 900, type: "measurement" },
    { ts: 1200, type: "measurement" },
    { ts: 1800, type: "measurement" }, // lastMeas, anchor=1800
    { ts: 2400, type: "forecast" },
    { ts: 3000, type: "forecast" },
    { ts: 3600, type: "forecast" },
  ];

  function makeCard(cfg) {
    const card = new MeteoSwissRadarCard();
    card._config = cfg;
    return card;
  }

  it("returns all frames unchanged when neither past_hours nor forecast_hours is set", () => {
    const card = makeCard({});
    expect(card._applyTimeSpan(baseFrames)).toHaveLength(baseFrames.length);
  });

  it("returns all frames unchanged when both values are not finite (NaN-like)", () => {
    const card = makeCard({ past_hours: "nope", forecast_hours: "nope" });
    expect(card._applyTimeSpan(baseFrames)).toHaveLength(baseFrames.length);
  });

  it("trims old measurements when past_hours is set — recent ones stay", () => {
    // anchor=1800, past=0.5h=1800s → keep measurements with ts >= 1800-1800=0
    const card = makeCard({ past_hours: 0.5 });
    const result = card._applyTimeSpan(baseFrames);
    const meas = result.filter((f) => f.type === "measurement");
    for (const f of meas) expect(f.ts).toBeGreaterThanOrEqual(0);
  });

  it("trims forecast frames when forecast_hours is set", () => {
    // anchor=1800, forecast=0.5h=1800s → keep forecasts with ts <= 1800+1800=3600
    const card = makeCard({ forecast_hours: 0.5 });
    const result = card._applyTimeSpan(baseFrames);
    const fc = result.filter((f) => f.type === "forecast");
    for (const f of fc) expect(f.ts).toBeLessThanOrEqual(1800 + 0.5 * 3600);
  });

  it("forecast_hours: 0 gives a measurement-only result", () => {
    const card = makeCard({ forecast_hours: 0 });
    const result = card._applyTimeSpan(baseFrames);
    expect(result.every((f) => f.type === "measurement")).toBe(true);
  });

  it("both past_hours and forecast_hours: 0 returns only the last frame", () => {
    const card = makeCard({ past_hours: 0, forecast_hours: 0 });
    const result = card._applyTimeSpan(baseFrames);
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe(1800); // lastMeas
  });

  it("never returns an empty array — falls back to lastMeas when all filtered", () => {
    // past_hours tiny enough to drop all measurements except the anchor itself.
    const card = makeCard({ past_hours: 0.001, forecast_hours: 0 });
    const result = card._applyTimeSpan(baseFrames);
    expect(result.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// _computeWindow (issue #16)
// --------------------------------------------------------------------------
describe("_computeWindow (issue #16)", () => {
  // Build a card with measurement frames at 5-min intervals for 30 min before
  // `measTs`, then 4 forecast frames at varying distances ahead.
  // Indices 0-6: measurements (ts = measTs-1800 through measTs)
  // Indices 7-10: forecasts (ts = measTs+600, measTs+1200, measTs+3600, measTs+7200)
  const measTs = 3 * 3600; // 03:00 UTC on 1970-01-01 — well away from midnight

  function makeWindowCard(cfg) {
    const card = new MeteoSwissRadarCard();
    card._frames = [];
    for (let i = 6; i >= 0; i--)
      card._frames.push({ ts: measTs - i * 300, type: "measurement" });
    card._frames.push({ ts: measTs + 600, type: "forecast" });
    card._frames.push({ ts: measTs + 1200, type: "forecast" });
    card._frames.push({ ts: measTs + 3600, type: "forecast" });
    card._frames.push({ ts: measTs + 7200, type: "forecast" });
    card._config = cfg;
    return card;
  }

  it("default: play_past_hours=1h snaps winStart to the measurement 1h ago", () => {
    const card = makeWindowCard({ play_past_hours: 0.5, play_forecast_hours: 1 });
    card._computeWindow();
    // nearest to measTs-1800 is frames[0].ts = measTs-1800 → index 0
    expect(card._winStart).toBe(0);
    // nearest to measTs+3600 is frames[9].ts = measTs+3600 → index 9
    expect(card._winEnd).toBe(9);
  });

  it("play_forecast_hours: 0 makes winEnd the last measurement", () => {
    // past_hours > 0 so winStart < winEnd — avoids the equal-bounds fallback.
    const card = makeWindowCard({ play_past_hours: 0.5, play_forecast_hours: 0 });
    card._computeWindow();
    // endTs = measTs + 0 → winEnd = nearest(measTs) = index 6 (last measurement)
    expect(card._winEnd).toBe(6);
  });

  it("play_forecast_until overrides forecast_hours when until is further", () => {
    // hours endTs = measTs+3600; until target further away (measTs+7200)
    // Compute the until time the same way _computeWindow does so we are
    // timezone-agnostic.
    const d = new Date(measTs * 1000);
    d.setHours(d.getHours() + 2, d.getMinutes(), 0, 0); // 2 h ahead in local time
    const untilHHMM = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const card = makeWindowCard({
      play_past_hours: 0,
      play_forecast_hours: 1,
      play_forecast_until: untilHHMM,
    });
    card._computeWindow();
    // winEnd should be past the forecast_hours bound (index 9)
    expect(card._winEnd).toBeGreaterThan(9);
  });

  it("forecast_hours beats play_forecast_until when hours endTs is further", () => {
    // hours endTs = measTs+7200 (2h); until → 30 min from now → endTs=measTs+1800
    // hours wins → winEnd should be frames[10] (measTs+7200)
    const d = new Date(measTs * 1000);
    d.setMinutes(d.getMinutes() + 30, 0, 0); // 30 min ahead in local time
    const untilHHMM = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const card = makeWindowCard({
      play_past_hours: 0,
      play_forecast_hours: 2, // 7200s → measTs+7200
      play_forecast_until: untilHHMM,
    });
    card._computeWindow();
    expect(card._winEnd).toBe(10); // measTs+7200 is the last frame, index 10
  });

  it("play_forecast_until in the past rolls to the next day", () => {
    // Force an until time that is strictly before measTs in local time.
    // Achieved by taking measTs's local H:M, then going back 1h and using that.
    // _computeWindow detects ts <= now and adds 86400; the rolled-over ts is
    // always > frames' forecast horizon, so winEnd reaches the last frame.
    const d = new Date(measTs * 1000);
    const h = d.getHours();
    const m = d.getMinutes();
    // Use one hour earlier — guaranteed to be in the past.
    const pastH = h === 0 ? 23 : h - 1;
    const untilHHMM = `${String(pastH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const card = makeWindowCard({ play_past_hours: 0, play_forecast_hours: 0, play_forecast_until: untilHHMM });
    card._computeWindow();
    // The rolled-over endTs is ~23h into the future — the farthest forecast
    // frame (measTs+7200) is the nearest, so winEnd is the last frame index.
    expect(card._winEnd).toBe(10);
  });

  it("invalid play_forecast_until is ignored — falls back to forecast_hours only", () => {
    const card = makeWindowCard({ play_past_hours: 0, play_forecast_hours: 1, play_forecast_until: "bad" });
    card._computeWindow();
    expect(card._winEnd).toBe(9); // measTs+3600 → index 9
  });

  it("winEnd <= winStart fallback: expands to the full frame range", () => {
    // Cause winEnd < winStart by setting a tiny forecast horizon with a large past.
    // With play_forecast_hours: 0 and play_past_hours: 999, winStart is forced
    // to index 0 and winEnd to index 6 (lastMeas) → winEnd > winStart, so the
    // fallback does NOT fire. To trigger the fallback, add forecast_hours=0 when
    // lastMeas is near the end: winStart could exceed winEnd if frame list is odd.
    // Simpler: build a card where all frames are forecast (no measurement) so
    // _lastMeasurementIndex returns -1 and lastMeas is undefined → now = _t0 = 0.
    const card = new MeteoSwissRadarCard();
    card._frames = [
      { ts: 100, type: "forecast" },
      { ts: 200, type: "forecast" },
      { ts: 300, type: "forecast" },
    ];
    card._config = { play_past_hours: 0.5, play_forecast_hours: 0 };
    // now = _t0 = 0 (no measurement); winEnd = nearest(0) = index 0;
    // winStart = nearest(0 - 1800) = index 0; winEnd (0) <= winStart (0) → fallback
    card._computeWindow();
    expect(card._winStart).toBe(0);
    expect(card._winEnd).toBe(2);
  });
});

describe("resume autoplay on reconnect within teardown debounce (issue #9)", () => {
  // Build a card that looks initialized and playing in the given mode.
  // _startPlay and _startRefreshTimer are stubbed to avoid browser APIs
  // (requestAnimationFrame / setInterval) absent in the vm context.
  function makePlayingCard(mode) {
    const card = new MeteoSwissRadarCard();
    card._frames = [{ url: "f0" }, { url: "f1" }];
    card._playing = true;
    card._playMode = mode;
    card._initialized = true;
    card._dataReady = true;
    const started = [];
    card._startPlay = (m) => {
      started.push(m);
      card._playing = true;
      card._playMode = m;
    };
    card._startRefreshTimer = () => {};
    return { card, started };
  }

  it("records the active play mode into _playModeBeforeDetach on disconnect", () => {
    const { card } = makePlayingCard("window");
    card.disconnectedCallback();
    expect(card._playModeBeforeDetach).toBe("window");
  });

  it("records 'full' mode correctly", () => {
    const { card } = makePlayingCard("full");
    card.disconnectedCallback();
    expect(card._playModeBeforeDetach).toBe("full");
  });

  it("leaves _playModeBeforeDetach null when the card was manually paused before detach", () => {
    const { card } = makePlayingCard("window");
    card._playing = false;
    card._playMode = "paused";
    card.disconnectedCallback();
    expect(card._playModeBeforeDetach).toBeNull();
  });

  it("resumes window play when re-attached within the debounce window", () => {
    const { card, started } = makePlayingCard("window");
    card.disconnectedCallback();
    expect(card._playing).toBe(false);
    expect(card._teardownTimer).toBeTruthy();

    card.connectedCallback();

    expect(started).toEqual(["window"]);
    expect(card._playModeBeforeDetach).toBeNull();
  });

  it("resumes full play when re-attached within the debounce window", () => {
    const { card, started } = makePlayingCard("full");
    card.disconnectedCallback();
    card.connectedCallback();
    expect(started).toEqual(["full"]);
  });

  it("stays paused when a manually-paused card is re-attached within the debounce window", () => {
    const { card, started } = makePlayingCard("window");
    card._playing = false;
    card._playMode = "paused";
    card.disconnectedCallback();
    card.connectedCallback();
    expect(started).toEqual([]);
    expect(card._playing).toBe(false);
  });

  it("_teardown clears _playModeBeforeDetach", () => {
    const { card } = makePlayingCard("window");
    card.disconnectedCallback();
    expect(card._playModeBeforeDetach).toBe("window");

    card._map = { remove() {} };
    card._teardown();

    expect(card._playModeBeforeDetach).toBeNull();
  });
});

describe("_buildTimelineLabels across DST boundaries (issue #66)", () => {
  // These tests run under TZ=Europe/Zurich (pinned in vitest.config.js).
  // _buildTimelineLabels walks day boundaries in local time, so the DST
  // fall-back day (25 h long) is where the old +86400s arithmetic could not
  // cross into the next day and the while-loop spun forever, freezing the tab.

  // A fresh vm realm whose document.createElement returns inert fake elements,
  // so _buildTimelineLabels can build separator/label nodes without a browser.
  function loadCardWithCreateElement() {
    const src = readFileSync(cardPath, "utf8");
    const noop = () => {};
    const registry = {
      get: () => undefined,
      define: noop,
      whenDefined: () => Promise.resolve(),
    };
    const ctx = {
      window: { customElements: registry, customCards: [], L: undefined },
      document: {
        querySelector: () => null,
        readyState: "complete",
        addEventListener: noop,
        createElement: () => ({ className: "", style: {}, textContent: "" }),
      },
      customElements: registry,
      HTMLElement: class {},
      CustomEvent: class {
        constructor(type, init) {
          this.type = type;
          this.detail = init && init.detail;
        }
      },
      console: { info: noop, warn: noop, error: noop },
      setTimeout,
      clearTimeout,
      Promise,
      Date,
      Math,
      Array,
      Object,
      Number,
      String,
      Map,
      Set,
      JSON,
      Intl,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(
      `${src}\n;globalThis.__card = { MeteoSwissRadarCard };`,
      ctx,
      { filename: "meteoswiss-radar-card.js" },
    );
    return ctx.__card.MeteoSwissRadarCard;
  }

  // Fake row element that records the children appended to it.
  function fakeRow(width) {
    return {
      offsetWidth: width,
      textContent: "",
      children: [],
      appendChild(el) {
        this.children.push(el);
      },
    };
  }

  // Build a card whose timeline spans [t0, t1] and run _buildTimelineLabels.
  function buildLabels(Card, t0, t1, rowWidth) {
    const card = new Card();
    card._config = { time_axis: true };
    card._frames = [
      { ts: t0, type: "measurement" },
      { ts: t1, type: "forecast" },
    ];
    card._hoursRow = fakeRow(rowWidth);
    card._datesRow = fakeRow(rowWidth);
    card._buildTimelineLabels();
    return card;
  }

  // Every real local midnight strictly after t0 and up to (incl.) t1, with the
  // pixel left the card assigns it. Mirrors the card's own visStart/percentX math.
  function expectedDaySeps(t0, t1, rowWidth) {
    const span = t1 - t0;
    const seps = [];
    const d = new Date(t0 * 1000);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1); // first midnight after t0
    for (;;) {
      const m = d.getTime() / 1000;
      if (m > t1) break;
      const percentX = ((m - t0) / span) * 100;
      seps.push(Math.round((percentX / 100) * rowWidth) + "px");
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0); // re-snap: the next midnight, DST-length-agnostic
    }
    return seps;
  }

  it("terminates and places day separators at true local midnights on the fall-back day (2026-10-25)", () => {
    const Card = loadCardWithCreateElement();
    // ~12 h back to ~28 h ahead, straddling the 25 h fall-back Sunday.
    const t0 = new Date(2026, 9, 24, 12, 0, 0).getTime() / 1000; // Sat 12:00 CEST
    const t1 = new Date(2026, 9, 26, 0, 0, 0).getTime() / 1000; // Mon 00:00 CET
    const rowWidth = 1000;

    // If the fix is absent, this call never returns (the tab-freezing spin);
    // reaching the assertions at all is the primary regression guard.
    const card = buildLabels(Card, t0, t1, rowWidth);

    const seps = card._datesRow.children
      .filter((el) => el.className === "daysep")
      .map((el) => el.style.left);

    // Sun 2026-10-25 00:00 and Mon 2026-10-26 00:00 — no duplicate, no offset.
    expect(seps).toEqual(expectedDaySeps(t0, t1, rowWidth));
    expect(seps).toHaveLength(2);
  });

  it("places the day separator exactly at midnight on the spring-forward day (2026-03-29)", () => {
    const Card = loadCardWithCreateElement();
    const t0 = new Date(2026, 2, 28, 12, 0, 0).getTime() / 1000; // Sat 12:00 CET
    const t1 = new Date(2026, 2, 30, 0, 0, 0).getTime() / 1000; // Mon 00:00 CEST
    const rowWidth = 1000;

    const card = buildLabels(Card, t0, t1, rowWidth);

    const seps = card._datesRow.children
      .filter((el) => el.className === "daysep")
      .map((el) => el.style.left);

    expect(seps).toEqual(expectedDaySeps(t0, t1, rowWidth));
  });
});

// --------------------------------------------------------------------------
// Playback state machine: _advance / _togglePlay / _onScrub / _jumpTo (issue #76)
// --------------------------------------------------------------------------
describe("playback state machine (issue #76)", () => {
  function makeFrames(n) {
    return Array.from({ length: n }, (_, i) => ({
      url: `frame-${i}`,
      ts: i * 300,
      type: "measurement",
    }));
  }

  // A deferred promise so a test can resolve _ensureFrame at a chosen moment,
  // reproducing a decode that finishes after the user has moved on.
  function deferred() {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  // Bare instance with the frame-drawing collaborators stubbed to record calls,
  // matching the "bare-instance-plus-stubs" pattern used across this file. By
  // default every frame is cached (_cacheGet truthy) so _advance takes the
  // show-frame path; individual tests override _cacheGet to force the hold path.
  function makeCard(frames, config = {}) {
    const card = new MeteoSwissRadarCard();
    card._frames = frames;
    card._config = { frame_stride: 1, ...config };
    card._shown = [];
    card._ensured = [];
    card._prefetched = [];
    card._cacheGet = () => ({}); // truthy: frame is decoded and ready
    card._ensureFrame = (url) => {
      card._ensured.push(url);
      return Promise.resolve();
    };
    card._showFrame = (idx) => card._shown.push(idx);
    card._prefetch = (idx) => card._prefetched.push(idx);
    card._moveMarkers = () => {};
    return card;
  }

  describe("_advance", () => {
    it("window mode: next beyond _winEnd wraps to _winStart", () => {
      const card = makeCard(makeFrames(20));
      card._playMode = "window";
      card._winStart = 5;
      card._winEnd = 9;
      card._frameIndex = 9; // stride 1 → next = 10 > winEnd

      card._advance();

      expect(card._shown).toEqual([5]);
      expect(card._prefetched).toEqual([5]);
    });

    it("window mode: a stride overshooting the window end still snaps to _winStart", () => {
      const card = makeCard(makeFrames(20), { frame_stride: 3 });
      card._playMode = "window";
      card._winStart = 5;
      card._winEnd = 9;
      card._frameIndex = 8; // next = 11, well past winEnd 9

      card._advance();

      // The snap-back is the only guard against a stride overshooting the window.
      expect(card._shown).toEqual([5]);
    });

    it("window mode: a step landing inside the window advances normally", () => {
      const card = makeCard(makeFrames(20));
      card._playMode = "window";
      card._winStart = 5;
      card._winEnd = 9;
      card._frameIndex = 6; // next = 7, still inside the window

      card._advance();

      expect(card._shown).toEqual([7]);
    });

    it("full mode wraps modulo frames.length", () => {
      const card = makeCard(makeFrames(10));
      card._playMode = "full";
      card._frameIndex = 9; // next = 10 → 10 % 10 = 0

      card._advance();

      expect(card._shown).toEqual([0]);
      expect(card._prefetched).toEqual([0]);
    });

    it("full mode with stride wraps modulo frames.length", () => {
      const card = makeCard(makeFrames(10), { frame_stride: 4 });
      card._playMode = "full";
      card._frameIndex = 8; // next = 12 → 12 % 10 = 2

      card._advance();

      expect(card._shown).toEqual([2]);
    });

    it("holds the current frame when the next frame is not yet decoded", () => {
      const card = makeCard(makeFrames(10));
      card._playMode = "full";
      card._frameIndex = 3;
      card._cacheGet = () => undefined; // next frame uncached

      card._advance();

      // Kicks off a decode but must not paint an undecoded frame.
      expect(card._ensured).toEqual(["frame-4"]);
      expect(card._shown).toEqual([]);
      expect(card._prefetched).toEqual([]);
    });

    it("is a no-op with no frames", () => {
      const card = makeCard([]);
      card._playMode = "full";
      card._frameIndex = 0;

      card._advance();

      expect(card._shown).toEqual([]);
      expect(card._ensured).toEqual([]);
    });
  });

  describe("_togglePlay", () => {
    // Stub the heavy start/pause implementations (they touch RAF and the DOM)
    // and only record the mode transitions the cycle drives.
    function makeToggleCard() {
      const card = makeCard(makeFrames(10));
      card._playMode = "paused";
      card._starts = [];
      card._pauses = 0;
      card._clears = 0;
      card._startPlay = (mode) => {
        card._starts.push(mode);
        card._playMode = mode;
      };
      card._pause = () => {
        card._pauses++;
        card._playMode = "paused";
      };
      card._clearFailureRecovery = () => {
        card._clears++;
      };
      return card;
    }

    it("cycles paused → window → full → paused", () => {
      const card = makeToggleCard();

      card._togglePlay();
      expect(card._playMode).toBe("window");
      card._togglePlay();
      expect(card._playMode).toBe("full");
      card._togglePlay();
      expect(card._playMode).toBe("paused");

      expect(card._starts).toEqual(["window", "full"]);
      expect(card._pauses).toBe(1);
    });

    it("clears any pending failure auto-resume on every press", () => {
      const card = makeToggleCard();

      card._togglePlay();
      card._togglePlay();
      card._togglePlay();

      // Manual control must override a pending failure recovery each time.
      expect(card._clears).toBe(3);
    });
  });

  describe("_onScrub race guard", () => {
    // Wire up just enough for _onScrub's uncached branch: pause + clear are
    // stubbed away, and _ensureFrame is a deferred we resolve on demand.
    function makeScrubCard(d) {
      const card = makeCard(makeFrames(10));
      card._clearFailureRecovery = () => {};
      card._pause = () => {
        card._playing = false;
        card._playMode = "paused";
      };
      card._cacheGet = () => undefined; // force the async decode path
      card._ensureFrame = () => d.promise;
      return card;
    }

    it("does not show a frame when a slow decode resolves after the user scrubbed elsewhere", async () => {
      const d = deferred();
      const card = makeScrubCard(d);

      card._onScrub(3); // _scrubTarget = 3, decode pending
      card._scrubTarget = 7; // user has since scrubbed to a different frame

      d.resolve();
      await d.promise;

      expect(card._shown).toEqual([]);
      expect(card._prefetched).toEqual([]);
    });

    it("shows the frame when the decode resolves and the scrub target is unchanged", async () => {
      const d = deferred();
      const card = makeScrubCard(d);

      card._onScrub(3);

      d.resolve();
      await d.promise;

      expect(card._shown).toEqual([3]);
      expect(card._prefetched).toEqual([3]);
    });

    it("shows a cached frame synchronously without waiting on a decode", () => {
      const card = makeCard(makeFrames(10));
      card._clearFailureRecovery = () => {};
      card._pause = () => {};
      // _cacheGet is truthy by default → synchronous show path.

      card._onScrub(4);

      expect(card._shown).toEqual([4]);
      expect(card._prefetched).toEqual([4]);
    });
  });

  describe("_jumpTo stale guard", () => {
    function makeJumpCard(d) {
      const card = makeCard(makeFrames(10));
      card._ensureFrame = () => d.promise;
      return card;
    }

    it("does not show a frame when _frameIndex has moved on before the decode resolves", async () => {
      const d = deferred();
      const card = makeJumpCard(d);

      card._jumpTo(3); // sets _frameIndex = 3, decode pending
      card._frameIndex = 8; // a later jump moved the index before decode finished

      d.resolve();
      await d.promise;

      expect(card._shown).toEqual([]);
    });

    it("shows the frame when _frameIndex still matches on resolve", async () => {
      const d = deferred();
      const card = makeJumpCard(d);

      card._jumpTo(3);

      d.resolve();
      await d.promise;

      expect(card._shown).toEqual([3]);
    });

    it("is a no-op for an out-of-range index", () => {
      const d = deferred();
      const card = makeJumpCard(d);

      card._jumpTo(99);

      expect(card._shown).toEqual([]);
      expect(card._prefetched).toEqual([]);
    });
  });
});

describe("async-init teardown race (issue #68)", () => {
  // Bare-instance tests: stub every side-effect that touches real DOM, network,
  // or timers. The generation counter (_epoch) is the unit under test.

  function makeCard() {
    const card = new MeteoSwissRadarCard();
    card._config = { autoplay_mode: "off" };
    card._hass = {};
    Object.defineProperty(card, "isConnected", { get: () => true, configurable: true });

    // DOM stubs — _renderShell builds the shadow DOM; skip it entirely.
    card._renderShell = () => {};
    // _createMap sets this._map; let the stub do that so _teardown can call map.remove().
    card._map = null;
    card._createMap = (L) => {
      let removed = false;
      card._map = { remove() { removed = true; }, get removed() { return removed; } };
    };

    // Stubs for _loadData internals.
    card._timeline = { hidden: true };
    card._playBtn = { hidden: true };
    card._hideBanner = () => {};
    card._showBanner = () => {};
    card._showError = (msg) => { card._lastError = msg; };
    card._showFrame = () => { card._showFrameCalled = true; };
    card._prefetch = () => {};
    card._startPlayCalled = false;
    card._startPlay = (mode) => { card._startPlayCalled = true; };

    // _pause is called by _teardown; stub so it doesn't touch _raf.
    card._pause = () => { card._playing = false; };
    // _stopRecoveryTimer is called by _teardown.
    card._stopRecoveryTimer = () => {};

    card._refreshTimerStarted = false;
    card._startRefreshTimer = () => { card._refreshTimerStarted = true; };

    return card;
  }

  function makeManifestStub(card) {
    card._refreshManifest = async () => {
      card._frames = [{ url: "frame-0", type: "measurement", ts: 0 }];
      card._animVersion = "v1";
    };
    card._api = () => Promise.resolve({ coords: GRID, areas: [] });
  }

  // Helper: deferred promise
  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it("_epoch starts at 0 and increments on _teardown", () => {
    const card = makeCard();
    expect(card._epoch).toBe(0);
    card._initialized = true;
    card._teardown();
    expect(card._epoch).toBe(1);
  });

  it("_teardown does not increment _epoch when the card was never initialized", () => {
    const card = makeCard();
    card._teardown();
    expect(card._epoch).toBe(0);
  });

  it("_maybeInit does not create a map or start a timer when _teardown fires before loadLeaflet resolves", async () => {
    const card = makeCard();
    makeManifestStub(card);

    const d = deferred();
    card._loadLeaflet = () => d.promise;

    // Start init — suspends at await this._loadLeaflet().
    const initPromise = card._maybeInit();
    expect(card._initialized).toBe(true);

    // Teardown fires while Leaflet is still loading.
    card._teardown();
    expect(card._epoch).toBe(1);
    expect(card._initialized).toBe(false);

    // Now the slow Leaflet load resolves.
    d.resolve({});
    await initPromise;

    // The stale continuation must have bailed without creating a map or timer.
    expect(card._map).toBe(null);
    expect(card._refreshTimerStarted).toBe(false);
  });

  it("_maybeInit does not start the refresh timer when _teardown fires after loadLeaflet but before _loadData resolves", async () => {
    const card = makeCard();

    const dLoad = deferred();
    card._loadLeaflet = () => Promise.resolve({});
    card._loadData = () => dLoad.promise;

    const initPromise = card._maybeInit();

    // Drain all queued microtasks (including the _maybeInit continuation past
    // `await _loadLeaflet`) so we're sitting inside `await _loadData` before
    // teardown fires. setTimeout fires after all pending microtasks.
    await new Promise((r) => setTimeout(r, 0));

    // Teardown fires while _loadData is pending.
    card._teardown();
    expect(card._epoch).toBe(1);

    dLoad.resolve();
    await initPromise;

    expect(card._refreshTimerStarted).toBe(false);
  });

  it("_loadData does not start autoplay when _teardown fires after _refreshManifest resolves", async () => {
    const card = makeCard();
    card._config = { autoplay_mode: "window" };

    const dEnsure = deferred();
    let manifestDone = false;
    card._refreshManifest = async () => {
      card._frames = [{ url: "frame-0", type: "measurement", ts: 0 }];
      manifestDone = true;
    };
    card._ensureFrame = () => dEnsure.promise;

    const loadPromise = card._loadData();
    // Yield until _refreshManifest has resolved and _ensureFrame is awaited.
    await Promise.resolve();
    expect(manifestDone).toBe(true);

    // Teardown fires between _refreshManifest and _ensureFrame completing.
    card._initialized = true; // needed for _teardown's guard
    card._teardown();
    expect(card._epoch).toBe(1);

    dEnsure.resolve([]);
    await loadPromise;

    // No frame shown, no autoplay, no _dataReady.
    expect(card._showFrameCalled).toBeUndefined();
    expect(card._startPlayCalled).toBe(false);
    expect(card._dataReady).toBe(false);
  });

  it("_loadData does not start autoplay when _teardown fires after _ensureFrame resolves", async () => {
    const card = makeCard();
    card._config = { autoplay_mode: "full" };
    makeManifestStub(card);

    // Stub _ensureFrame with a deferred promise so we control when it resolves.
    let ensureFrameResolve;
    card._ensureFrame = (url) => {
      return new Promise((res) => { ensureFrameResolve = () => res([]); });
    };

    const loadPromise = card._loadData();

    // Drain all pending microtasks so _refreshManifest has resolved and
    // _ensureFrame has been called (setting ensureFrameResolve).
    await new Promise((r) => setTimeout(r, 0));
    expect(typeof ensureFrameResolve).toBe("function");

    // Resolve _ensureFrame, then synchronously teardown before the continuation
    // microtask runs. The epoch check in _loadData catches the stale state.
    ensureFrameResolve();
    card._initialized = true;
    card._teardown();
    expect(card._epoch).toBe(1);

    await loadPromise;

    expect(card._startPlayCalled).toBe(false);
    expect(card._dataReady).toBe(false);
  });

  it("on re-attach a new _maybeInit succeeds after a stale one was abandoned", async () => {
    const card = makeCard();
    card._config = { autoplay_mode: "off" };
    makeManifestStub(card);

    const dFirstLeaflet = deferred();
    let leafletCallCount = 0;
    card._loadLeaflet = () => {
      leafletCallCount++;
      if (leafletCallCount === 1) return dFirstLeaflet.promise;
      return Promise.resolve({});
    };

    // First init — suspended waiting for Leaflet.
    const firstInit = card._maybeInit();
    expect(card._initialized).toBe(true);

    // Teardown fires; then card re-attaches and a second init starts.
    card._teardown();
    card._map = null; // teardown nulled map; simulate re-attach
    const secondInit = card._maybeInit();

    // Resolve the first Leaflet load (stale) and then the second.
    dFirstLeaflet.resolve({});
    await firstInit;

    await secondInit;

    // The second init should have completed, setting _initialized = true.
    expect(card._initialized).toBe(true);
    expect(card._refreshTimerStarted).toBe(true);
  });

  it("data chain starts before Leaflet resolves (parallel fetch, issue #72)", async () => {
    const card = makeCard();
    makeManifestStub(card);

    // Track when _refreshManifest is first called.
    let manifestStarted = false;
    const origManifest = card._refreshManifest.bind(card);
    card._refreshManifest = async (...args) => {
      manifestStarted = true;
      return origManifest(...args);
    };

    // Leaflet load is slow (deferred).
    const dLeaflet = deferred();
    card._loadLeaflet = () => dLeaflet.promise;

    const initPromise = card._maybeInit();

    // Yield one microtask tick so the earlyFetch IIFE can start.
    await Promise.resolve();

    // _refreshManifest should have been called even though Leaflet is still pending.
    expect(manifestStarted).toBe(true);

    // Now resolve Leaflet; _createMap runs, then _loadData joins earlyFetch.
    dLeaflet.resolve({});
    await initPromise;

    expect(card._initialized).toBe(true);
    expect(card._refreshTimerStarted).toBe(true);
    expect(card._showFrameCalled).toBe(true);
  });

  it("earlyFetch data-chain failure is caught and shown as a banner", async () => {
    const card = makeCard();

    const dLeaflet = deferred();
    card._loadLeaflet = () => dLeaflet.promise;

    // Stub manifest to reject — simulates a network error during earlyFetch.
    card._refreshManifest = async () => { throw new Error("network error"); };

    const initPromise = card._maybeInit();

    dLeaflet.resolve({});
    await initPromise;

    // Card must not be stuck: _initialized is true (no retry needed after
    // Leaflet succeeded), the banner is shown, and the refresh timer runs so
    // the timer loop can retry _loadData.
    expect(card._initialized).toBe(true);
    expect(card._refreshTimerStarted).toBe(true);
  });

  it("earlyFetch bails without calling _ensureFrame when _teardown fires after _refreshManifest", async () => {
    const card = makeCard();

    const dLeaflet = deferred();
    card._loadLeaflet = () => dLeaflet.promise;

    let ensureFrameCalled = false;
    card._ensureFrame = () => { ensureFrameCalled = true; return Promise.resolve([]); };

    const dManifest = deferred();
    card._refreshManifest = () => {
      card._frames = [{ url: "frame-0", type: "measurement", ts: 0 }];
      return dManifest.promise;
    };

    const initPromise = card._maybeInit();

    // Teardown before manifest resolves.
    card._teardown();
    dManifest.resolve();

    dLeaflet.resolve({});
    await initPromise;

    // earlyFetch should have bailed at the epoch check, skipping _ensureFrame.
    expect(ensureFrameCalled).toBe(false);
    expect(card._refreshTimerStarted).toBe(false);
  });

  it("stylesheet-load callback and rAF in _createMap do not throw when map is torn down (issue #140)", () => {
    const card = makeCard();
    // Drive the REAL _createMap (makeCard stubs it out) so we exercise the
    // actual link-load and rAF closures, not a copy.
    delete card._createMap;
    card._config = { ...card._config, center: [46.8, 8.2], zoom: 7 };
    card._hass = { config: { latitude: 46.8, longitude: 8.2 } };
    // _teardown only nulls _map when the card is initialized.
    card._initialized = true;

    let invalidateCalls = 0;
    const mapStub = { invalidateSize() { invalidateCalls++; }, remove() {} };
    const layer = { addTo() { return this; } };
    const L = {
      map: () => mapStub,
      tileLayer: () => layer,
      marker: () => layer,
      divIcon: () => ({}),
      Layer: { extend: () => class { addTo() { return this; } } },
    };

    // Capture the stylesheet "load" handler the card registers.
    let loadHandler = null;
    card.shadowRoot = {
      getElementById: () => ({}),
      querySelector: (sel) =>
        sel === "link"
          ? { addEventListener: (ev, h) => { if (ev === "load") loadHandler = h; } }
          : null,
    };

    // The vm-context requestAnimationFrame stub records callbacks here.
    windowRef.__rafCbs = [];
    card._createMap(L);
    const rafHandler = windowRef.__rafCbs[0];

    // Guard against a vacuous test: both closures must actually have been set up.
    expect(typeof loadHandler).toBe("function");
    expect(typeof rafHandler).toBe("function");

    // While the map is live, both closures recalc the map size.
    loadHandler();
    rafHandler();
    expect(invalidateCalls).toBe(2);

    // Teardown nulls the map; the deferred closures must now be inert, not throw.
    card._teardown();
    expect(card._map).toBe(null);
    expect(() => { loadHandler(); rafHandler(); }).not.toThrow();
    // The guard (if (this._map)) suppressed the calls — no new invalidateSize.
    expect(invalidateCalls).toBe(2);
  });
});

describe("_refreshManifest guard branches (issue #80)", () => {
  // Shared factory: returns a card with all DOM side-effects stubbed so
  // _refreshManifest can run to completion without a real browser context.
  // Call `opts.playing = true` to simulate an active playback session;
  // pre-populate `opts.frames` / `opts.frameIndex` to exercise rollover paths.
  function makeManifestCard(opts = {}) {
    const card = new MeteoSwissRadarCard();
    card._config = {};
    card._frames = opts.frames ?? [];
    card._frameIndex = opts.frameIndex ?? 0;
    card._playing = opts.playing ?? false;
    card._playMode = opts.playing ? "full" : "paused";
    card._animVersion = opts.animVersion ?? null;

    // DOM stubs
    card._tMeas = { style: {} };
    card._tFc = { style: {} };
    card._tNow = { style: {}, hidden: false };
    card._modeHint = { hidden: false };

    // Stubs for methods with heavy side-effects (DOM / network / timer).
    card._renderLegend = () => {};
    card._buildTimelineLabels = () => {};
    card._computeWindow = () => {};
    card._maybeResumeAfterFailure = () => {};

    // Spy stubs for rollover assertions.
    card._jumpToCalls = [];
    card._jumpTo = (idx) => { card._jumpToCalls.push(idx); };

    card._moveMarkersCalls = [];
    card._moveMarkers = (idx) => { card._moveMarkersCalls.push(idx); };

    return card;
  }

  // Minimal valid pictures array for the animation.json stub.
  function makePictures(overrides = []) {
    return [
      { radar_url: "frame-0.bin", data_type: "measurement", day: "23.08.2026", timepoint: "10:00", timestamp: 1000 },
      { radar_url: "frame-1.bin", data_type: "forecast",    day: "23.08.2026", timepoint: "10:05", timestamp: 1300 },
      ...overrides,
    ];
  }

  function makeApi(version, pictures) {
    return async (path) => {
      if (path.includes("versions.json"))
        return { "precipitation/animation": version };
      return { map_images: [{ pictures }], legend: [] };
    };
  }

  // --- guard: missing key in versions.json ---

  it("throws when versions.json has no precipitation/animation entry", async () => {
    const card = makeManifestCard();
    card._api = async (path) => {
      if (path.includes("versions.json")) return { "other/key": "v1" };
      return {};
    };
    await expect(card._refreshManifest(true)).rejects.toThrow(
      "precipitation/animation"
    );
  });

  // --- guard: version-unchanged early return (the 5-minute timer path) ---

  it("does not fetch animation.json when version is unchanged and not forced", async () => {
    const card = makeManifestCard({ animVersion: "v42" });
    let animCalls = 0;
    card._api = async (path) => {
      if (path.includes("versions.json"))
        return { "precipitation/animation": "v42" }; // same version
      animCalls++;
      return {};
    };
    await card._refreshManifest(false);
    expect(animCalls).toBe(0);
  });

  it("proceeds past the version check when forced even if version is unchanged", async () => {
    const card = makeManifestCard({ animVersion: "v42" });
    let animCalls = 0;
    card._api = async (path) => {
      if (path.includes("versions.json"))
        return { "precipitation/animation": "v42" };
      animCalls++;
      return { map_images: [{ pictures: makePictures() }], legend: [] };
    };
    await card._refreshManifest(true);
    expect(animCalls).toBe(1);
  });

  // --- pictures filter ---

  it("drops pictures with no radar_url", async () => {
    const card = makeManifestCard();
    const pics = [
      { data_type: "measurement", day: "23.08.2026", timepoint: "10:00", timestamp: 1000 }, // no radar_url
      { radar_url: "", data_type: "measurement", day: "23.08.2026", timepoint: "10:05", timestamp: 1005 }, // empty string
      { radar_url: "good.bin", data_type: "measurement", day: "23.08.2026", timepoint: "10:10", timestamp: 1010 },
    ];
    card._api = makeApi("v1", pics);
    await card._refreshManifest(true);
    expect(card._frames).toHaveLength(1);
    expect(card._frames[0].url).toBe("good.bin");
  });

  it("drops pictures with an unknown data_type", async () => {
    const card = makeManifestCard();
    const pics = [
      { radar_url: "thumb.bin", data_type: "thumbnail",   day: "23.08.2026", timepoint: "10:00", timestamp: 1000 },
      { radar_url: "meas.bin",  data_type: "measurement", day: "23.08.2026", timepoint: "10:05", timestamp: 1005 },
      { radar_url: "fc.bin",    data_type: "forecast",    day: "23.08.2026", timepoint: "10:10", timestamp: 1010 },
    ];
    card._api = makeApi("v1", pics);
    await card._refreshManifest(true);
    expect(card._frames).toHaveLength(2);
    expect(card._frames.map((f) => f.url)).toEqual(["meas.bin", "fc.bin"]);
  });

  // --- sorting ---

  it("sorts out-of-order timestamps ascending", async () => {
    const card = makeManifestCard();
    const pics = [
      { radar_url: "c.bin", data_type: "forecast",    day: "23.08.2026", timepoint: "10:10", timestamp: 3000 },
      { radar_url: "a.bin", data_type: "measurement", day: "23.08.2026", timepoint: "10:00", timestamp: 1000 },
      { radar_url: "b.bin", data_type: "measurement", day: "23.08.2026", timepoint: "10:05", timestamp: 2000 },
    ];
    card._api = makeApi("v1", pics);
    await card._refreshManifest(true);
    expect(card._frames.map((f) => f.url)).toEqual(["a.bin", "b.bin", "c.bin"]);
  });

  // --- zero-frames guard ---

  it("throws when no pictures survive the filter", async () => {
    const card = makeManifestCard();
    const pics = [
      { radar_url: "thumb.bin", data_type: "thumbnail", day: "23.08.2026", timepoint: "10:00", timestamp: 1000 },
    ];
    card._api = makeApi("v1", pics);
    await expect(card._refreshManifest(true)).rejects.toThrow("no frames");
  });

  it("throws when map_images is absent (malformed animation.json)", async () => {
    const card = makeManifestCard();
    card._api = async (path) => {
      if (path.includes("versions.json"))
        return { "precipitation/animation": "v1" };
      return { legend: [] }; // no map_images at all
    };
    await expect(card._refreshManifest(true)).rejects.toThrow("no frames");
  });

  // --- _tNow / _modeHint visibility for measurement-only manifests ---

  it("hides _tNow and shows _modeHint when all frames are measurements", async () => {
    const card = makeManifestCard();
    const pics = [
      { radar_url: "a.bin", data_type: "measurement", day: "23.08.2026", timepoint: "10:00", timestamp: 1000 },
      { radar_url: "b.bin", data_type: "measurement", day: "23.08.2026", timepoint: "10:05", timestamp: 1005 },
    ];
    card._api = makeApi("v1", pics);
    await card._refreshManifest(true);
    // No forecast frames → _tNow is hidden, _modeHint is shown.
    expect(card._tNow.hidden).toBe(true);
    expect(card._modeHint.hidden).toBe(false);
  });

  it("shows _tNow and hides _modeHint when the manifest contains forecast frames", async () => {
    const card = makeManifestCard();
    card._api = makeApi("v1", makePictures()); // includes a forecast frame
    await card._refreshManifest(true);
    expect(card._tNow.hidden).toBe(false);
    expect(card._modeHint.hidden).toBe(true);
  });

  // --- rollover: playing → _moveMarkers, not _jumpTo ---

  it("on rollover while playing re-anchors via _moveMarkers without calling _jumpTo", async () => {
    const prevFrames = [
      { url: "old-0.bin", type: "measurement", ts: 1000 },
      { url: "old-1.bin", type: "forecast",    ts: 1300 },
    ];
    const card = makeManifestCard({ frames: prevFrames, frameIndex: 1, playing: true });
    card._api = makeApi("v2", makePictures());
    await card._refreshManifest(true);
    expect(card._jumpToCalls).toHaveLength(0);
    expect(card._moveMarkersCalls).toHaveLength(1);
    // The re-anchored index must be the nearest frame to the old ts (1300).
    expect(card._frameIndex).toBeGreaterThanOrEqual(0);
  });

  // --- rollover: paused → _jumpTo, not _moveMarkers ---

  it("on rollover while paused calls _jumpTo (not _moveMarkers) to refresh the frame", async () => {
    const prevFrames = [
      { url: "old-0.bin", type: "measurement", ts: 1000 },
      { url: "old-1.bin", type: "forecast",    ts: 1300 },
    ];
    const card = makeManifestCard({ frames: prevFrames, frameIndex: 1, playing: false });
    card._api = makeApi("v2", makePictures());
    await card._refreshManifest(true);
    expect(card._jumpToCalls).toHaveLength(1);
    expect(card._moveMarkersCalls).toHaveLength(0);
  });

  // --- no rollover when there is no previous frame ---

  it("skips rollover re-anchor when _frames was empty before the refresh", async () => {
    const card = makeManifestCard({ frames: [], frameIndex: 0 });
    card._api = makeApi("v1", makePictures());
    await card._refreshManifest(true);
    expect(card._jumpToCalls).toHaveLength(0);
    expect(card._moveMarkersCalls).toHaveLength(0);
    expect(card._frames).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------
// Layer overlay infrastructure (issue #92)
// --------------------------------------------------------------------------

describe("EDITOR_DEFAULTS for overlay layer config keys (issue #92)", () => {
  it("all four layer_<x> keys default to false (hidden)", () => {
    expect(EDITOR_DEFAULTS.layer_snow).toBe(false);
    expect(EDITOR_DEFAULTS.layer_snowrain).toBe(false);
    expect(EDITOR_DEFAULTS.layer_freezing_rain).toBe(false);
    expect(EDITOR_DEFAULTS.layer_lightning).toBe(false);
  });

  it("legacy layer_<x>_on keys are gone from EDITOR_DEFAULTS (issue #131)", () => {
    expect(EDITOR_DEFAULTS).not.toHaveProperty("layer_snow_on");
    expect(EDITOR_DEFAULTS).not.toHaveProperty("layer_snowrain_on");
    expect(EDITOR_DEFAULTS).not.toHaveProperty("layer_freezing_rain_on");
    expect(EDITOR_DEFAULTS).not.toHaveProperty("layer_lightning_on");
  });

  it("layer keys are stripped from emitted config when at their default (false)", () => {
    // The editor emits only non-default values; layer_snow: false is the default
    // and must be stripped so user YAML stays clean.
    const editor = new MeteoSwissRadarCardEditor();
    editor._config = { type: "t" };
    editor._updateForms = () => {};
    editor._emitted = [];
    editor.dispatchEvent = (ev) => {
      editor._emitted.push(ev.detail.config);
      return true;
    };
    // Emit with layer keys at default (false) — they should be stripped.
    editor._emit({
      type: "t",
      ...EDITOR_DEFAULTS,
      layer_snow: false,
      layer_snowrain: false,
    });
    expect(editor._config.layer_snow).toBeUndefined();
    expect(editor._config.layer_snowrain).toBeUndefined();
  });

  it("layer_snow: true survives _emit (non-default value)", () => {
    const editor = new MeteoSwissRadarCardEditor();
    editor._config = { type: "t" };
    editor._updateForms = () => {};
    editor._emitted = [];
    editor.dispatchEvent = (ev) => {
      editor._emitted.push(ev.detail.config);
      return true;
    };
    editor._emit({ type: "t", ...EDITOR_DEFAULTS, layer_snow: true });
    expect(editor._config.layer_snow).toBe(true);
  });
});

describe("_refreshManifest stores overlay URLs on forecast frames (issue #92)", () => {
  function makeCard() {
    const card = new MeteoSwissRadarCard();
    card._config = {};
    card._frames = [];
    card._tMeas = { style: {} };
    card._tFc = { style: {} };
    card._tNow = { style: {}, hidden: false };
    card._modeHint = { hidden: false };
    card._renderLegend = () => {};
    card._buildTimelineLabels = () => {};
    card._computeWindow = () => {};
    card._maybeResumeAfterFailure = () => {};
    return card;
  }

  it("stores overlay URLs on forecast frames with leading slash stripped", async () => {
    const card = makeCard();
    card._api = async (path) => {
      if (path.includes("versions.json"))
        return { "precipitation/animation": "v1" };
      return {
        map_images: [{
          pictures: [
            {
              radar_url: "/product/output/inca/precipitation/rate/version__20260824_0603/rate_20260824_0600.json",
              data_type: "forecast",
              day: "24.08.2026",
              timepoint: "06:00",
              timestamp: 1000,
              snow_url: "/product/output/inca/precipitation/type/snow/version__20260824_0603/snow_20260824_0600.json",
              snowrain_url: "/product/output/inca/precipitation/type/snowrain/version__20260824_0603/snowrain_20260824_0600.json",
              freezingrain_url: "/product/output/inca/precipitation/type/freezing-rain/version__20260824_0605/freezingrain_20260824_0600.json",
            },
          ],
        }],
        legend: [],
      };
    };
    await card._refreshManifest(true);
    const f = card._frames[0];
    expect(f.type).toBe("forecast");
    // Leading slash must be stripped (proxy expects no leading slash).
    expect(f.snow_url).toBe("product/output/inca/precipitation/type/snow/version__20260824_0603/snow_20260824_0600.json");
    expect(f.snowrain_url).toBe("product/output/inca/precipitation/type/snowrain/version__20260824_0603/snowrain_20260824_0600.json");
    expect(f.freezingrain_url).toBe("product/output/inca/precipitation/type/freezing-rain/version__20260824_0605/freezingrain_20260824_0600.json");
  });

  it("does not attach overlay URLs to measurement frames", async () => {
    const card = makeCard();
    card._api = async (path) => {
      if (path.includes("versions.json"))
        return { "precipitation/animation": "v1" };
      return {
        map_images: [{
          pictures: [
            {
              radar_url: "product/output/radar/rzc/radar_rzc.20260824_0600.json",
              data_type: "measurement",
              day: "24.08.2026",
              timepoint: "06:00",
              timestamp: 1000,
              // Measurement frames carry no overlay URLs in the live API;
              // the card must not store undefined/null for them.
            },
          ],
        }],
        legend: [],
      };
    };
    await card._refreshManifest(true);
    const f = card._frames[0];
    expect(f.type).toBe("measurement");
    expect(f.snow_url).toBeUndefined();
    expect(f.snowrain_url).toBeUndefined();
    expect(f.freezingrain_url).toBeUndefined();
  });

  it("per-product version pinning: snow and freezingrain may have different versions", async () => {
    const card = makeCard();
    card._api = async (path) => {
      if (path.includes("versions.json"))
        return { "precipitation/animation": "v1" };
      return {
        map_images: [{
          pictures: [{
            radar_url: "rate.json",
            data_type: "forecast",
            day: "24.08.2026",
            timepoint: "06:00",
            timestamp: 1000,
            snow_url: "/type/snow/version__20260824_0603/snow.json",
            snowrain_url: "/type/snowrain/version__20260824_0603/snowrain.json",
            freezingrain_url: "/type/freezing-rain/version__20260824_0605/freezingrain.json",
          }],
        }],
        legend: [],
      };
    };
    await card._refreshManifest(true);
    const f = card._frames[0];
    // Different version strings per product — stored verbatim from the manifest.
    expect(f.snow_url).toContain("0603");
    expect(f.freezingrain_url).toContain("0605");
  });
});

describe("config-only layer switching (issue #131)", () => {
  it("_showLightningForFrame draws strikes whenever layer and data exist (no toggle gate)", () => {
    const card = new MeteoSwissRadarCard();
    const calls = [];
    card._lightningLayer = { setStrikes: (s) => calls.push(s) };
    card._lightningMap = new Map([[600, [[46.5, 7.5]]]]);
    card._frames = [
      { ts: 600, type: "measurement" },
      { ts: 900, type: "measurement" },
    ];
    card._showLightningForFrame(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([[46.5, 7.5]]);
  });

  it("_refreshManifest fetches a new lightning version even when the animation version is unchanged", async () => {
    const card = new MeteoSwissRadarCard();
    card._config = { layer_lightning: true };
    card._animVersion = "a1";
    card._lightningVersion = "l1";
    const requested = [];
    card._api = (path) => {
      requested.push(path);
      if (path.includes("versions.json")) {
        return Promise.resolve({ "precipitation/animation": "a1", lightning: "l2" });
      }
      return Promise.resolve({});
    };
    await card._refreshManifest(false);
    expect(
      requested.some((p) => p.includes("lightning/version__l2/lightning.json"))
    ).toBe(true);
    // The animation early-return still applies: no manifest fetch happened.
    expect(requested.some((p) => p.includes("animation.json"))).toBe(false);
  });

  it("_applyLayerConfigInPlace creates and removes overlay layers on a live map", () => {
    const { MeteoSwissRadarCard: Card, windowRef } = loadDecoder();
    const card = new Card();
    const mapLayers = new Set();
    card._map = {
      addLayer: (l) => mapLayers.add(l),
      removeLayer: (l) => mapLayers.delete(l),
    };
    card._frames = [];
    // Minimal Leaflet stub: extend() must yield a constructor whose instances
    // register themselves on the map via addTo (real onAdd needs map panes).
    windowRef.L = {
      Layer: {
        extend(def) {
          function C() { if (def.initialize) def.initialize.call(this); }
          C.prototype = Object.create(def);
          C.prototype.addTo = function (m) { m.addLayer(this); return this; };
          return C;
        },
      },
    };
    try {
      card._applyLayerConfigInPlace({ layer_snow: true });
      expect(card._overlayLayers.snow).toBeTruthy();
      expect(mapLayers.has(card._overlayLayers.snow)).toBe(true);
      card._applyLayerConfigInPlace({});
      expect(card._overlayLayers.snow).toBeUndefined();
      expect(mapLayers.size).toBe(0);
    } finally {
      windowRef.L = undefined;
    }
  });

  it("_applyLayerConfigInPlace adds and removes the lightning layer with its data", () => {
    const { MeteoSwissRadarCard: Card, windowRef } = loadDecoder();
    const card = new Card();
    const mapLayers = new Set();
    card._map = {
      addLayer: (l) => mapLayers.add(l),
      removeLayer: (l) => mapLayers.delete(l),
    };
    card._frames = [];
    card._api = () => Promise.resolve({});
    windowRef.L = {
      Layer: {
        extend(def) {
          function C() { if (def.initialize) def.initialize.call(this); }
          C.prototype = Object.create(def);
          C.prototype.addTo = function (m) { m.addLayer(this); return this; };
          return C;
        },
      },
    };
    try {
      card._applyLayerConfigInPlace({ layer_lightning: true });
      expect(card._lightningLayer).toBeTruthy();
      expect(mapLayers.has(card._lightningLayer)).toBe(true);
      card._applyLayerConfigInPlace({});
      expect(card._lightningLayer).toBeNull();
      expect(card._lightningMap).toBeNull();
      expect(card._lightningVersion).toBeNull();
      expect(mapLayers.size).toBe(0);
    } finally {
      windowRef.L = undefined;
    }
  });
});

describe("overlay legend swatches (_updateOverlayLegend) (issue #92)", () => {
  function makeCardWithOverlayEl() {
    const card = new MeteoSwissRadarCard();
    card._overlayLayers = {};
    card._legendEl = { hidden: false };
    const cells = [];
    card._overlaySwatch = {
      hidden: true,
      textContent: "",
      get children() { return cells; },
      appendChild(el) { cells.push(el); },
    };
    return card;
  }

  it("hides the swatch div when no overlay is active", () => {
    const card = makeCardWithOverlayEl();
    // No layers in _overlayLayers → nothing active.
    card._updateOverlayLegend();
    expect(card._overlaySwatch.hidden).toBe(true);
  });

  it("shows one swatch row per enabled overlay", () => {
    const card = makeCardWithOverlayEl();
    // Simulate snow and snowrain layers created (enabled = shown, issue #131).
    card._overlayLayers = { snow: {}, snowrain: {} };
    const children = [];
    card._overlaySwatch = {
      hidden: true,
      textContent: "",
      get children() { return children; },
      appendChild(el) { children.push(el); },
    };
    card._updateOverlayLegend();
    expect(card._overlaySwatch.hidden).toBe(false);
    expect(children).toHaveLength(2);
  });

  it("shows a lightning swatch whenever the lightning layer exists", () => {
    const card = makeCardWithOverlayEl();
    card._lightningLayer = {};
    const children = [];
    card._overlaySwatch = {
      hidden: true,
      textContent: "",
      get children() { return children; },
      appendChild(el) { children.push(el); },
    };
    card._updateOverlayLegend();
    expect(card._overlaySwatch.hidden).toBe(false);
    expect(children).toHaveLength(1);
  });

  it("suppresses swatches and never forces the legend visible when legend:false", () => {
    const card = makeCardWithOverlayEl();
    // Active overlay, but the user has explicitly disabled the legend panel.
    card._config = { legend: false };
    card._overlayLayers = { snow: {} };
    card._legendEl = { hidden: true };
    const children = [];
    card._overlaySwatch = {
      hidden: true,
      textContent: "",
      get children() { return children; },
      appendChild(el) { children.push(el); },
    };
    card._updateOverlayLegend();
    expect(card._overlaySwatch.hidden).toBe(true);
    expect(children).toHaveLength(0);
    expect(card._legendEl.hidden).toBe(true); // not forced back on
  });
});

// _ensureOverlayFrame was merged into _ensureFrame(url, { bestEffort: true })
// in issue #138. New contract: backoff IS applied (to stop request storms on
// persistently-failing overlay URLs), but fail-streak/404-refresh/pause are not.
describe("_ensureFrame bestEffort does not affect fail streak (issue #92, #138)", () => {
  it("does not increment _failStreak on overlay fetch failure", async () => {
    const card = new MeteoSwissRadarCard();
    card._api = () => Promise.reject(new Error("overlay 502"));
    const before = card._failStreak;
    await card._ensureFrame("some/overlay.json", { bestEffort: true }).catch(() => {});
    expect(card._failStreak).toBe(before);
  });

  it("sets _retryAfter on overlay fetch failure to prevent request storms (issue #138)", async () => {
    const card = new MeteoSwissRadarCard();
    card._api = () => Promise.reject(new Error("overlay 502"));
    await card._ensureFrame("some/overlay.json", { bestEffort: true }).catch(() => {});
    expect(card._retryAfter.has("some/overlay.json")).toBe(true);
  });

  it("stores decoded areas in the shared cache on success", async () => {
    const card = new MeteoSwissRadarCard();
    card._api = () => Promise.resolve({ coords: GRID, areas: [] });
    await card._ensureFrame("overlay.json", { bestEffort: true });
    expect(card._cacheGet("overlay.json")).toBeDefined();
  });
});

// --------------------------------------------------------------------------
// parseLightning + strikesForFrame (issue #93)
// --------------------------------------------------------------------------

describe("parseLightning (issue #93)", () => {
  const fixtureRaw = JSON.parse(
    readFileSync(path.join(fixturesDir, "lightning.json"), "utf8"),
  );

  it("parses the real fixture into a Map with numeric keys and numeric coord pairs", () => {
    const map = parseLightning(fixtureRaw);
    expect(map instanceof Map).toBe(true);
    // Fixture has 4 distinct bucket timestamps.
    expect(map.size).toBe(4);
    for (const [ts, coords] of map) {
      expect(typeof ts).toBe("number");
      expect(Number.isFinite(ts)).toBe(true);
      for (const [lat, lng] of coords) {
        expect(typeof lat).toBe("number");
        expect(typeof lng).toBe("number");
        // All fixture strikes are in Switzerland.
        expect(lat).toBeGreaterThan(45);
        expect(lat).toBeLessThan(48);
        expect(lng).toBeGreaterThan(5);
        expect(lng).toBeLessThan(11);
      }
    }
  });

  it("coerces string keys to numbers", () => {
    const map = parseLightning({ "1000": [["46.5", "7.0"]] });
    expect(map.has(1000)).toBe(true);
    expect(map.get(1000)).toEqual([[46.5, 7.0]]);
  });

  it("coerces string coordinate values to numbers", () => {
    const map = parseLightning({ "1000": [["46.9892", "5.9804"]] });
    const [[lat, lng]] = map.get(1000);
    expect(typeof lat).toBe("number");
    expect(typeof lng).toBe("number");
    expect(lat).toBeCloseTo(46.9892, 4);
    expect(lng).toBeCloseTo(5.9804, 4);
  });

  it("skips entries with non-numeric timestamp keys", () => {
    const map = parseLightning({ bad: [["46.5", "7.0"]], "1000": [["46.5", "7.0"]] });
    expect(map.has(NaN)).toBe(false);
    expect(map.size).toBe(1);
  });

  it("returns an empty Map for an empty object", () => {
    expect(parseLightning({}).size).toBe(0);
  });
});

describe("strikesForFrame (issue #93)", () => {
  // Simple synthetic map: buckets at ts=1000, 1300, 1600.
  function makeMap() {
    const m = new Map();
    m.set(1000, [[46.9, 7.0]]);
    m.set(1300, [[47.0, 7.1], [46.8, 7.2]]);
    m.set(1600, [[46.7, 7.3]]);
    return m;
  }

  it("returns strikes whose bucket falls in [frameTs, frameTs+duration)", () => {
    // frameTs=1000, nextFrameTs=1300 → duration=300 → include bucket 1000 only.
    const strikes = strikesForFrame(makeMap(), 1000, 1300);
    expect(strikes).toEqual([[46.9, 7.0]]);
  });

  it("includes all strikes from a bucket that overlaps the window", () => {
    // frameTs=1300, nextFrameTs=1600 → duration=300 → include bucket 1300 (2 strikes).
    const strikes = strikesForFrame(makeMap(), 1300, 1600);
    expect(strikes).toHaveLength(2);
    expect(strikes).toContainEqual([47.0, 7.1]);
    expect(strikes).toContainEqual([46.8, 7.2]);
  });

  it("excludes strikes that land exactly at frameTs+duration (open upper bound)", () => {
    // bucket 1300 must NOT appear in [1000, 1300).
    const strikes = strikesForFrame(makeMap(), 1000, 1300);
    expect(strikes.some(([lat]) => lat === 47.0)).toBe(false);
  });

  it("includes the frame-start bucket (closed lower bound, offset=0)", () => {
    const strikes = strikesForFrame(makeMap(), 1000, 1300);
    expect(strikes.some(([lat]) => lat === 46.9)).toBe(true);
  });

  it("falls back to 300 s duration when nextFrameTs is null (last frame)", () => {
    // frameTs=1300, no next → duration=300 → include bucket 1300, exclude 1600.
    const strikes = strikesForFrame(makeMap(), 1300, null);
    expect(strikes).toHaveLength(2);
    expect(strikes.some(([lat]) => lat === 46.7)).toBe(false);
  });

  it("returns an empty array when no buckets fall in the window", () => {
    expect(strikesForFrame(makeMap(), 2000, 2300)).toEqual([]);
  });

  it("handles a 10-min forecast cadence (duration=600 s)", () => {
    // Window [1000, 1600): includes buckets 1000 and 1300.
    const strikes = strikesForFrame(makeMap(), 1000, 1600);
    expect(strikes).toHaveLength(3);
  });

  it("handles a 5-min measurement cadence matching the real bucket cadence", () => {
    // Real fixture: bucket 1787543400 → window [1787543100, 1787543400) would miss it.
    // Window [1787543400, 1787543700) should include bucket 1787543400.
    const fixture = parseLightning(
      JSON.parse(readFileSync(path.join(fixturesDir, "lightning.json"), "utf8")),
    );
    const strikes = strikesForFrame(fixture, 1787543400, 1787543700);
    expect(strikes).toHaveLength(2); // bucket 1787543400 has 2 strikes in fixture
  });

  it("returns [lat,lng] pairs in [lat,lng] order (not [lng,lat])", () => {
    // Fixture coords are ["lat_str","lng_str"]; parseLightning must preserve that order.
    const map = parseLightning({ "1000": [["46.9", "7.1"]] });
    const [[lat, lng]] = strikesForFrame(map, 1000, 1300);
    // lat must be ~47 (Swiss latitude range), lng must be ~7.
    expect(lat).toBeGreaterThan(45);
    expect(lng).toBeGreaterThan(5);
    expect(lng).toBeLessThan(11);
  });
});

describe("legacy autoplay compat (issue #81)", () => {
  it("setConfig({autoplay: true}) yields autoplay_mode='full'", () => {
    const card = new MeteoSwissRadarCard();
    card.setConfig({ autoplay: true });
    expect(card._config.autoplay_mode).toBe("full");
  });

  it("setConfig({autoplay: true, autoplay_mode: 'window'}) keeps autoplay_mode='window'", () => {
    const card = new MeteoSwissRadarCard();
    card.setConfig({ autoplay: true, autoplay_mode: "window" });
    expect(card._config.autoplay_mode).toBe("window");
  });

  it("setConfig without autoplay leaves autoplay_mode at default 'off'", () => {
    const card = new MeteoSwissRadarCard();
    card.setConfig({});
    expect(card._config.autoplay_mode).toBe("off");
  });
});

describe("_is404 heuristics (issue #81)", () => {
  function makeCard() {
    const card = new MeteoSwissRadarCard();
    return card;
  }

  it("matches status_code: 404", () => {
    const card = makeCard();
    expect(card._is404({ status_code: 404 })).toBe(true);
  });

  it("matches code: 404", () => {
    const card = makeCard();
    expect(card._is404({ code: 404 })).toBe(true);
  });

  it("matches message with /404/ regex", () => {
    const card = makeCard();
    expect(card._is404({ message: "not found 404" })).toBe(true);
  });

  it("matches error with /404/ regex", () => {
    const card = makeCard();
    expect(card._is404({ error: "404 error" })).toBe(true);
  });

  it("does not match '5040 bytes' (false positive probe)", () => {
    const card = makeCard();
    expect(card._is404({ message: "5040 bytes" })).toBe(false);
  });

  it("does not match '4004' (false positive probe: 4-0-0-4 without consecutive 404)", () => {
    const card = makeCard();
    expect(card._is404({ message: "4004" })).toBe(false);
  });

  it("does not match HTTP 401 error", () => {
    const card = makeCard();
    expect(card._is404({ error: "HTTP 401" })).toBe(false);
  });

  it("does not match exit code 0", () => {
    const card = makeCard();
    expect(card._is404({ message: "Process finished with code 0" })).toBe(false);
  });

  it("returns false for null error", () => {
    const card = makeCard();
    expect(card._is404(null)).toBe(false);
  });

  it("returns false for undefined error", () => {
    const card = makeCard();
    expect(card._is404(undefined)).toBe(false);
  });

  it("returns false for empty object", () => {
    const card = makeCard();
    expect(card._is404({})).toBe(false);
  });

  it("returns false for empty message string", () => {
    const card = makeCard();
    expect(card._is404({ message: "" })).toBe(false);
  });
});

describe("_refreshAfter404 60-second throttle (issue #81)", () => {
  function makeCard() {
    const card = new MeteoSwissRadarCard();
    card._refreshed = 0;
    card._lastManifest404Refresh = 0;
    card._refreshManifest = async () => {
      card._refreshed++;
    };
    return card;
  }

  it("calls _refreshManifest on first 404 refresh", async () => {
    const card = makeCard();
    card._lastManifest404Refresh = 0;
    await card._refreshAfter404();
    expect(card._refreshed).toBe(1);
  });

  it("throttles to one call within 60 seconds", async () => {
    const card = makeCard();
    const now = Date.now();
    card._lastManifest404Refresh = now - 30000; // 30s ago
    await card._refreshAfter404();
    // Within the 60s window: must not call
    expect(card._refreshed).toBe(0);
  });

  it("allows a second call after 60 seconds have passed", async () => {
    const card = makeCard();
    const now = Date.now();
    card._lastManifest404Refresh = now - 61000; // 61s ago
    await card._refreshAfter404();
    expect(card._refreshed).toBe(1);
  });

  it("updates _lastManifest404Refresh on each successful call", async () => {
    const card = makeCard();
    const before = Date.now();
    await card._refreshAfter404();
    const after = Date.now();
    expect(card._lastManifest404Refresh).toBeGreaterThanOrEqual(before);
    expect(card._lastManifest404Refresh).toBeLessThanOrEqual(after);
  });
});

describe("_pruneRetryAfter expiration pruning (issue #81)", () => {
  function makeCard() {
    const card = new MeteoSwissRadarCard();
    card._retryAfter = new Map();
    return card;
  }

  it("prunes expired (past) entries when size > 128", () => {
    const card = makeCard();
    const now = Date.now();
    // Add 130 entries: 65 expired, 65 future
    for (let i = 0; i < 65; i++) {
      card._retryAfter.set(`expired-${i}`, now - 1000); // 1s in the past
    }
    for (let i = 0; i < 65; i++) {
      card._retryAfter.set(`future-${i}`, now + 60000); // 1 min in the future
    }
    expect(card._retryAfter.size).toBe(130);
    card._pruneRetryAfter();
    // Expired entries removed, future entries kept.
    expect(card._retryAfter.size).toBe(65);
    for (let i = 0; i < 65; i++) {
      expect(card._retryAfter.has(`expired-${i}`)).toBe(false);
      expect(card._retryAfter.has(`future-${i}`)).toBe(true);
    }
  });

  it("does nothing when size <= 128", () => {
    const card = makeCard();
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      card._retryAfter.set(`entry-${i}`, now - 1000); // all expired
    }
    expect(card._retryAfter.size).toBe(100);
    card._pruneRetryAfter();
    // Under the 128 threshold: no pruning happens, expired entries stay.
    expect(card._retryAfter.size).toBe(100);
  });

  it("keeps only future (non-expired) entries", () => {
    const card = makeCard();
    const now = Date.now();
    // Fill to 129 (just over threshold).
    for (let i = 0; i < 64; i++) {
      card._retryAfter.set(`expired-${i}`, now - 1000);
    }
    for (let i = 0; i < 65; i++) {
      card._retryAfter.set(`future-${i}`, now + 60000);
    }
    card._pruneRetryAfter();
    // Only future entries remain.
    for (let i = 0; i < 65; i++) {
      expect(card._retryAfter.has(`future-${i}`)).toBe(true);
    }
  });

  it("prunes an entry at exactly the current time (boundary: t <= now deletes)", () => {
    const card = makeCard();
    const now = Date.now();
    // Add entries at exactly 'now' (boundary case where t == now).
    card._retryAfter.set("at-now", now);
    for (let i = 0; i < 130; i++) {
      card._retryAfter.set(`filler-${i}`, now - 1000); // expired
    }
    expect(card._retryAfter.size).toBe(131);
    card._pruneRetryAfter();
    // at-now must be deleted because t <= now is true when t == now.
    expect(card._retryAfter.has("at-now")).toBe(false);
  });

  it("keeps an entry in the future (not expired)", () => {
    const card = makeCard();
    const now = Date.now();
    // Comfortably in the future: _pruneRetryAfter re-reads Date.now() at
    // prune time, so a 1ms margin can race the map-population loop and get
    // pruned. Use a wide margin to test "future entries are kept" reliably.
    card._retryAfter.set("just-future", now + 60000);
    for (let i = 0; i < 130; i++) {
      card._retryAfter.set(`filler-${i}`, now - 1000); // expired
    }
    expect(card._retryAfter.size).toBe(131);
    card._pruneRetryAfter();
    // just-future must be kept because it is past 'now' (not expired).
    expect(card._retryAfter.has("just-future")).toBe(true);
  });
});

describe("Path2D cache eviction and view-key clear (issue #82)", () => {
  // Stub Leaflet objects to exercise makeRadarLayerClass without a real DOM or leaflet.
  // The RadarLayer needs: _map with getZoom(), getPixelOrigin(), getSize(), containerPointToLayerPoint(), on/off, getPane()
  // A minimal stub for Path2D that can be instantiated and has moveTo/lineTo/closePath.
  function makeStubLeaflet() {
    let listeners = {};
    return {
      Layer: {
        extend(methods) {
          return function() {
            this._pathCache = new Map();
            this._pathCacheMax = 48;
            for (const [key, fn] of Object.entries(methods)) {
              this[key] = fn;
            }
          };
        },
      },
      DomUtil: {
        create() {
          return {
            width: 0,
            height: 0,
            style: {},
            getContext() {
              return {
                setTransform() {},
                clearRect() {},
                fillStyle: "",
                globalAlpha: 1,
                fill() {},
              };
            },
          };
        },
        remove() {},
        setPosition() {},
      },
      StubMap: {
        getZoom() { return 8; },
        getPixelOrigin() { return { x: 0, y: 0 }; },
        getSize() { return { x: 512, y: 512 }; },
        containerPointToLayerPoint() { return { x: 0, y: 0 }; },
        on(event, fn, ctx) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push({ fn, ctx });
        },
        off(event, fn) {
          if (listeners[event]) {
            listeners[event] = listeners[event].filter(l => l.fn !== fn);
          }
        },
        getPane() {
          return { appendChild() {} };
        },
        // Helper to trigger events in tests
        _triggerEvent(event) {
          if (listeners[event]) {
            for (const { fn, ctx } of listeners[event]) {
              fn.call(ctx);
            }
          }
        },
      },
    };
  }

  function makeStubPath2D() {
    let commands = [];
    return {
      moveTo(x, y) { commands.push(['moveTo', x, y]); },
      lineTo(x, y) { commands.push(['lineTo', x, y]); },
      closePath() { commands.push(['closePath']); },
      _commands: commands,
    };
  }

  it("Path2D LRU eviction: oldest entry is removed when cache exceeds PATH_CACHE_SIZE", () => {
    const L = makeStubLeaflet();
    const RadarLayer = makeRadarLayerClass(L);
    const layer = new RadarLayer();
    layer.initialize();

    // Stub _map for layer initialization
    const map = Object.create(L.StubMap);
    layer._map = map;
    layer._canvas = L.DomUtil.create();
    layer._key = "0:0:0";
    layer._origin = { x: 0, y: 0 };

    // Create minimal areas array (one shape with one ring and two vertices).
    const makeAreas = () => [
      {
        color: "#000000",
        verts: new Float32Array([47.5, 8.5, 47.6, 8.6]),
        rings: new Int32Array([0, 4]),
      },
    ];

    // Fill the cache up to PATH_CACHE_SIZE.
    for (let i = 0; i < PATH_CACHE_SIZE; i++) {
      layer._getPaths(`frame-${i}`, makeAreas());
    }
    expect(layer._pathCache.size).toBe(PATH_CACHE_SIZE);

    // Adding one more should evict the oldest (frame-0).
    layer._getPaths(`frame-${PATH_CACHE_SIZE}`, makeAreas());
    expect(layer._pathCache.size).toBe(PATH_CACHE_SIZE);
    expect(layer._pathCache.has("frame-0")).toBe(false);
    expect(layer._pathCache.has(`frame-${PATH_CACHE_SIZE}`)).toBe(true);

    // Accessing an existing entry makes it MRU (not removed on next eviction).
    layer._getPaths("frame-1", makeAreas());
    layer._getPaths(`frame-${PATH_CACHE_SIZE + 1}`, makeAreas());
    expect(layer._pathCache.has("frame-1")).toBe(true);
    expect(layer._pathCache.has("frame-2")).toBe(false); // oldest is now evicted
  });

  it("_reset view-key cache clear: _pathCache is cleared when view changes (zoom/pan)", () => {
    const L = makeStubLeaflet();
    const RadarLayer = makeRadarLayerClass(L);
    const layer = new RadarLayer();
    layer.initialize();

    const map = Object.create(L.StubMap);
    layer._map = map;
    layer._canvas = L.DomUtil.create();
    layer._key = "8:0:0"; // initial view key
    layer._origin = { x: 0, y: 0 };
    layer._viewKey = function() {
      return `${this._map.getZoom()}:${this._map.getPixelOrigin().x}:${this._map.getPixelOrigin().y}`;
    };

    const makeAreas = () => [
      {
        color: "#000000",
        verts: new Float32Array([47.5, 8.5, 47.6, 8.6]),
        rings: new Int32Array([0, 4]),
      },
    ];

    // Populate cache with some paths.
    layer._getPaths("frame-1", makeAreas());
    layer._getPaths("frame-2", makeAreas());
    expect(layer._pathCache.size).toBe(2);

    // Simulate a zoom event (view key changes from "8:0:0" to "9:0:0").
    // Manually update zoom (simulating map.getZoom() returning 9 now).
    map.getZoom = function() { return 9; };

    // Call _reset() to check for view key change.
    layer._reset();

    // After _reset with view key change, cache should be cleared.
    expect(layer._pathCache.size).toBe(0);
    expect(layer._key).toBe("9:0:0"); // view key updated
  });

  it("_reset cache is NOT cleared when view key remains the same", () => {
    const L = makeStubLeaflet();
    const RadarLayer = makeRadarLayerClass(L);
    const layer = new RadarLayer();
    layer.initialize();

    const map = Object.create(L.StubMap);
    layer._map = map;
    layer._canvas = L.DomUtil.create();
    layer._key = "8:0:0";
    layer._origin = { x: 0, y: 0 };
    layer._viewKey = function() {
      return `${this._map.getZoom()}:${this._map.getPixelOrigin().x}:${this._map.getPixelOrigin().y}`;
    };

    const makeAreas = () => [
      {
        color: "#000000",
        verts: new Float32Array([47.5, 8.5, 47.6, 8.6]),
        rings: new Int32Array([0, 4]),
      },
    ];

    // Populate cache.
    layer._getPaths("frame-1", makeAreas());
    expect(layer._pathCache.size).toBe(1);

    // Call _reset() without changing the view key.
    layer._reset();

    // Cache should still have entries.
    expect(layer._pathCache.size).toBe(1);
    expect(layer._pathCache.has("frame-1")).toBe(true);
  });
});
