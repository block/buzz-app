import { isMessageAudience } from "../../features/relay/message-audience";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
function parse(value: unknown): ObjectValue | undefined {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return;
  }
}
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** The CLI prints a normalized submission receipt as its final stdout line.
 * Earlier stdout can contain command/check output. Shell syntax is not evidence
 * of a publication, so never interpret rawInput.command to match a response.
 * These are tool reports, not proof of execution or authorization. */
export function sendReport(completion: ObjectValue) {
  const content = Array.isArray(completion.content) ? completion.content : [];
  const blocks = content
    .map((part) => object(object(part)?.content))
    .filter((part) => part?.type === "text");
  const output = blocks.length === 1 ? parse(blocks[0]?.text) : undefined;
  const lines =
    typeof output?.stdout === "string"
      ? output.stdout
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.trim())
      : [];
  // Malformed receipt-like lines are only negative evidence. Never promote a
  // regex match to a send, but do not overlook a conflicting target in one.
  const malformed = lines.filter(
    (line) =>
      !parse(line) &&
      /^\s*\{/.test(line) &&
      /"(?:accepted|event_id)"\s*:/.test(line),
  );
  const malformedIds = malformed.flatMap((line) =>
    [...line.matchAll(/"event_id"\s*:\s*"([0-9a-f]{64})"/g)].map(
      (match) => match[1] ?? "",
    ),
  );
  const reports = lines
    .map((line, index) => ({ value: parse(line), index }))
    .filter(
      ({ value }) => value && ("event_id" in value || "accepted" in value),
    );
  // Inspect all receipt-shaped objects for conflicts; never pick the last valid
  // object while silently dropping an earlier rejected/malformed publication.
  const ids = [
    ...reports.flatMap(({ value }) =>
      hex(value?.event_id) ? [value.event_id] : [],
    ),
    ...malformedIds,
  ];
  const validReceipt = (receipt: ObjectValue | undefined) =>
    !!receipt &&
    receipt.accepted === true &&
    hex(receipt.event_id) &&
    typeof receipt.message === "string" &&
    Array.isArray(receipt.mention_pubkeys) &&
    receipt.mention_pubkeys.every(hex) &&
    (!("audience" in receipt) || isMessageAudience(receipt.audience)) &&
    Object.keys(receipt).every((key) =>
      [
        "accepted",
        "event_id",
        "message",
        "mention_pubkeys",
        "audience",
      ].includes(key),
    );
  const candidate = reports.length === 1 ? reports[0] : undefined;
  const receipt = candidate?.value;
  const valid =
    !malformed.length &&
    candidate?.index === lines.length - 1 &&
    validReceipt(receipt);
  // A shell can run several sends. A complete, distinct trailing receipt block
  // links each message to this tool/turn, but cannot delimit per-message work.
  const validBlock =
    reports.length > 0 &&
    !malformed.length &&
    new Set(ids).size === reports.length &&
    reports.every(
      ({ value, index }, i) =>
        validReceipt(value) && index === lines.length - reports.length + i,
    );
  const success =
    completion.status === "completed" &&
    object(completion.rawOutput)?.isError === false &&
    output?.exit_code === 0 &&
    output.timed_out === false &&
    output.stdout_truncated === false;
  return {
    ids,
    messageId: valid && success ? String(receipt?.event_id) : undefined,
    messageIds: validBlock && success ? ids : [],
    // Receipt report only. Signed message tags remain the authoritative declaration.
    reportedAudience:
      valid && success && isMessageAudience(receipt?.audience)
        ? receipt.audience
        : undefined,
    ambiguous:
      malformed.length > 0 || (reports.length > 0 && !(valid && success)),
  };
}

export function reportedSend(
  start: ObjectValue,
  completion: ObjectValue,
): { messageId: string } | "ambiguous" | undefined {
  const report = sendReport(completion);
  if (
    report.ambiguous ||
    (report.messageId && start.title !== "buzz-dev-mcp__shell")
  )
    return "ambiguous";
  return report.messageId ? { messageId: report.messageId } : undefined;
}
