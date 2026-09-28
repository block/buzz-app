import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import { fixtureBody } from "../browser/fixture-body.mjs";

test("an incomplete client disconnect is recorded; a subsequent complete request still works", async (t) => {
  const report = { cancelledRequests: [] };
  const received = Promise.withResolvers();
  const completed = Promise.withResolvers();
  const server = createServer(async (request, response) => {
    request.once("data", received.resolve);
    try {
      const result = await fixtureBody(request, report);
      completed.resolve(result);
      if (result) response.end(JSON.stringify(result.body));
    } catch (error) {
      completed.reject(error);
      response.destroy();
    }
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write(
    'POST /api/relay/primary/query HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n[{"kinds":',
  );
  await received.promise;
  socket.destroy();
  assert.equal(await completed.promise, null);
  assert.deepEqual(report.cancelledRequests, [
    { method: "POST", url: "/api/relay/primary/query" },
  ]);
  const response = await fetch(
    `http://127.0.0.1:${port}/api/relay/primary/query`,
    {
      method: "POST",
      body: JSON.stringify([{ kinds: [0] }]),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ kinds: [0] }]);
  assert.equal(report.cancelledRequests.length, 1);
});

test("complete empty/JSON bodies parse, and malformed JSON still fails", async () => {
  const report = { cancelledRequests: [] };
  assert.deepEqual(await fixtureBody(Readable.from([]), report), {
    body: undefined,
  });
  assert.deepEqual(await fixtureBody(Readable.from(['{"ok":true}']), report), {
    body: { ok: true },
  });
  await assert.rejects(
    fixtureBody(Readable.from(['{"broken":']), report),
    SyntaxError,
  );
  assert.deepEqual(report.cancelledRequests, []);
});

for (const [code, complete] of [
  ["EIO", false],
  ["ECONNRESET", true],
]) {
  test(`does not classify ${code} with complete=${complete} as a client cancellation`, async () => {
    const report = { cancelledRequests: [] };
    const error = Object.assign(new Error("aborted"), { code });
    const request = Readable.from(
      (async function* () {
        yield "partial";
        throw error;
      })(),
    );
    request.complete = complete;
    await assert.rejects(
      fixtureBody(request, report),
      (caught) => caught === error,
    );
    assert.deepEqual(report.cancelledRequests, []);
  });
}
