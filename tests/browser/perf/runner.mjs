import { test as base, expect } from "../fixture.mjs";
import { openPage } from "../navigation.mjs";
import { settle, virtuaIdle } from "../timeline.mjs";
import { loafBlocking } from "./blocking.mjs";
import { channelWork } from "./channel-work.mjs";

export { expect };
export const timeline = (id) => `section[data-channel-timeline="${id}"]`;
export const sidebar = (id) => `button[data-channel-id="${id}"]`;
export const repeats = Number(process.env.PERF_REPEAT ?? 1);
export const heads = (app, id) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter?.["#h"]?.includes(id) &&
      filter.top_level &&
      filter.until === undefined,
  ).length;

// One observer per operation, owned by its JSHandle. No global recorder or
// surviving animation-frame loop. Geometry reads are included in browser costs.
function observe({
  selector,
  ids,
  click,
  hoverMs,
  timeoutMs,
  chromium,
  channel,
  latestId,
  nativeWheel,
}) {
  const lifetime = channel ? window.__perfChannelWork : undefined;
  // Chromium hover remains before recording; its allowed preparation starts here.
  let trigger =
    lifetime && chromium && hoverMs ? ++lifetime.sequence : undefined;
  const allowed = new Set(ids);
  const frames = [];
  const inputs = [];
  let clickFrame;
  const inputTypes = [
    "pointerover",
    "pointerdown",
    "pointerup",
    "click",
    "focus",
  ];
  const input = (event) => {
    if (start === undefined || end !== undefined) return;
    const button = event.target.closest("button");
    if (event.type === "click" && click && event.target.closest(click))
      clickFrame = frames.length;
    inputs.push({
      type: event.type,
      frameCount: frames.length,
      t: performance.now() - start,
      eventMs: event.timeStamp - start,
      trusted: event.isTrusted,
      target: click ? !!event.target.closest(click) : undefined,
      channel: button?.dataset.channelId,
      label: button?.getAttribute("aria-label") ?? button?.textContent,
    });
  };
  if (!chromium)
    for (const type of inputTypes) document.addEventListener(type, input, true);
  // Native policy v2 is opt-in; Chromium keeps its original observer/endpoint.
  const nativeEvents = [],
    pendingCancellation = [];
  const nativeElement = nativeWheel
    ? document.querySelector(selector)
    : undefined;
  let nativeAdmission,
    nativeWorkVersion = 0,
    nativeRequests = 0;
  const nativeWorkUpdates = [],
    nativeTransitions = [];
  const savedFetch = window.fetch;
  const nativeFetch = function (...args) {
    const url = new URL(args[0]?.url ?? args[0], location.href);
    if (url.pathname === "/api/relay/primary/query") {
      const filters =
        typeof args[1]?.body === "string" ? JSON.parse(args[1].body) : [];
      for (const filter of filters)
        if (filter.top_level && filter["#h"]?.includes("alpha")) {
          const expected = nativeWheel.expectedRanges[nativeRequests++];
          ++nativeVersion;
          if (
            !expected ||
            filter.until !== expected.until ||
            filter.before_id !== expected.beforeId ||
            filter.limit !== 20
          )
            nativeReceipt.invalid.push({
              reason: "unexpected history request",
              filter,
            });
        }
    }
    return Reflect.apply(savedFetch, this, args);
  };
  if (nativeWheel) window.fetch = nativeFetch;
  let nativeClosure,
    nativeVersion = 0,
    movementVersion = 0,
    lastWheelVersion = 0;
  let observedTop = nativeElement?.scrollTop,
    movementObserved = false,
    lastEnd;
  let nativeStableKey, nativeStableSince, nativeStableFrame;
  const nativeReceipt = {
    publicPlanComplete: false,
    aggregateNativeReceiptMatched: false,
    originalWorkComplete: false,
    observableEndpointSatisfied: false,
    units: 0,
    capturedDeltaY: 0,
    capturedWheels: 0,
    invalid: [],
    endpointPolicy: "main-webkit-wheel-fast-v2",
  };
  const moved = (top) => {
    if (top !== observedTop) {
      movementObserved = true;
      movementVersion = ++nativeVersion;
      observedTop = top;
    }
  };
  const nativeInput = (event) => {
    if (start === undefined || end !== undefined) return;
    const element = document.querySelector(selector);
    const target =
      event.type === "wheel"
        ? event.composedPath().includes(nativeElement)
        : event.target === nativeElement;
    const receipt = {
      sequence: nativeEvents.length,
      type: event.type,
      t: performance.now() - start,
      eventMs: event.timeStamp - start,
      frameCount: frames.length,
      trusted: event.isTrusted,
      target,
      path: event
        .composedPath()
        .map((e) => e.tagName ?? e.nodeName ?? "window"),
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      x: event.clientX,
      y: event.clientY,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      buttons: event.buttons,
      cancelable: event.cancelable,
      defaultPreventedAtCapture: event.defaultPrevented,
      keyboard: document.documentElement.hasAttribute(
        "data-keyboard-navigation",
      ),
      listFocused: !!element?.contains(document.activeElement),
      top: element?.scrollTop,
      height: element?.scrollHeight,
      viewport: element?.clientHeight,
    };
    nativeEvents.push(receipt);
    if (target) moved(receipt.top);
    if (event.type === "wheel") {
      lastWheelVersion = ++nativeVersion;
      if (target) {
        wheels++;
        gestureStartMs ??= performance.now() - start;
      }
      nativeReceipt.capturedWheels++;
      nativeReceipt.capturedDeltaY += event.deltaY;
      const integral =
        Number.isInteger(event.deltaY) &&
        event.deltaY < 0 &&
        -event.deltaY % 416 === 0;
      if (integral) nativeReceipt.units += -event.deltaY / 416;
      receipt.valid = !!(
        integral &&
        event.deltaX === 0 &&
        event.deltaMode === 0 &&
        event.isTrusted &&
        target &&
        element === nativeElement &&
        event.clientX === nativeWheel.point.x &&
        event.clientY === nativeWheel.point.y &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.buttons === 0 &&
        receipt.keyboard === (nativeWheel.modality === "keyboard") &&
        receipt.listFocused === (nativeWheel.modality === "pointer")
      );
      if (!receipt.valid)
        nativeReceipt.invalid.push({
          sequence: receipt.sequence,
          reason: "invalid native wheel",
        });
      pendingCancellation.push({ event, receipt });
    } else if (target) {
      ++nativeVersion;
      if (event.type === "scrollend" && event.isTrusted)
        lastEnd = {
          version: nativeVersion,
          sequence: receipt.sequence,
          top: receipt.top,
          t: receipt.t,
        };
    }
  };
  if (nativeWheel)
    for (const type of ["wheel", "scroll", "scrollend"])
      document.addEventListener(type, nativeInput, {
        capture: true,
        passive: true,
      });
  function nativeSample(element, frame, signature, now) {
    // This rAF runs after the input dispatch task, including later listeners.
    for (const { event, receipt } of pendingCancellation.splice(0)) {
      receipt.defaultPrevented = event.defaultPrevented;
      receipt.cancellationCheckedFrame = frames.length;
      receipt.phaseAtCheck = event.eventPhase;
      if (event.eventPhase !== Event.NONE || event.defaultPrevented)
        nativeReceipt.invalid.push({
          sequence: receipt.sequence,
          reason: "native default cancelled or dispatch unfinished",
        });
    }
    if (
      element !== nativeElement &&
      !nativeReceipt.invalid.some((e) => e.reason === "target replaced")
    )
      nativeReceipt.invalid.push({ reason: "target replaced" });
    moved(frame.top);
    if (!nativeClosure) {
      frame.native = {
        units: nativeReceipt.units,
        requests: nativeRequests,
        publicPlanComplete: false,
        aggregateNativeReceiptMatched: false,
        originalWorkComplete: false,
        observableEndpointSatisfied: false,
      };
      return;
    }
    const total = nativeClosure.expectedUnits;
    if (
      nativeReceipt.units > total &&
      !nativeReceipt.invalid.some((e) => e.reason === "extra native mass")
    )
      nativeReceipt.invalid.push({ reason: "extra native mass" });
    nativeReceipt.publicPlanComplete =
      nativeClosure.publicPlanComplete === true;
    nativeReceipt.aggregateNativeReceiptMatched = !!(
      nativeReceipt.publicPlanComplete &&
      nativeReceipt.units === total &&
      nativeReceipt.capturedWheels > 0 &&
      !pendingCancellation.length &&
      !nativeReceipt.invalid.length &&
      nativeEvents
        .filter((e) => e.type === "wheel")
        .every((e) => e.cancellationCheckedFrame !== undefined)
    );
    const oldest = element?.querySelector(
      `[data-message-id="${nativeWheel.oldestId}"]`,
    );
    const body = oldest?.querySelector("[data-message-action-anchor]");
    const b = element?.getBoundingClientRect(),
      rect = body?.getBoundingClientRect();
    const bodyVisible = !!(
      body?.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      }) &&
      Math.min(rect.right, b.right, innerWidth) -
        Math.max(rect.left, b.left, 0) >
        0 &&
      Math.min(rect.bottom, b.bottom, innerHeight) -
        Math.max(rect.top, b.top, 0) >
        0
    );
    const content = body?.innerText.replace(/\s+/g, " ").trim();
    nativeReceipt.originalWorkComplete = !!(
      (nativeAdmission ?? nativeClosure).originalWorkComplete &&
      element?.contains(
        document.elementFromPoint(nativeWheel.point.x, nativeWheel.point.y),
      ) &&
      nativeRequests === 31 &&
      frame.rows.some(([id]) => id === nativeWheel.oldestId) &&
      bodyVisible &&
      content === nativeWheel.oldestContent.replace(/\s+/g, " ").trim() &&
      !element?.textContent.includes("History window limit reached")
    );
    const endedMovement = !!(
      lastEnd &&
      movementObserved &&
      lastEnd.version >= movementVersion
    );
    const movingEnd = endedMovement && lastEnd.version > lastWheelVersion;
    const suffix =
      endedMovement &&
      lastEnd.top === 0 &&
      frame.top === 0 &&
      nativeEvents
        .filter((e) => e.type === "wheel" && e.sequence > lastEnd.sequence)
        .every((e) => e.top === 0 && e.deltaY < 0);
    nativeReceipt.terminal = movingEnd
      ? { kind: "moving-ending", end: lastEnd }
      : suffix
        ? { kind: "clamped-suffix", end: lastEnd }
        : undefined;
    nativeReceipt.lastWheelVersion = lastWheelVersion;
    nativeReceipt.movementVersion = movementVersion;
    // Query completion and current geometry rearm/revalidate the same live loop.
    const queryEpoch = nativeWorkVersion;
    const ready =
      nativeReceipt.publicPlanComplete &&
      nativeReceipt.aggregateNativeReceiptMatched &&
      nativeReceipt.originalWorkComplete &&
      !!nativeReceipt.terminal;
    const key = JSON.stringify([
      signature,
      [
        b?.left,
        b?.top,
        b?.width,
        b?.height,
        element?.clientWidth,
        element?.clientHeight,
      ],
      nativeVersion,
      queryEpoch,
      nativeRequests,
      ready,
    ]);
    if (key !== nativeStableKey)
      nativeTransitions.push({
        t: now - start,
        frame: frames.length,
        activity: nativeVersion,
        workVersion: nativeWorkVersion,
        requests: nativeRequests,
        ready,
        units: nativeReceipt.units,
        terminal: nativeReceipt.terminal?.kind,
      });
    if (!ready || key !== nativeStableKey) {
      nativeStableSince = ready ? now : undefined;
      nativeStableFrame = frames.length;
    }
    nativeStableKey = key;
    nativeReceipt.stability = {
      sinceMs:
        nativeStableSince === undefined ? undefined : nativeStableSince - start,
      frame: nativeStableFrame,
      frameCount: frames.length,
      queryEpoch,
      activity: nativeVersion,
      ready,
    };
    frame.native = {
      ...nativeReceipt.stability,
      units: nativeReceipt.units,
      requests: nativeRequests,
      workVersion: nativeWorkVersion,
      publicPlanComplete: nativeReceipt.publicPlanComplete,
      aggregateNativeReceiptMatched:
        nativeReceipt.aggregateNativeReceiptMatched,
      originalWorkComplete: nativeReceipt.originalWorkComplete,
      observableEndpointSatisfied: false,
      terminal: nativeReceipt.terminal?.kind,
      endSequence: lastEnd?.sequence,
    };
    if (nativeReceipt.invalid.length) {
      stop("Invalid native wheel receipt");
      return;
    }
    if (
      ready &&
      now - nativeStableSince >= 200 &&
      frames.length - nativeStableFrame >= 2
    ) {
      nativeReceipt.observableEndpointSatisfied = true;
      frame.native.observableEndpointSatisfied = true;
      stop();
    }
  }

  const longAnimationFrames = [];
  let start,
    end,
    done = false,
    firstRowsMs,
    previous,
    quietSince,
    raf,
    timer,
    resolve;
  let loafObserver, drainRaf, drainTimer;
  const collect = (entries) => {
    for (const entry of entries)
      longAnimationFrames.push({
        startMs: entry.startTime - start,
        durationMs: entry.duration,
        blockingDurationMs: entry.blockingDuration,
      });
  };
  let wheels = 0;
  let inputAt, hoverAt;
  let gestureStartMs, gestureEndMs;
  const hovered = (event) => {
    if (hoverMs && event.target.closest(click)) hoverAt ??= performance.now();
  };
  const clicked = (event) => {
    if (click && event.target.closest(click)) inputAt = performance.now();
  };
  const result = new Promise((r) => {
    resolve = r;
  });
  const wheel = (event) => {
    if (event.target.closest(selector)) {
      wheels++;
      gestureStartMs ??= performance.now() - start;
    }
  };
  if (!nativeWheel)
    document.addEventListener("wheel", wheel, { passive: true });
  document.addEventListener("click", clicked, true);
  document.addEventListener("pointerover", hovered, true);
  function stop(error) {
    if (end !== undefined) return;
    end = performance.now();
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    if (!nativeWheel) document.removeEventListener("wheel", wheel);
    document.removeEventListener("click", clicked, true);
    document.removeEventListener("pointerover", hovered, true);
    if (!chromium)
      for (const type of inputTypes)
        document.removeEventListener(type, input, true);
    if (nativeWheel) {
      if (window.fetch === nativeFetch) window.fetch = savedFetch;
      if (error) nativeReceipt.observableEndpointSatisfied = false;
      nativeReceipt.unobservedCancellationAtStop = pendingCancellation.length;
      if (pendingCancellation.length || nativeReceipt.invalid.length)
        nativeReceipt.aggregateNativeReceiptMatched = false;
      for (const type of ["wheel", "scroll", "scrollend"])
        document.removeEventListener(type, nativeInput, true);
      for (const entry of pendingCancellation)
        entry.receipt.cancellationUnobserved = true;
      pendingCancellation.length = 0;
    }
    resolve({
      error,
      ...(nativeWheel
        ? {
            nativeEvents,
            nativeReceipt: {
              ...nativeReceipt,
              closure: nativeClosure,
              error,
              pendingCancellation: nativeReceipt.unobservedCancellationAtStop,
              workUpdates: nativeWorkUpdates,
              transitions: nativeTransitions,
              requests: nativeRequests,
            },
          }
        : {}),
      ...(lifetime
        ? {
            channelWork: {
              trigger,
              end: ++lifetime.sequence,
              history: lifetime.history
                .filter((e) => e.channel === channel)
                .map((e) => ({ ...e })),
              latest: (() => {
                const row = document.querySelector(
                  `${selector} [data-message-id="${latestId}"]`,
                );
                const body = row?.querySelector("[data-message-action-anchor]");
                const a = row?.getBoundingClientRect(),
                  b = document.querySelector(selector)?.getBoundingClientRect();
                return {
                  id: row?.dataset.messageId,
                  text: body?.innerText,
                  bodyVisible: (() => {
                    const r = body?.getBoundingClientRect();
                    return !!(
                      body?.checkVisibility({
                        opacityProperty: true,
                        visibilityProperty: true,
                      }) &&
                      Math.min(r.right, b.right, innerWidth) -
                        Math.max(r.left, b.left, 0) >
                        0 &&
                      Math.min(r.bottom, b.bottom, innerHeight) -
                        Math.max(r.top, b.top, 0) >
                        0
                    );
                  })(),
                  selected: document
                    .querySelector(`button[data-channel-id="${channel}"]`)
                    ?.getAttribute("aria-current"),
                  composer: [
                    ...document.querySelectorAll(
                      "[contenteditable=true][role=textbox]",
                    ),
                  ]
                    .filter((e) => e.checkVisibility())
                    .map((e) => e.getAttribute("aria-label")),
                  visible: !!(
                    row?.checkVisibility({
                      opacityProperty: true,
                      visibilityProperty: true,
                    }) &&
                    a.bottom > b.top &&
                    a.top < b.bottom &&
                    a.right > b.left &&
                    a.left < b.right
                  ),
                  semantics: body
                    ? {
                        blockquote: body.querySelectorAll("blockquote").length,
                        em: body.querySelectorAll("em").length,
                        strong: body.querySelectorAll("strong").length,
                        delete: body.querySelectorAll("del").length,
                      }
                    : {},
                };
              })(),
              stopSnapshotMs: performance.now() - end,
            },
          }
        : {}),
      ...(!chromium
        ? {
            inputs,
            supportedEntryTypes: PerformanceObserver.supportedEntryTypes,
          }
        : {}),
      frames,
      wheels,
      gestureStartMs,
      gestureEndMs,
      firstRowsMs,
      hoverLeadMs:
        hoverAt === undefined || inputAt === undefined
          ? undefined
          : inputAt - hoverAt,
      inputDelayMs: inputAt === undefined ? undefined : inputAt - start,
      durationMs: end - start,
    });
  }
  function sample() {
    const now = performance.now();
    const element = document.querySelector(selector);
    const bounds = element?.getBoundingClientRect();
    const rows = element
      ? [...element.querySelectorAll("[data-message-id]")].flatMap((row) => {
          if (
            !allowed.has(row.dataset.messageId) ||
            !row.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            })
          )
            return [];
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom
            ? [[row.dataset.messageId, rect.y, rect.height]]
            : [];
        })
      : [];
    const frame = {
      t: now - start,
      top: element?.scrollTop ?? null,
      height: element?.scrollHeight ?? null,
      rows,
    };
    frames.push(frame);
    // rAF is before paint: require visible rows in two successive rendering
    // updates, providing a paint opportunity, not proof of compositor pixels.
    if (
      firstRowsMs === undefined &&
      rows.length &&
      frames.at(-2)?.rows.length &&
      (!click ||
        (inputAt !== undefined &&
          (chromium || frames.length >= clickFrame + 2)))
    )
      firstRowsMs = now - (inputAt ?? start);
    const signature = JSON.stringify([frame.top, frame.height, rows]);
    if (signature !== previous || !rows.length) quietSince = now;
    previous = signature;
    if (nativeWheel) {
      nativeSample(element, frame, signature, now);
      if (end === undefined) raf = requestAnimationFrame(sample);
    } else if (
      done &&
      firstRowsMs !== undefined &&
      now - quietSince >= 200 &&
      frames.length >= 3
    )
      stop();
    else raf = requestAnimationFrame(sample);
  }
  return {
    waitForHover() {
      if (hoverAt === undefined)
        throw new Error("Hover did not reach the target");
      return new Promise((r) =>
        setTimeout(
          r,
          Math.ceil(Math.max(0, hoverMs - (performance.now() - hoverAt))),
        ),
      );
    },
    start() {
      if (
        chromium &&
        !PerformanceObserver.supportedEntryTypes.includes(
          "long-animation-frame",
        )
      )
        throw new Error(
          "Chromium does not support long-animation-frame entries",
        );
      start = performance.now();
      if (lifetime) trigger ??= ++lifetime.sequence;
      if (chromium) {
        loafObserver = new PerformanceObserver((list) =>
          collect(list.getEntries()),
        );
        loafObserver.observe({ type: "long-animation-frame", buffered: false });
      }
      quietSince = start;
      timer = setTimeout(
        () => stop(`Timeline did not settle within ${timeoutMs}ms`),
        timeoutMs,
      );
      raf = requestAnimationFrame(sample);
    },
    work(admission) {
      if (end !== undefined || admission.version <= nativeWorkVersion) return;
      nativeWorkVersion = admission.version;
      nativeAdmission = admission;
      nativeWorkUpdates.push({
        ...admission,
        t: start === undefined ? undefined : performance.now() - start,
        frameCount: frames.length,
      });
    },
    done(submission) {
      if (nativeWheel)
        nativeClosure = {
          ...submission,
          t: performance.now() - start,
          frameCount: frames.length,
        };
      // The scrolling action resolves after Chromium's synthetic gesture does.
      // This existing browser marker includes the completion protocol dispatch.
      if (gestureStartMs !== undefined && !nativeWheel)
        gestureEndMs = performance.now() - start;
      done = true;
    },
    result: () => result,
    async longFrames() {
      if (!loafObserver) return undefined;
      // stop() runs inside rAF, before Chromium finalizes that frame's entry.
      // Allow two rendering opportunities plus a task for presentation-delayed
      // delivery, outside the pinned duration and CDP counters. This is bounded,
      // not an acknowledgement of compositor presentation (see performance.md).
      await new Promise((r) => {
        drainRaf = requestAnimationFrame(() => {
          drainRaf = requestAnimationFrame(() => {
            drainTimer = setTimeout(r, 0);
          });
        });
      });
      collect(loafObserver.takeRecords());
      loafObserver.disconnect();
      return longAnimationFrames.filter(
        (entry) =>
          entry.startMs < end - start && entry.startMs + entry.durationMs > 0,
      );
    },
    stop() {
      stop("Measurement interrupted");
      cancelAnimationFrame(drainRaf);
      clearTimeout(drainTimer);
      loafObserver?.disconnect();
    },
  };
}

