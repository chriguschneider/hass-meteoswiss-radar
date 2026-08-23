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
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const cardPath = fileURLToPath(
  new URL(
    "../custom_components/meteoswiss_radar/frontend/meteoswiss-radar-card.js",
    import.meta.url,
  ),
);

function loadDecoder() {
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
    `${src}\n;globalThis.__decoder = { gridKmToLatLng, decodeContour, decodeFrame, MeteoSwissRadarCard, MeteoSwissRadarCardEditor, EDITOR_DEFAULTS };`,
    ctx,
    { filename: "meteoswiss-radar-card.js" },
  );
  return ctx.__decoder;
}

const { gridKmToLatLng, decodeFrame, MeteoSwissRadarCard, MeteoSwissRadarCardEditor, EDITOR_DEFAULTS } =
  loadDecoder();

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

  it("preserves area/shape/ring structure and prefixes the fill color", () => {
    const decoded = decodeFrame(frame);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].color).toBe("#9e849a");
    expect(decoded[0].shapes).toHaveLength(1);
    expect(decoded[0].shapes[0]).toHaveLength(1);
  });

  it("emits one vertex per digit in o, each inside the Swiss bbox", () => {
    const ring = decodeFrame(frame)[0].shapes[0][0];
    expect(ring).toHaveLength(2);
    for (const [lat, lng] of ring) {
      expect(lat).toBeGreaterThan(45);
      expect(lat).toBeLessThan(48);
      expect(lng).toBeGreaterThan(5);
      expect(lng).toBeLessThan(11);
    }
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
    card._cache.set("a", 1);
    card._pending.set("a", Promise.resolve());
    card._retryAfter.set("a", 1);

    card._teardown();

    expect(removed).toBe(true); // Leaflet listeners/tile layer released
    expect(card._map).toBe(null);
    expect(card._radar).toBe(null);
    expect(card._cache.size).toBe(0);
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
