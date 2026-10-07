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
    const context = dom.getInternalVMContext();
    const run = (code) => vm.runInContext(code, context);
    run(script);
    win.meshStatus = status;
    run("acceptStatus(window.meshStatus)");
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
      run("render(performance.now())");
      win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "4" }));
      expect(run("inspectedState")).toBeNull();
    }
    expect(win.document.querySelector("select")).toBeNull();
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(run("variation")).toBe("original");
    status = { generation: 1, state: "running", usage: null };
    win.meshStatus = status;
    run("acceptStatus(window.meshStatus)");
    expect(run("model.valid")).toBe(false);
    expect(run("model.phase")).toBe("online");
    status = { generation: 2, state: "starting", usage: null };
    win.meshStatus = status;
    run("acceptStatus(window.meshStatus)");
    expect(run("model.total")).toBe(null);
    expect(run("model.phase")).toBe("link");
    status = { generation: 2, state: "failed", usage: null };
    win.meshStatus = status;
    run("acceptStatus(window.meshStatus)");
    expect(run("model.phase")).toBe("error");
    const timers = new Map();
    win.setTimeout = (callback, delay) => {
      timers.set(delay, callback);
      return delay;
    };
    win.clearTimeout = (delay) => timers.delete(delay);
    const update = (next, source = win.parent) =>
      win.dispatchEvent(
        new win.MessageEvent("message", {
          source,
          data: { type: "buzz-mesh-activity", status: next },
        }),
      );
    update({
      generation: 3,
      state: "running",
      usage: { tokensServed: 7, inflight: 1, peers: 2 },
    });
    expect(run("model.total")).toBe(7);
    expect(run("model.phase")).toBe("active");
    update(
      {
        generation: 3,
        state: "running",
        usage: { tokensServed: 999, inflight: 1 },
      },
      {},
    );
    expect(run("model.total")).toBe(7);
    update({
      generation: 4,
      state: "running",
      usage: { tokensServed: null, inflight: null, peers: 1 },
    });
    expect(run("model.total")).toBeNull();
    expect(run("model.peers")).toBe(1);
    expect(run("model.phase")).toBe("online");
    expect(run("model.batch")).toBeNull();
    timers.get(5000)();
    expect(run("model.valid")).toBe(false);
    expect(run("model.total")).toBeNull();
    expect(run("model.phase")).toBe("offline");
    update({ generation: 4, state: "running", usage: null });
    expect(run("model.phase")).toBe("online");
    expect(run("model.total")).toBeNull();
    expect(script).not.toContain("community_compute_status");
    expect(script).not.toContain("start_dragging");
  } finally {
    dom.window.close();
  }
});
