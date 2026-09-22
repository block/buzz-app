import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";

it("keeps four designs tied to fresh native usage and resets totals on replacement", async () => {
  const html = readFileSync(
    new URL("../public/compute-widget.html", import.meta.url),
    "utf8",
  );
  const script = readFileSync(
    new URL("../public/compute-widget.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost",
  });
  try {
    let status = {
      generation: 1,
      state: "running",
      usage: { tokensServed: 120, inflight: 0, tokensPerSecond: 5, peers: 2 },
    };
    const win = dom.window;
    win.matchMedia = () => ({ matches: true });
    win.HTMLCanvasElement.prototype.getContext = () =>
      new Proxy(
        {},
        {
          get: () => () => {},
        },
      );
    win.requestAnimationFrame = () => 0;
    win.setTimeout = () => 0;
    win.clearTimeout = () => {};
    let read = async () => status;
    win.__TAURI_INTERNALS__ = { invoke: () => read() };
    const context = dom.getInternalVMContext();
    const run = (code) => vm.runInContext(code, context);
    run(script);
    await run("poll()");
    expect(run("model.total")).toBe(120);
    expect(run("model.phase")).toBe("online");
    // Exercise the real moving bee, not only the reduced-motion fallback.
    const movingFrames = [0, 350, 700, 1100, 2200, 3800, 6500].map((elapsed) =>
      run(
        `draw("orbit", {phase:phases[3], index:3, elapsed:${elapsed}}, false)`,
      ),
    );
    for (const frame of movingFrames) {
      expect(frame.sprite.length).toBeGreaterThan(0);
      expect(frame.sprite.flat().every(Number.isFinite)).toBe(true);
      expect(frame.streaks.flat().every(Number.isFinite)).toBe(true);
    }
    expect(movingFrames[3].sprite).not.toEqual(movingFrames[4].sprite);

    for (const name of ["orbit", "signal", "original", "bee"]) {
      win.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "ArrowRight" }),
      );
      expect(run("variation")).toBe(name);
      const frame = run(
        "variation==='original'?drawOriginal({phase:phases[3],index:3,elapsed:1100},true):variation==='bee'?draw('orbit',{phase:phases[3],index:3,elapsed:1100},true):drawInstrument({phase:phases[3],index:3,elapsed:1100},true)",
      );
      expect(frame.white.every(Number.isFinite)).toBe(true);
      for (let key = 0; key <= 9; key++) {
        win.dispatchEvent(
          new win.KeyboardEvent("keydown", { key: String(key) }),
        );
        run("render(performance.now())");
        expect(
          win.document.getElementById("display").getAttribute("aria-label"),
        ).toContain("Visual state preview");
      }
    }
    expect(win.document.querySelector("select")).toBeNull();
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(run("variation")).toBe("original");
    status = { generation: 1, state: "running", usage: null };
    await run("poll()");
    expect(run("model.valid")).toBe(false);
    expect(run("model.phase")).toBe("offline");
    status = { generation: 2, state: "starting", usage: null };
    await run("poll()");
    expect(run("model.total")).toBe(null);
    expect(run("model.phase")).toBe("link");
    status = { generation: 2, state: "failed", usage: null };
    await run("poll()");
    expect(run("model.phase")).toBe("error");
    const timers = new Map();
    win.setTimeout = (callback, delay) => {
      timers.set(delay, callback);
      return delay;
    };
    win.clearTimeout = (delay) => timers.delete(delay);
    win.console.warn = () => {};
    let finishLate;
    read = () =>
      new Promise((resolve) => {
        finishLate = resolve;
      });
    const pending = run("poll()");
    timers.get(8000)();
    await pending;
    expect(timers.has(1000)).toBe(true);
    read = async () => ({
      generation: 3,
      state: "running",
      usage: { tokensServed: 7, inflight: 0 },
    });
    await run("poll()");
    finishLate({
      generation: 1,
      state: "running",
      usage: { tokensServed: 999, inflight: 1 },
    });
    await Promise.resolve();
    expect(run("model.total")).toBe(7);
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "4" }));
    expect(run("inspectedState.index")).toBe(3);
    expect(win.document.body.textContent).not.toContain("PREVIEW");
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(run("inspectedState")).toBeNull();
  } finally {
    dom.window.close();
  }
});