const counters = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};
export const test = base.extend({
  channelWork: [false, { option: true }],
  perf: async (
    { page, app, browserName, channelWork: enabled },
    use,
    testInfo,
  ) => {
    const workOracle = enabled ? await channelWork(page, app) : undefined;
    const cdp =
      browserName === "chromium"
        ? await page.context().newCDPSession(page)
        : undefined;
    if (!cdp && Number(process.env.PERF_CPU ?? 1) !== 1)
      throw new Error(
        "WebKit measurements require CPU1; no slowdown control exists",
      );
    if (cdp) await cdp.send("Performance.enable");
    const read = async () => {
      if (!cdp) return {};
      const { metrics } = await cdp.send("Performance.getMetrics");
      return Object.fromEntries(
        Object.entries(counters).map(([key, name]) => {
          const value = metrics.find((m) => m.name === name)?.value;
          if (!Number.isFinite(value))
            throw new Error(`Missing browser counter ${name}`);
          return [key, value * 1000];
        }),
      );
    };
    const perf = {
      cdp,
      async setup(id) {
        await page.goto(app.origin);
        await openPage(page, "Messages");
        await page.evaluate(async () => {
          await Promise.all([...document.fonts].map((font) => font.load()));
        });
        await perf.open(id);
      },
      async open(id) {
        await page.locator(sidebar(id)).evaluate((row) => row.click());
        await expect(
          page.locator(`${timeline(id)} [data-message-id]`).first(),
        ).toBeVisible();
        await virtuaIdle(page, page.locator(timeline(id)));
      },
      // Wheel input uses the timeline gutter, avoiding message hover. Pointer
      // modality ends setup with a real press there, which focuses the list as
      // clicking into a conversation does. Keyboard modality keeps the palette's
      // arrow-key state, with focus outside the list.
      async gutter(id, modality) {
        const scroller = page.locator(timeline(id));
        const point = await scroller.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const list = element.querySelector("ol").getBoundingClientRect();
          return {
            x: Math.round((box.left + list.left) / 2),
            y: Math.round(box.top + box.height / 2),
          };
        });
        if (!cdp) {
          await page.mouse.move(point.x, point.y);
          if (modality === "pointer") await page.mouse.click(point.x, point.y);
        } else
          for (const type of modality === "pointer"
            ? ["mouseMoved", "mousePressed", "mouseReleased"]
            : ["mouseMoved"])
            await cdp.send("Input.dispatchMouseEvent", {
              type,
              ...point,
              button: type === "mouseMoved" ? "none" : "left",
              clickCount: 1,
            });
        expect(
          await scroller.evaluate(
            (element, { x, y }) => ({
              inside: element.contains(document.elementFromPoint(x, y)),
              keyboard: document.documentElement.hasAttribute(
                "data-keyboard-navigation",
              ),
              listFocused: element.contains(document.activeElement),
            }),
            point,
          ),
          `pointer inside the timeline, ${modality} modality`,
        ).toEqual({
          inside: true,
          keyboard: modality === "keyboard",
          listFocused: modality === "pointer",
        });
        return point;
      },
      async measure(
        id,
        {
          click,
          hoverMs = 0,
          act,
          work = {},
          timeoutMs = 10_000,
          nativeWheel,
          nativeWork,
        },
      ) {
        const ids = app.histories.get(`primary/${id}`).map((event) => event.id);
        const box = click ? await page.locator(click).boundingBox() : null;
        if (click && !box) throw new Error(`Missing click target: ${click}`);
        const point = box
          ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          : null;
        let observer,
          recording,
          workLive = true,
          workVersion = 0,
          workKey;
        let workUpdates = Promise.resolve();
        const sample = {
          state: app.report.state,
          work,
          metrics: {},
          apparatus: {
            version: nativeWheel
              ? "main-webkit-wheel-fast-v2"
              : "main-webkit-stage-a-work-oracle-v2",
            browser: browserName,
            browserVersion: page.context().browser().version(),
            inputPolicy: nativeWheel
              ? "webkit-public-wheel-planned-v1"
              : click
                ? cdp
                  ? "chromium-cdp-channel-original"
                  : "playwright-native-channel-v1"
                : "scenario-owned-action-unchanged",
            unavailable: cdp
              ? {}
              : {
                  scriptMs: "No WebKit Performance.getMetrics counter",
                  layoutMs: "No WebKit Performance.getMetrics counter",
                  styleMs: "No WebKit Performance.getMetrics counter",
                  taskMs: "No WebKit Performance.getMetrics counter",
                  loafBlockingMs:
                    "No supported WebKit long-animation-frame instrumentation",
                  cpuThrottle: "WebKit has no CPU slowdown control; CPU1 only",
                },
          },
        };
        try {
          if (cdp)
            await cdp.send("Emulation.setCPUThrottlingRate", {
              rate: Number(process.env.PERF_CPU ?? 1),
            });
          observer = await page.evaluateHandle(observe, {
            selector: timeline(id),
            ids,
            click,
            hoverMs,
            timeoutMs,
            chromium: !!cdp,
            channel: click && enabled ? id : undefined,
            latestId: workOracle?.latest(id),
            nativeWheel: nativeWheel
              ? {
                  point: nativeWheel.point,
                  modality: nativeWheel.modality,
                  oldestId: nativeWheel.oldestId,
                  oldestContent: nativeWheel.oldestContent,
                  expectedRanges: nativeWheel.expectedRanges,
                }
              : undefined,
          });
          if (nativeWheel) {
            if (browserName !== "webkit" || process.platform !== "linux")
              throw new Error("Native fast policy requires Linux WebKit CPU1");
            nativeWheel.workChanged = () => {
              if (!workLive) return;
              let admission;
              try {
                admission = nativeWork(false);
              } catch (error) {
                nativeWheel.workErrors ??= [];
                nativeWheel.workErrors.push(String(error));
                admission = { originalWorkComplete: false };
              }
              const key = JSON.stringify([
                admission.originalWorkComplete,
                admission.wireCount,
                admission.fixtureCount,
                admission.releasedCount,
              ]);
              if (key === workKey) return;
              workKey = key;
              const payload = {
                originalWorkComplete: admission.originalWorkComplete,
                version: ++workVersion,
                wireCount: admission.wireCount,
                fixtureCount: admission.fixtureCount,
                releasedCount: admission.releasedCount,
              };
              workUpdates = workUpdates
                .then(() =>
                  workLive
                    ? observer.evaluate((o, p) => o.work(p), payload)
                    : undefined,
                )
                .catch((error) => {
                  nativeWheel.workUpdateErrors ??= [];
                  nativeWheel.workUpdateErrors.push(String(error));
                });
            };
          }
          if (hoverMs && cdp) {
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...point,
            });
            await observer.evaluate((o) => o.waitForHover());
          }
          if (click) {
            sample.work.headReadsBefore = heads(app, id);
            if (!cdp) {
              sample.work.targetBefore = await page
                .locator(click)
                .evaluate((element) => ({
                  hovered: element.matches(":hover"),
                  focused: element.contains(document.activeElement),
                }));
              expect(sample.work.targetBefore).toEqual({
                hovered: false,
                focused: false,
              });
              expect(sample.work.headReadsBefore).toBe(0);
            }
          }
          const before = await read();
          await observer.evaluate((o) => o.start());
          if (click && !cdp) {
            // Public mouse.click moves first: keep preparation and hover inside
            // total duration. firstRows remains relative to the actual click.
            if (hoverMs) {
              await page.mouse.move(point.x, point.y);
              await observer.evaluate((o) => o.waitForHover());
            }
            await page.mouse.click(point.x, point.y);
          } else if (click) {
            // Browser input counts synchronous handlers in ScriptDuration.
            // evaluate(() => element.click()) does not. Only the hover case
            // moves the pointer first; cold preparation starts in this window.
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              ...point,
              button: "left",
              clickCount: 1,
            });
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              ...point,
              button: "left",
              clickCount: 1,
            });
          }
          const nativeResult = nativeWheel
            ? observer
                .evaluate((o) => o.result())
                .then((result) => {
                  if (result.error) nativeWheel.interrupted = result.error;
                  return result;
                })
            : undefined;
          if (act) {
            const action = act();
            if (nativeWheel)
              await Promise.race([
                action,
                nativeResult.then((result) => {
                  if (result.error) throw new Error(result.error);
                }),
              ]);
            else await action;
          }
          const closure = nativeWheel ? nativeWork() : undefined;
          if (nativeWheel) {
            nativeWheel.closure = closure;
            nativeWheel.workChanged();
          }
          await observer.evaluate((o, closure) => o.done(closure), closure);
          recording = nativeResult
            ? await nativeResult
            : await observer.evaluate((o) => o.result());
          const after = await read();
          if (cdp)
            recording.longAnimationFrames = await observer.evaluate((o) =>
              o.longFrames(),
            );
          for (const key of Object.keys(before)) {
            sample.metrics[key] = after[key] - before[key];
            expect(sample.metrics[key], key).toBeGreaterThanOrEqual(0);
          }
          sample.recording = recording;
          if (nativeWheel) nativeWheel.receipt = recording.nativeReceipt;
          sample.metrics.durationMs = recording.durationMs;
          if (cdp) sample.metrics.loafBlockingMs = loafBlocking(recording);
          if (click) {
            sample.metrics.firstRowsMs = recording.firstRowsMs;
            sample.work.headReadsDuring =
              heads(app, id) - sample.work.headReadsBefore;
          }
          if (click && !cdp) {
            const presses = recording.inputs.filter(({ type }) =>
              ["pointerdown", "pointerup", "click"].includes(type),
            );
            expect(presses.map(({ type }) => type)).toEqual([
              "pointerdown",
              "pointerup",
              "click",
            ]);
            expect(presses.every(({ target }) => target)).toBe(true);
            const targetInputs = recording.inputs.filter(
              ({ target }) => target,
            );
            expect(targetInputs.every(({ trusted }) => trusted)).toBe(true);
            expect(
              targetInputs.some(({ type }) => type === "pointerover"),
            ).toBe(true);
          }
          expect(recording.error).toBeUndefined();
          if (click && workOracle) {
            sample.work.channel = workOracle.receipt(id, recording.channelWork);
            workOracle.check(sample.work.channel);
          }
          return sample;
        } finally {
          if (nativeWheel) {
            workLive = false;
            nativeWheel.workChanged = undefined;
          }
          if (observer) {
            if (nativeWheel) await workUpdates;
            await observer.evaluate((o) => o.stop());
            sample.recording ??= await observer.evaluate((o) => o.result());
            if (nativeWheel) {
              nativeWheel.receipt = sample.recording.nativeReceipt;
              if (sample.recording.error)
                nativeWheel.failureSnapshot = structuredClone({
                  trains: nativeWheel.trains,
                  commands: nativeWheel.commands,
                  wire: nativeWheel.wire,
                });
            }
            await observer.dispose();
          }
          if (cdp)
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          if (click && workOracle && !sample.work.channel)
            sample.work.channel = workOracle.receipt(
              id,
              sample.recording?.channelWork,
            );
          // The scenario may add work assertions afterwards. Reporter includes
          // this sample in summaries only if the whole test/fixture passed.
          app.report.measurements.push(sample);
        }
      },
      async save(sample) {
        await testInfo.attach("perf-sample", {
          body: JSON.stringify(sample),
          contentType: "application/json",
        });
      },
      settle: (id) => settle(page, page.locator(timeline(id))),
    };
    try {
      await use(perf);
    } finally {
      if (cdp) await cdp.detach();
    }
  },
});
