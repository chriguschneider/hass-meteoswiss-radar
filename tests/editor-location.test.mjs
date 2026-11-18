/* Editor Location panel and the card's in-place re-centre (issue #261).
 *
 * Loads the shipped card in a vm context like decoder.test.mjs, but with a
 * small fake DOM so the editor can actually render its panels, and a mocked
 * `fetch` so the place search never touches the network.
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

class FakeEl {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._listeners = {};
    this._text = "";
    this.style = { setProperty() {} };
    this.hidden = false;
    this.isConnected = true;
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    };
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  fire(type, detail) {
    const ev = { type, detail, stopPropagation() {} };
    for (const fn of this._listeners[type] || []) fn(ev);
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
}

function load({ fetchImpl } = {}) {
  const src = readFileSync(cardPath, "utf8");
  const noop = () => {};
  const registry = { get: () => undefined, define: noop, whenDefined: () => Promise.resolve() };
  const fetchCalls = [];
  const ctx = {
    window: { customElements: registry, customCards: [], L: undefined },
    document: {
      querySelector: () => null,
      readyState: "complete",
      addEventListener: noop,
      createElement: (tag) => new FakeEl(tag),
    },
    customElements: registry,
    HTMLElement: FakeEl,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    console: { info: noop, warn: noop, error: noop },
    fetch: (url) => {
      fetchCalls.push(url);
      return fetchImpl ? fetchImpl(url) : Promise.reject(new Error("no fetch in tests"));
    },
    requestAnimationFrame: noop,
    setTimeout,
    clearTimeout,
    Promise, Date, Math, Array, Object, Number, String, Map, Set, JSON, Intl,
    encodeURIComponent,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    `${src}\n;globalThis.__t = { MeteoSwissRadarCard, MeteoSwissRadarCardEditor };`,
    ctx,
    { filename: cardPath },
  );
  return { ...ctx.__t, fetchCalls };
}

const HASS = {
  config: { latitude: 47.3769, longitude: 8.5417, location_name: "Zürich" },
  locale: { language: "de" },
};

function makeEditor(config, { hass = HASS, fetchImpl } = {}) {
  const t = load({ fetchImpl });
  const editor = new t.MeteoSwissRadarCardEditor();
  editor.emitted = [];
  editor.dispatchEvent = (ev) => {
    editor.emitted.push(ev.detail.config);
    return true;
  };
  editor.hass = hass;
  editor.setConfig(config);
  return { editor, fetchCalls: t.fetchCalls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

describe("editor Location panel (issue #261)", () => {
  it("is the first panel, above the basics", () => {
    const { editor } = makeEditor({ type: "t" });
    const [style, first, second] = editor.children;
    expect(style.tagName).toBe("STYLE");
    expect(first).toBe(editor._locPanel);
    expect(first.tagName).toBe("HA-EXPANSION-PANEL");
    expect(second.classList.contains("msr-basics")).toBe(true);
    expect(first.children[0].textContent).toContain("Location");
  });

  it("shows the HA home line with 2 decimals", () => {
    const { editor } = makeEditor({ type: "t" });
    expect(editor._locHomeEl.textContent).toBe(
      "Home, as set in Home Assistant: Zürich · 47.38, 8.54",
    );
  });

  it("switch off: no center, fields hidden, summary names home", () => {
    const { editor } = makeEditor({ type: "t" });
    expect(editor._locSwitchForm.data).toEqual({ use_other_location: false });
    expect(editor._locFieldsEl.hidden).toBe(true);
    expect(editor._summaryEls.location.textContent).toBe("Home · Zürich");
  });

  it("switch on presets center from hass.config and shows the fields", () => {
    const { editor } = makeEditor({ type: "t" });
    editor._locSwitchForm.fire("value-changed", { value: { use_other_location: true } });
    expect(editor.emitted.at(-1)).toEqual({ type: "t", center: [47.3769, 8.5417] });
    expect(editor._locFieldsEl.hidden).toBe(false);
    expect(editor._locMapForm.data).toEqual({
      location: { latitude: 47.3769, longitude: 8.5417 },
    });
    expect(editor._summaryEls.location.textContent).toBe("47.38, 8.54");
  });

  it("switch on without HA home coordinates writes no center (never 0, 0)", () => {
    const { editor } = makeEditor({ type: "t" }, { hass: { config: {} } });
    editor._locSwitchForm.fire("value-changed", { value: { use_other_location: true } });
    expect(editor.emitted.at(-1)).toEqual({ type: "t" });
    expect(editor._locFieldsEl.hidden).toBe(false);
    expect(editor._locMapForm.data).toEqual({});
    expect(editor._locHomeEl.textContent).toBe("Home, as set in Home Assistant: not set");
  });

  it("switch off removes center and hides the fields", () => {
    const { editor } = makeEditor({ type: "t", center: [46.5, 7.5], zoom: 9 });
    expect(editor._locFieldsEl.hidden).toBe(false);
    editor._locSwitchForm.fire("value-changed", { value: { use_other_location: false } });
    expect(editor.emitted.at(-1)).toEqual({ type: "t", zoom: 9 });
    expect(editor._locFieldsEl.hidden).toBe(true);
  });

  it("the panel's reset button removes center like the switch", () => {
    const { editor } = makeEditor({ type: "t", center: [46.5, 7.5] });
    const head = editor._locPanel.children[0];
    const reset = head.children.find((c) => c.tagName === "HA-ICON-BUTTON");
    reset.fire("click");
    expect(editor.emitted.at(-1)).toEqual({ type: "t" });
  });

  it("writes a map value as center: [lat, lon]", () => {
    const { editor } = makeEditor({ type: "t", center: [46.5, 7.5] });
    editor._locMapForm.fire("value-changed", {
      value: { location: { latitude: 46.948, longitude: 7.4474 } },
    });
    expect(editor.emitted.at(-1)).toEqual({ type: "t", center: [46.948, 7.4474] });
    expect(editor._summaryEls.location.textContent).toBe("46.95, 7.45");
  });

  it("keeps center when a basics field changes", () => {
    const { editor } = makeEditor({ type: "t", center: [46.5, 7.5] });
    const basics = editor.children[2];
    basics.fire("value-changed", { value: { ...basics.data, height: 500 } });
    expect(editor.emitted.at(-1)).toEqual({ type: "t", center: [46.5, 7.5], height: 500 });
  });
});

describe("editor place search (issue #261)", () => {
  const BERN = {
    results: [
      { name: "Bern", admin1: "Bern", country: "Schweiz", latitude: 46.94809, longitude: 7.44744 },
      { name: "Bern", country: "Deutschland", latitude: 50.1, longitude: 8.6 },
    ],
  };

  function typeQuery(editor, q) {
    editor._locQueryForm.fire("value-changed", { value: { query: q } });
  }

  it("makes no request on render, on typing or on marker drag", async () => {
    const { editor, fetchCalls } = makeEditor({ type: "t", center: [46.5, 7.5] });
    typeQuery(editor, "Bern");
    editor._locMapForm.fire("value-changed", {
      value: { location: { latitude: 46.6, longitude: 7.6 } },
    });
    await flush();
    expect(fetchCalls).toEqual([]);
  });

  it("one click sends one request with name, count, language and format", async () => {
    const { editor, fetchCalls } = makeEditor(
      { type: "t", center: [46.5, 7.5] },
      { fetchImpl: () => ok(BERN) },
    );
    typeQuery(editor, "St. Gallen");
    editor._locSearchBtn.fire("click");
    await flush();
    expect(fetchCalls).toEqual([
      "https://geocoding-api.open-meteo.com/v1/search?name=St.%20Gallen&count=10&language=de&format=json",
    ]);
  });

  it("lists hits as 'name, admin1, country'; picking one writes center", async () => {
    const { editor } = makeEditor(
      { type: "t", center: [46.5, 7.5] },
      { fetchImpl: () => ok(BERN) },
    );
    typeQuery(editor, "Bern");
    editor._locSearchBtn.fire("click");
    await flush();
    const items = editor._locResultsEl.children;
    expect(items.map((el) => el.textContent)).toEqual([
      "Bern, Bern, Schweiz",
      "Bern, Deutschland",
    ]);
    items[0].fire("click");
    expect(editor.emitted.at(-1)).toEqual({ type: "t", center: [46.94809, 7.44744] });
    expect(editor._locMapForm.data).toEqual({
      location: { latitude: 46.94809, longitude: 7.44744 },
    });
    expect(editor._locResultsEl.children).toEqual([]);
  });

  it("says so when no place is found (Open-Meteo omits `results`)", async () => {
    const { editor } = makeEditor(
      { type: "t", center: [46.5, 7.5] },
      { fetchImpl: () => ok({ generationtime_ms: 0.5 }) },
    );
    typeQuery(editor, "Xyzzy");
    editor._locSearchBtn.fire("click");
    await flush();
    expect(editor._locStatusEl.textContent).toMatch(/^No place found/);
    expect(editor._locResultsEl.children).toEqual([]);
  });

  it("a failed fetch shows the error and leaves the fields editable", async () => {
    const { editor } = makeEditor(
      { type: "t", center: [46.5, 7.5] },
      { fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")) },
    );
    typeQuery(editor, "Bern");
    editor._locSearchBtn.fire("click");
    await flush();
    expect(editor._locStatusEl.textContent).toMatch(/^Place search failed/);
    expect(editor._locSearchBtn.disabled).toBe(false);
    expect(editor._locFieldsEl.hidden).toBe(false);
    editor._locMapForm.fire("value-changed", {
      value: { location: { latitude: 46.6, longitude: 7.6 } },
    });
    expect(editor.emitted.at(-1)).toEqual({ type: "t", center: [46.6, 7.6] });
  });

  it("an HTTP error counts as a failed search", async () => {
    const { editor } = makeEditor(
      { type: "t", center: [46.5, 7.5] },
      { fetchImpl: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }) },
    );
    typeQuery(editor, "Bern");
    editor._locSearchBtn.fire("click");
    await flush();
    expect(editor._locStatusEl.textContent).toMatch(/^Place search failed/);
  });

  it("an empty query sends nothing", async () => {
    const { editor, fetchCalls } = makeEditor({ type: "t", center: [46.5, 7.5] });
    typeQuery(editor, "   ");
    editor._locSearchBtn.fire("click");
    await flush();
    expect(fetchCalls).toEqual([]);
  });
});

describe("card re-centres the live map in place (issue #261)", () => {
  function makeCard() {
    const t = load();
    const card = new t.MeteoSwissRadarCard();
    card._hass = HASS;
    card.setConfig({ type: "t" });
    card._initialized = true;
    const calls = [];
    card._map = {
      setView: (center, zoom) => calls.push(["setView", center, zoom]),
      setZoom: (zoom) => calls.push(["setZoom", zoom]),
      invalidateSize: () => calls.push(["invalidateSize"]),
    };
    card._refreshManifest = () => {
      calls.push(["refreshManifest"]);
      return Promise.resolve();
    };
    card._dataReady = true;
    card._createMap = () => calls.push(["createMap"]);
    return { card, calls };
  }

  it("a changed center moves the existing map, without rebuild or reload", () => {
    const { card, calls } = makeCard();
    card.setConfig({ type: "t", center: [46.5, 7.5] });
    expect(calls).toEqual([["setView", [46.5, 7.5], 8]]);
  });

  it("a changed zoom re-applies the view", () => {
    const { card, calls } = makeCard();
    card.setConfig({ type: "t", zoom: 10 });
    expect(calls).toEqual([["setView", [47.3769, 8.5417], 10]]);
  });

  it("removing center goes back to the HA home", () => {
    const { card, calls } = makeCard();
    card.setConfig({ type: "t", center: [46.5, 7.5] });
    card.setConfig({ type: "t" });
    expect(calls.at(-1)).toEqual(["setView", [47.3769, 8.5417], 8]);
  });

  it("an unchanged center and zoom leave the map alone", () => {
    const { card, calls } = makeCard();
    card.setConfig({ type: "t", center: [46.5, 7.5] });
    calls.length = 0;
    card.setConfig({ type: "t", center: [46.5, 7.5], legend: false });
    expect(calls).toEqual([]);
  });

  it("without center or HA home only the zoom changes", () => {
    const { card, calls } = makeCard();
    card._hass = { config: {} };
    card.setConfig({ type: "t", zoom: 9 });
    expect(calls).toEqual([["setZoom", 9]]);
  });
});
