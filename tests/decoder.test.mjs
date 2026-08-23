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
