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
    `${src}\n;globalThis.__decoder = { gridKmToLatLng, decodeContour, decodeFrame, MeteoSwissRadarCard };`,
    ctx,
    { filename: "meteoswiss-radar-card.js" },
  );
  return ctx.__decoder;
}

const { gridKmToLatLng, decodeFrame, MeteoSwissRadarCard } = loadDecoder();

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
