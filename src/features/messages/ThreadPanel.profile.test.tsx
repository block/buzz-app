// @vitest-environment jsdom
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, loadavg, release } from "node:os";
import { Session } from "node:inspector/promises";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, it, vi } from "vitest";
import { ThreadPanel } from "./ThreadPanel";
import {
  threadData,
  threadSample,
  workload,
} from "../relay/thread-profile-fixture";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";

// Isolate thread acquisition from composer emoji demand and DOM reading dwell.
// Actual React effects, ThreadPanel, MessageRow, session and HTTP verification run.
// jsdom observes DOM commit, NOT browser layout/paint or native interaction.
vi.mock("./MessageComposer", () => ({ MessageComposer: () => null }));
vi.mock("./use-reading", () => ({
  Reading: () => null,
  readingPositioned: () => {},
}));

// Fixed geometry drives the real virtualizer. This remains a jsdom DOM-commit
// profile, not a browser layout measurement; do not compare it to the old
// all-rows-mounted harness. Browser warm-switch measurements cover real layout.
const geometry = { width: 800, height: 600, rowHeight: 96 };
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
    geometry.width,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    geometry.height,
  );
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.parentElement;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        0,
        0,
        geometry.width,
        this.matches("[data-message-scroller]")
          ? geometry.height
          : geometry.rowHeight,
      );
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      const list = this.querySelector<HTMLElement>("[data-thread-rows] > ol");
      return Math.max(
        geometry.height,
        geometry.rowHeight + Number.parseFloat(list?.style.height ?? "0"),
      );
    },
  );
  HTMLElement.prototype.scrollTo = function (options) {
    if (typeof options === "object")
      this.scrollTop = options.top ?? this.scrollTop;
  };
  HTMLElement.prototype.scrollBy = function (options) {
    if (typeof options === "object") this.scrollTop += options.top ?? 0;
  };
  const offsets = new WeakMap<HTMLElement, number>();
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
    function (this: HTMLElement) {
      return offsets.get(this) ?? 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
    function (this: HTMLElement, value) {
      const next = Math.max(
        0,
        Math.min(value, this.scrollHeight - geometry.height),
      );
      if (next === (offsets.get(this) ?? 0)) return;
      offsets.set(this, next);
      queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        queueMicrotask(() => {
          if (this.targets.has(target))
            this.callback(
              [
                {
                  target,
                  contentRect: target.getBoundingClientRect(),
                } as ResizeObserverEntry,
              ],
              this,
            );
        });
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
});
afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollBy;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(session: RelaySession, channelId: string, messageId: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let view: ThreadView | undefined;
  // Forward every capability unchanged, intercepting allocation only to observe it.
  const observed: RelaySession = {
    ...session,
    thread(...args) {
      view = session.thread(...args);
      return view;
    },
  };
  flushSync(() =>
    root.render(
      <ThreadPanel
        session={observed}
        scope="profile"
        channelName="A"
        channelId={channelId}
        messageId={messageId}
        close={() => {}}
        onOpenLink={() => false}
      />,
    ),
  );
  assert.ok(view, "real panel must allocate its own thread");
  const owned = view;
  return {
    view: owned,
    async rendered() {
      const ready = () => {
        const rows = [
          ...container.querySelectorAll<HTMLElement>("[data-message-id]"),
        ];
        const snapshot = owned.snapshot();
        const expected = [snapshot.root, ...snapshot.replies].filter(
          (row) => !!row,
        );
        const ids = expected.map((row) => row.id);
        const mounted = rows.map((row) => row.dataset.messageId);
        // Full loaded history is checked by threadSample, not by DOM cardinality.
        // Require the real virtual window to reach the newest reply and preserve
        // canonical order without rendering the complete loaded history.
        return (
          rows.length > 1 &&
          rows.length < expected.length &&
          mounted[0] === snapshot.root?.id &&
          mounted.at(-1) === snapshot.replies.at(-1)?.id &&
          mounted.every(
            (id, i) =>
              id &&
              ids.includes(id) &&
              (i === 0 || ids.indexOf(id) > ids.indexOf(mounted[i - 1] ?? "")),
          ) &&
          !container.querySelector("[data-positioning]") &&
          container.textContent?.includes("Author 7") === true
        );
      };
      if (ready()) return;
      await new Promise<void>((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (ready()) {
            observer.disconnect();
            clearTimeout(timer);
            resolve();
          }
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("Thread DOM did not settle"));
        }, 10_000);
        observer.observe(container, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      });
    },
    dispose() {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function provenance() {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const paths = [
    ...new Set(
      git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
        .split("\0")
        .filter(
          (p) => /\.(ts|tsx|mjs|js|json|yaml|yml)$/.test(p) && existsSync(p),
        ),
    ),
  ].sort();
  const hashes = Object.fromEntries(
    paths.map((p) => [p, hash(readFileSync(p))]),
  );
  return {
    head: git("rev-parse", "HEAD"),
    fingerprint: hash(JSON.stringify(hashes)),
    hashes,
  };
}

it("profiles the unchanged mounted app thread over signed HTTP, cold then reopen", async () => {
  const output = process.env.BUZZ_ENGINE_PROFILE_OUT;
  const count = output
    ? Number(process.env.BUZZ_ENGINE_PROFILE_SAMPLES ?? 7)
    : 1;
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 50);
  if (output) assert.ok(!existsSync(output), "choose a new output path");
  const source = output ? provenance() : undefined;
  const initialLoad = output ? loadavg() : undefined;
  const data = threadData(); // signatures are setup, outside the timed work
  const warmups = output ? 2 : 0;
  for (let i = 0; i < warmups; i++) await threadSample(data, mount);
  const profiler = process.env.BUZZ_ENGINE_CPU_OUT ? new Session() : undefined;
  if (profiler) {
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.start");
  }
  const samples = [];
  try {
    for (let i = 0; i < count; i++)
      samples.push(await threadSample(data, mount));
  } finally {
    if (profiler) {
      const { profile } = await profiler.post("Profiler.stop");
      writeFileSync(
        process.env.BUZZ_ENGINE_CPU_OUT as string,
        JSON.stringify(profile),
        { flag: "wx" },
      );
      profiler.disconnect();
    }
  }
  if (!output || !source) return;
  assert.deepEqual(provenance(), source, "source changed during measurement");
  const artifact = {
    schema: 2,
    workload,
    presentation: {
      geometry,
      readiness: "root-and-newest-virtual-window-dom-commit",
    },
    source,
    compatibility: {
      fixtureHash: data.hash,
      harnessHash: hash(
        readFileSync("src/features/relay/thread-profile-fixture.ts", "utf8") +
          readFileSync(
            "src/features/messages/ThreadPanel.profile.test.tsx",
            "utf8",
          ),
      ),
      lockHash: hash(readFileSync("pnpm-lock.yaml")),
      node: process.version,
      v8: process.versions.v8,
      os: release(),
      host: hostname(),
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      profiled: !!profiler,
    },
    capturedAt: new Date().toISOString(),
    initialLoad,
    finalLoad: loadavg(),
    warmups,
    samples,
  };
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      output,
      head: source.head,
      fingerprint: source.fingerprint,
      samples: count,
    }),
  );
}, 120_000);
