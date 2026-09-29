import { expect, it } from "vitest";
import { reportedSend, sendReport } from "./send-boundary";
const eventId = "a".repeat(64);
const receipt = (patch = {}) =>
  JSON.stringify({
    accepted: true,
    event_id: eventId,
    message: "",
    mention_pubkeys: ["b".repeat(64)],
    ...patch,
  });
const tool = { title: "buzz-dev-mcp__shell" };
function completed(stdout: string, patch = {}) {
  return {
    status: "completed",
    rawOutput: { isError: false },
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: JSON.stringify({
            exit_code: 0,
            timed_out: false,
            stdout_truncated: false,
            stdout,
            ...patch,
          }),
        },
      },
    ],
  };
}
it("accepts real producer numeric/log stdout before the final normalized receipt without parsing command syntax", () => {
  for (const prefix of ["", "499\n", 'check complete\n{"count":499}\n']) {
    expect(reportedSend(tool, completed(`${prefix}${receipt()}\n`))).toEqual({
      messageId: eventId,
    });
    expect(
      reportedSend(
        { ...tool, rawInput: { command: "if arbitrary; then run_script; fi" } },
        completed(prefix + receipt()),
      ),
    ).toEqual({ messageId: eventId });
  }
});
it("rejects nonfinal, multiple, rejected, malformed or unsupported normalized receipts", () => {
  for (const output of [
    `${receipt()}\nmore output`,
    `${receipt()}\n${receipt()}`,
    receipt({ accepted: false }),
    receipt({ event_id: "bad" }),
    receipt({ mention_pubkeys: ["bad"] }),
    receipt({ message: null }),
    receipt({ extra: true }),
    `{"event_id":"bad"}\n${receipt()}`,
  ]) {
    expect(reportedSend(tool, completed(output))).toBe("ambiguous");
  }
  expect(reportedSend({ title: "read_history" }, completed(receipt()))).toBe(
    "ambiguous",
  );
  expect(reportedSend(tool, completed("499\n"))).toBeUndefined();
});
it("requires positive completion and nontruncated output evidence", () => {
  for (const patch of [
    { exit_code: 1 },
    { timed_out: true },
    { stdout_truncated: true },
    { exit_code: undefined },
    { timed_out: undefined },
    { stdout_truncated: undefined },
  ])
    expect(reportedSend(tool, completed(receipt(), patch))).toBe("ambiguous");
  expect(
    reportedSend(tool, { ...completed(receipt()), status: "failed" }),
  ).toBe("ambiguous");
  expect(
    reportedSend(tool, {
      ...completed(receipt()),
      rawOutput: { isError: true },
    }),
  ).toBe("ambiguous");
  expect(reportedSend(tool, { ...completed(receipt()), rawOutput: {} })).toBe(
    "ambiguous",
  );
});
it("reports exact IDs even in contradictory output to detect duplicate association", () => {
  expect(sendReport(completed(receipt({ accepted: false }))).ids).toEqual([
    eventId,
  ]);
  expect(sendReport(completed(`${receipt()}\n${receipt()}`)).ids).toEqual([
    eventId,
    eventId,
  ]);
});
it("treats malformed receipt-shaped target claims as conflict evidence, never a send", () => {
  const malformed = `{"accepted":true,"event_id":"${eventId}",`;
  expect(sendReport(completed(malformed))).toMatchObject({
    ids: [eventId],
    messageId: undefined,
    ambiguous: true,
  });
  expect(reportedSend(tool, completed(`${malformed}\n${receipt()}`))).toBe(
    "ambiguous",
  );
  expect(
    reportedSend(
      tool,
      completed(`ordinary prose about event_id ${eventId}\n${receipt()}`),
    ),
  ).toEqual({ messageId: eventId });
});

it("accepts Brad's optional audience field without loosening receipt or boundary validation", () => {
  for (const audience of ["agents", "everyone"]) {
    const completion = completed(receipt({ audience }));
    expect(sendReport(completion)).toMatchObject({
      messageId: eventId,
      reportedAudience: audience,
      ambiguous: false,
    });
    expect(reportedSend(tool, completion)).toEqual({ messageId: eventId });
    expect(
      sendReport({ ...completion, status: "failed" }).reportedAudience,
    ).toBeUndefined();
    expect(
      reportedSend(tool, completed(receipt({ audience, extra: true }))),
    ).toBe("ambiguous");
  }
  expect(sendReport(completed(receipt()))).toMatchObject({
    messageId: eventId,
    reportedAudience: undefined,
    ambiguous: false,
  });
  for (const audience of [null, "", "future", "Agents", [], {}, false]) {
    expect(sendReport(completed(receipt({ audience })))).toMatchObject({
      ids: [eventId],
      messageId: undefined,
      reportedAudience: undefined,
      ambiguous: true,
    });
  }
});

it("admits distinct trailing receipt blocks for producer-turn linkage without inventing per-response boundaries", () => {
  const other = "c".repeat(64);
  const stdout = `${receipt({ audience: "agents" })}\n${receipt({ event_id: other, audience: "everyone" })}`;
  expect(sendReport(completed(`calculated\n${stdout}`))).toMatchObject({
    ids: [eventId, other],
    messageIds: [eventId, other],
    messageId: undefined,
    ambiguous: true,
  });
  expect(reportedSend(tool, completed(stdout))).toBe("ambiguous");
  for (const output of [
    `${receipt()}\n${receipt()}`,
    `${receipt()}\n${receipt({ event_id: other, accepted: false })}`,
    `${receipt()}\n${receipt({ event_id: other, extra: true })}`,
    `${stdout}\nmore output`,
    `${receipt()}\n{"event_id":"${other}",`,
    `${receipt()}\ninterleaved log\n${receipt({ event_id: other })}`,
  ])
    expect(sendReport(completed(output)).messageIds).toEqual([]);
  for (const patch of [
    { exit_code: 1 },
    { timed_out: true },
    { stdout_truncated: true },
  ])
    expect(sendReport(completed(stdout, patch)).messageIds).toEqual([]);
});
