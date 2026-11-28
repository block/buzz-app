/** What a community's NIP-11 document says about the events it accepts. */
export type RelayInfo = Readonly<{
  extensions: readonly string[];
  /** The largest message the relay accepts, in bytes, when it says. */
  maxMessageLength?: number | undefined;
}>;

export function relayInfoOf(info: unknown): RelayInfo {
  const document = (info ?? {}) as {
    supported_extensions?: unknown;
    limitation?: { max_message_length?: unknown };
  };
  const max = document.limitation?.max_message_length;
  return {
    extensions: Array.isArray(document.supported_extensions)
      ? document.supported_extensions.filter(
          (x): x is string => typeof x === "string",
        )
      : [],
    maxMessageLength:
      typeof max === "number" && Number.isSafeInteger(max) && max > 0
        ? max
        : undefined,
  };
}
