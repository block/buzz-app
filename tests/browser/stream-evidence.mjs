import { writeFile } from "node:fs/promises";

export async function streamEvidence({ page, app }, use, testInfo) {
  // Depend on app so capture runs before its teardown closes the page/server.
  void app;
  await observeStreamReads(page);
  try {
    await use();
  } finally {
    await captureEditEvidence(page, testInfo);
  }
}

// Diagnostic observation only: no extra reader, read, fetch, write or delivery wait.
// The app still owns the original response, reader and read promises.
// Consumption is preserved; wrapper/decoder work can still perturb timing.
async function observeStreamReads(page) {
  await page.addInitScript(() => {
    const evidence = { streams: [], errors: [] };
    window.streamReadEvidence = evidence;
    const fetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await Reflect.apply(fetch, this, args);
      if (!new URL(response.url).pathname.endsWith("/stream") || !response.body)
        return response;
      const stream = {
        at: performance.now(),
        url: response.url,
        reads: [],
        bytes: 0,
        truncated: false,
      };
      evidence.streams.push(stream);
      const body = response.body;
      const getReader = body.getReader;
      body.getReader = function (...args) {
        const reader = Reflect.apply(getReader, this, args);
        const read = reader.read;
        const decoder = new TextDecoder();
        reader.read = function (...args) {
          const pending = Reflect.apply(read, this, args);
          void pending.then(
            ({ value, done }) => {
              try {
                stream.bytes += value?.byteLength ?? 0;
                if (stream.bytes > 1024 * 1024 || stream.reads.length >= 256) {
                  stream.truncated = true;
                  return;
                }
                stream.reads.push({
                  at: performance.now(),
                  done,
                  bytes: value?.byteLength ?? 0,
                  text: decoder.decode(value, { stream: !done }),
                });
              } catch (error) {
                evidence.errors.push(String(error));
              }
            },
            (error) =>
              stream.reads.push({
                at: performance.now(),
                error: String(error),
              }),
          );
          return pending;
        };
        return reader;
      };
      return response;
    };
  });
}

async function captureEditEvidence(page, testInfo) {
  // Capture before touching diagnostics: their export must not rescue an assertion.
  // Diagnostic failures are attached, never substituted for the original test error.
  try {
    const evidence = await page.evaluate(() => ({
      ...window.streamReadEvidence,
      capturedAt: performance.now(),
      rows: [...document.querySelectorAll("[data-message-id]")].map((row) => ({
        id: row.dataset.messageId,
        text: row.textContent,
      })),
    }));
    const evidencePath = testInfo.outputPath("stream-reads-and-rows.json");
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await testInfo.attach("stream-reads-and-rows", {
      path: evidencePath,
      contentType: "application/json",
    });
    // Use the existing app export, not a new session/projection access hook.
    const [result] = await Promise.all([
      page.waitForEvent("download", { timeout: 1000 }),
      page
        .getByRole("button", {
          name: "Export timings",
          exact: true,
          includeHidden: true,
        })
        .evaluate((button) => button.click()),
    ]);
    await result.saveAs(testInfo.outputPath("edit-relay-timings.json"));
    await testInfo.attach("edit-relay-timings", {
      path: testInfo.outputPath("edit-relay-timings.json"),
      contentType: "application/json",
    });
  } catch (error) {
    await testInfo.attach("edit-evidence-error", {
      body: String(error),
      contentType: "text/plain",
    });
  }
}
