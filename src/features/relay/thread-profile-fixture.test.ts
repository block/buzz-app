import { afterEach, expect, it, vi } from "vitest";
import { threadData, threadSample } from "./thread-profile-fixture";

afterEach(() => vi.restoreAllMocks());

it("keeps fixture assertion details local while returning a generic HTTP error", async () => {
  const data = threadData();
  const request = globalThis.fetch;
  let failure: { status: number; body: unknown } | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const filters = init?.body && JSON.parse(String(init.body));
    if (filters?.[0]?.ids?.[0] !== data.root.id) return request(input, init);
    // Exercise the real loopback responder's assertion failure path.
    const response = await request(input, {
      ...init,
      body: JSON.stringify([{ ids: ["private-fixture-detail"] }]),
    });
    failure = { status: response.status, body: await response.clone().json() };
    return response;
  });

  await expect(
    threadSample(data, (session, channelId, messageId) => {
      const view = session.thread(channelId, messageId);
      void view.refresh();
      return { view, async rendered() {}, dispose: () => view.dispose() };
    }),
  ).rejects.toMatchObject({
    code: "ERR_ASSERTION",
    message: expect.stringContaining("private-fixture-detail"),
    stack: expect.stringContaining("thread-profile-fixture.ts"),
  });
  expect(failure).toEqual({ status: 500, body: { error: "Request failed." } });
});
