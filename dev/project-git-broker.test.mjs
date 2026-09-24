import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { getPublicKey } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { readProjectGit } from "./project-git.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";

vi.mock("./project-git.mjs", () => ({ readProjectGit: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const empty = {
  head: null,
  commits: [],
  files: [],
  readme: null,
  file: null,
  diff: null,
};
async function harness() {
  const key = new Uint8Array(32).fill(21),
    viewer = getPublicKey(key);
  let handler;
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    void handler(req, res);
  });
  await relayBrokerPlugin({
    relayUrl: "https://project.test",
    identity: () => key,
    authority: async () => ({ relayAuthor: viewer }),
  }).configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    viewer,
    post(body, headers = {}) {
      return fetch(`${base}/api/relay/project-git`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
it("passes real broker admission and JSON into the advertised client Git capability", async () => {
  const h = await harness();
  readProjectGit.mockResolvedValue(empty);
  try {
    const transport = await connectBrokerTransport(h.base);
    expect(
      await transport.projectGit.read(
        { owner: h.viewer, dtag: "repo" },
        new AbortController().signal,
      ),
    ).toEqual(empty);
    const call = readProjectGit.mock.calls[0][0];
    expect(call.input).toEqual({ owner: h.viewer, dtag: "repo" });
    expect(call.relay).toBe("https://project.test");
    expect(getPublicKey(call.key)).toBe(h.viewer);
  } finally {
    await h.close();
  }
});
it("rejects arbitrary targets and untrusted origins before dispatch, and sanitizes Git failures", async () => {
  const h = await harness();
  try {
    const input = { owner: h.viewer, dtag: "repo" };
    expect(
      (await h.post({ ...input, url: "https://elsewhere.test" })).status,
    ).toBe(400);
    expect(
      (await h.post(input, { Origin: "https://elsewhere.test" })).status,
    ).toBe(403);
    expect(readProjectGit).not.toHaveBeenCalled();
    readProjectGit.mockRejectedValue(new Error("private process diagnostics"));
    const result = await h.post(input);
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      error: "Repository content could not be read",
    });
  } finally {
    await h.close();
  }
});
