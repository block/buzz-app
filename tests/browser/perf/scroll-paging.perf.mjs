import { test, expect, repeats, timeline } from "./runner.mjs";
import { scrollCadence } from "./cadence.mjs";
import { verifyEvent } from "nostr-tools";

const count = 640;
// Each variant changes one condition of scroll-paging-fast.
for (const [name, olderPageDelayMs, modality, options] of [
  ["scroll-paging-fast", 100, "pointer", {}],
  ["scroll-paging-delayed", 500, "pointer", {}],
  ["scroll-paging-fast-keyboard", 100, "keyboard", {}],
  ["scroll-paging-fast-markdown", 100, "pointer", { markdownMessages: true }],
  ["scroll-paging-fast-first-seen", 100, "pointer", { firstSeenHistory: true }],
])
  test.describe(name, () => {
    test.use({
      historyCounts: { alpha: count, beta: 1 },
      olderPageDelayMs,
      ...options,
    });
    for (let i = 1; i <= repeats; i++)
      test(`${name} sample ${i}`, async ({ page, app, perf }) => {
        const history = structuredClone(app.histories.get("primary/alpha"));
        const eventKey = (e) =>
          JSON.stringify([
            e.id,
            e.pubkey,
            e.created_at,
            e.kind,
            e.tags,
            e.content,
            e.sig,
          ]);
        const expected = new Map(history.map((e) => [e.id, eventKey(e)]));
        const startup = {
          expectedIds: history.slice(-20).map((e) => e.id),
          responses: [],
        };
        const wire = [],
          startupReads = [];
        let nativeWheel;
        const relay = app.signRelay({
          kind: 39006,
          created_at: 0,
          tags: [],
          content: "",
        }).pubkey;
        const responseReceipt = (response) => {
          const request = response.request();
          if (
            new URL(request.url()).pathname !== "/api/relay/primary/query" ||
            request.method() !== "POST"
          )
            return;
          const matches = request
            .postDataJSON()
            .filter((f) => f.top_level && f["#h"]?.includes("alpha"));
          if (!matches.length) return;
          const filter = matches[0];
          const receipt = {
            filter,
            status: response.status(),
            matchingFilters: matches.length,
          };
          if (matches.length !== 1)
            receipt.error = "Multiple matching history filters";
          (filter.until === undefined ? startup.responses : wire).push(receipt);
          nativeWheel?.workChanged?.();
          const read = response.json().then(
            (events) => {
              receipt.events = events;
              if (!Array.isArray(events)) {
                receipt.error = "Non-array response body";
                return;
              }
              const rows = events.filter((e) => e.kind === 9),
                bounds = events.filter((e) => e.kind === 39006);
              receipt.rowsBound = rows.every(
                (e) => expected.get(e.id) === eventKey(e),
              );
              if (bounds.length === 1)
                receipt.boundContent = JSON.parse(bounds[0].content);
              receipt.boundValid =
                bounds.length === 1 &&
                JSON.stringify(bounds[0].tags) ===
                  JSON.stringify([
                    ["h", "alpha"],
                    [
                      "d",
                      `alpha:${filter.until === undefined ? "head" : `${filter.until}:${filter.before_id}`}`,
                    ],
                  ]) &&
                bounds[0].pubkey === relay &&
                verifyEvent(bounds[0]);
            },
            (error) => {
              receipt.error = String(error);
            },
          );
          read
            .then(
              () => nativeWheel?.workChanged?.(),
              (error) => {
                receipt.error = String(error);
                nativeWheel?.workChanged?.();
              },
            )
            .catch((error) => {
              receipt.error = String(error);
            });
          if (filter.until === undefined) startupReads.push(read);
        };
        const expectedRanges = Array.from({ length: 31 }, (_, i) => {
          const end = 620 - 20 * i,
            cursor = history[end];
          return {
            until: cursor.created_at,
            beforeId: cursor.id,
            limit: 20,
            ids: history.slice(end - 20, end).map((e) => e.id),
            hasMore: i < 30,
          };
        });
        if (!perf.cdp) {
          expect(name, "fast native slice only").toBe("scroll-paging-fast");
          expect(history).toHaveLength(640);
          expect(
            history.every((e) => verifyEvent(e)),
            "independent signed corpus",
          ).toBe(true);
          app.report.nativePagingStartup = startup;
          page.on("response", responseReceipt);
        }
        try {
          await perf.setup("alpha");
          if (!perf.cdp) {
            await Promise.allSettled(startupReads); // setup only; no measured network waits.
            expect(startup.responses).toHaveLength(1);
            const head = startup.responses[0],
              rows = head.events.filter((e) => e.kind === 9);
            expect(head.status).toBe(200);
            expect(head.rowsBound && head.boundValid).toBe(true);
            expect(head.filter.limit).toBe(20);
            expect(rows.map((e) => e.id)).toEqual(
              [...startup.expectedIds].reverse(),
            );
            expect(head.boundContent).toEqual({
              has_more: true,
              next_cursor: {
                created_at: history[620].created_at,
                id: history[620].id,
              },
            });
            const latest = page
              .locator(
                `${timeline("alpha")} [data-message-id="${history[639].id}"] [data-message-action-anchor]`,
              )
              .first();
            expect(await latest.isVisible(), "fixture latest at setup").toBe(
              true,
            );
            expect(
              (await latest.innerText()).replace(/\s+/g, " ").trim(),
              "source latest content",
            ).toBe(history[639].content.replace(/\s+/g, " ").trim());
          }
          const scroller = page.locator(timeline("alpha"));
          const oldestId = app.histories.get("primary/alpha")[0].id;
          const point = await perf.gutter("alpha", modality);
          await perf.settle("alpha");
          expect(app.pending, "history is not preloaded").toHaveLength(0);
          const head = app.report.queries.find(
            ({ filter }) =>
              filter.top_level &&
              filter["#h"]?.includes("alpha") &&
              filter.until === undefined,
          ).filter;
          if (!perf.cdp) expect(head.limit, "fixture head limit").toBe(20);
          const expectedOlderIds = history
            .slice(0, -(perf.cdp ? head.limit : 20))
            .map(({ id }) => id);
          // Served events are in the app's proof memo; first-seen ones verify.
          const olderRowsServedBefore = expectedOlderIds.filter((id) =>
            app.served.has(id),
          ).length;
          if (options.firstSeenHistory)
            expect(olderRowsServedBefore, "older history is first-seen").toBe(
              0,
            );
          nativeWheel = perf.cdp
            ? undefined
            : {
                point,
                modality,
                startup,
                commands: [],
                trains: [],
                oldestId,
                oldestContent: history[0].content,
                wire,
                expectedRanges,
              };
          if (nativeWheel)
            expect(olderRowsServedBefore, "ordinary proof-memo workload").toBe(
              480,
            );
          let nodeStart;
          let gestures = 0;
          let reachedOldest = false;
          const completeWork = (snapshot = true) => {
            const trains = nativeWheel.trains,
              commands = nativeWheel.commands;
            const publicPlanComplete =
              gestures > 0 &&
              gestures <= 200 &&
              trains.length === gestures &&
              commands.length === 6 * gestures &&
              trains.every(
                (train, g) =>
                  train.gesture === g &&
                  JSON.stringify(train.indices) ===
                    JSON.stringify(
                      Array.from({ length: 6 }, (_, i) => 6 * g + i),
                    ),
              ) &&
              commands.every(
                (c, i) =>
                  c.ordinal === i &&
                  c.gesture === Math.floor(i / 6) &&
                  c.status === "fulfilled" &&
                  !c.error &&
                  Number.isFinite(c.sentMs) &&
                  Number.isFinite(c.ackMs) &&
                  c.deltaX === 0 &&
                  c.deltaY === -2500 / 6 &&
                  c.plannedOffsetMs === (i % 6) * 20 &&
                  c.trainStartMs === trains[Math.floor(i / 6)].trainStartMs &&
                  c.plannedMs === c.trainStartMs + c.plannedOffsetMs,
              );
            const ranges = app.pending.map(
              ({ filter, events, queuedAt, releasedAt, releaseDelayMs }) => ({
                until: filter.until,
                beforeId: filter.before_id,
                limit: filter.limit,
                ids: events.map((e) => e.id),
                queuedAt,
                releasedAt,
                releaseDelayMs,
              }),
            );
            const fixtureComplete =
              ranges.length === 31 &&
              ranges.every((range, i) => {
                const e = expectedRanges[i];
                return (
                  range.until === e.until &&
                  range.beforeId === e.beforeId &&
                  range.limit === 20 &&
                  Number.isFinite(range.releasedAt) &&
                  Number.isFinite(range.queuedAt) &&
                  Number.isFinite(range.releaseDelayMs) &&
                  (i === 0 || range.queuedAt >= ranges[i - 1].releasedAt) &&
                  JSON.stringify([...range.ids].sort()) ===
                    JSON.stringify([...e.ids].sort())
                );
              });
            const wireComplete =
              wire.length === 31 &&
              wire.every((receipt, i) => {
                const e = expectedRanges[i];
                if (!receipt.events || receipt.error) return false;
                const rows = receipt.events.filter((e) => e.kind === 9);
                return (
                  receipt.status === 200 &&
                  receipt.rowsBound &&
                  receipt.boundValid &&
                  receipt.filter.until === e.until &&
                  receipt.filter.before_id === e.beforeId &&
                  receipt.filter.limit === 20 &&
                  JSON.stringify(rows.map((e) => e.id)) ===
                    JSON.stringify([...e.ids].reverse()) &&
                  receipt.boundContent?.has_more === e.hasMore &&
                  (e.hasMore
                    ? receipt.boundContent.next_cursor?.created_at ===
                        history[620 - 20 * i - 20].created_at &&
                      receipt.boundContent.next_cursor?.id ===
                        history[620 - 20 * i - 20].id
                    : receipt.boundContent.next_cursor === null)
                );
              });
            if (snapshot)
              nativeWheel.workAtClosure = structuredClone({
                ranges,
                wire,
                fixtureComplete,
                wireComplete,
                reachedOldest,
                olderRowsServedBefore,
              });
            nativeWheel.publicPlanComplete = publicPlanComplete;
            nativeWheel.requestedTotalDeltaY = -2500 * gestures;
            return {
              wireCount: wire.length,
              fixtureCount: ranges.length,
              releasedCount: ranges.filter((r) => Number.isFinite(r.releasedAt))
                .length,
              publicPlanComplete,
              expectedUnits: 6 * gestures,
              expectedCommands: 6 * gestures,
              declaredTrains: trains.length,
              originalWorkComplete:
                fixtureComplete &&
                wireComplete &&
                reachedOldest &&
                olderRowsServedBefore === 480,
            };
          };
          const sample = await perf.measure("alpha", {
            timeoutMs: 60_000,
            nativeWheel,
            nativeWork: completeWork,
            work: {
              modality,
              olderRowsServedBefore,
              historyCount: count,
              requestedPxPerGesture: 2500,
              ...(perf.cdp
                ? { speedPxPerSecond: 25000 }
                : {
                    nominalIntentPxPerSecond: 25000,
                    plannedTrainMs: 100,
                    nativeWheel,
                  }),
              olderResponseDelayMs: olderPageDelayMs,
            },
            act: async () => {
              // No page/idle waits between gestures: arrivals must compete with
              // scrolling and the virtualizer's pending position corrections.
              // Finish a fixed amount of history, not a fixed time that rewards stalls.
              while (
                !reachedOldest &&
                gestures < 200 &&
                !nativeWheel?.interrupted
              ) {
                if (perf.cdp)
                  await perf.cdp.send("Input.synthesizeScrollGesture", {
                    ...point,
                    xDistance: 0,
                    yDistance: 2500,
                    speed: 25000,
                    gestureSourceType: "mouse",
                    preventFling: true,
                  });
                else {
                  nodeStart ??= performance.now();
                  const trainStart = performance.now() - nodeStart;
                  const pending = [];
                  const train = {
                    gesture: gestures,
                    trainStartMs: trainStart,
                    indices: Array.from(
                      { length: 6 },
                      (_, i) => 6 * gestures + i,
                    ),
                  };
                  nativeWheel.trains.push(train);
                  try {
                    for (let step = 0; step < 6; step++) {
                      if (nativeWheel.interrupted) break;
                      const plannedMs = trainStart + step * 20;
                      const delay = plannedMs - (performance.now() - nodeStart);
                      if (delay > 0)
                        await new Promise((resolve) =>
                          setTimeout(resolve, delay),
                        );
                      if (nativeWheel.interrupted) break;
                      const command = {
                        gesture: gestures,
                        ordinal: 6 * gestures + step,
                        status: "pending",
                        trainStartMs: trainStart,
                        plannedOffsetMs: step * 20,
                        plannedMs,
                        sentMs: performance.now() - nodeStart,
                        deltaX: 0,
                        deltaY: -2500 / 6,
                      };
                      nativeWheel.commands.push(command);
                      try {
                        pending.push(
                          page.mouse.wheel(command.deltaX, command.deltaY).then(
                            () => {
                              command.ackMs = performance.now() - nodeStart;
                              command.status = "fulfilled";
                            },
                            (error) => {
                              command.error = String(error);
                              command.status = "rejected";
                            },
                          ),
                        );
                      } catch (error) {
                        command.error = String(error);
                        command.status = "rejected";
                      }
                    }
                  } finally {
                    await Promise.allSettled(pending);
                  }
                  if (nativeWheel.interrupted)
                    throw new Error(nativeWheel.interrupted);
                  expect(
                    nativeWheel.commands.filter((c) => c.error),
                    "all issued wheel promises drained",
                  ).toEqual([]);
                }
                gestures++;
                if (nativeWheel) nativeWheel.gestures = gestures;
                reachedOldest = await scroller.evaluate((element, id) => {
                  const row = element.querySelector(
                    `[data-message-id="${id}"]`,
                  );
                  if (!row) return false;
                  const box = row.getBoundingClientRect();
                  const viewport = element.getBoundingClientRect();
                  return box.bottom > viewport.top && box.top < viewport.bottom;
                }, oldestId);
              }
            },
          });
          if (perf.cdp)
            Object.assign(sample.metrics, scrollCadence(sample.recording));
          else
            sample.apparatus.unavailable.scrollCadence =
              "v2 measures operation completion; no native velocity/gesture-duration contract";
          const received = new Set(
            app.pending
              .filter(({ releaseDelayMs }) => releaseDelayMs !== undefined)
              .flatMap(({ events }) => events.map(({ id }) => id)),
          );
          Object.assign(sample.work, {
            gestures,
            wheels: sample.recording.wheels,
            olderReadsDuring: app.pending.length,
            olderReleaseDelaysMs: app.pending.map(
              ({ releaseDelayMs }) => releaseDelayMs,
            ),
            olderRowsReceived: received.size,
            reachedOldest,
            oldestId,
          });
          await perf.save(sample);
          expect(reachedOldest, "input reaches the oldest message").toBe(true);
          expect([...received], "no middle history range was skipped").toEqual(
            expect.arrayContaining(expectedOlderIds),
          );
          expect(sample.work.wheels, "real wheel input").toBeGreaterThan(0);
          expect(
            sample.work.olderReadsDuring,
            "multiple pages arrive during input",
          ).toBeGreaterThan(1);
          expect(
            sample.recording.frames.at(-1).rows.map(([id]) => id),
            "oldest message remains visible after settling",
          ).toContain(oldestId);
          await expect(
            scroller.getByText("History window limit reached", { exact: true }),
          ).toHaveCount(0);
          if (nativeWheel) {
            nativeWheel.originalWorkAssertionsPassed = true;
            for (const gate of [
              "publicPlanComplete",
              "aggregateNativeReceiptMatched",
              "originalWorkComplete",
              "observableEndpointSatisfied",
            ])
              expect(nativeWheel.receipt[gate], gate).toBe(true);
          }
        } finally {
          if (!perf.cdp) page.off("response", responseReceipt);
        }
      });
  });
