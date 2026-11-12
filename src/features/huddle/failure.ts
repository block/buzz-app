export type HuddleFailure = Readonly<{
  title: string;
  description: string;
  /** Joining again can work, so the notice offers Join again. */
  rejoin: boolean;
}>;

type Cause = Readonly<{
  test: RegExp;
  description: string;
  /** Overrides the phase title once the call had connected. */
  ended?: string;
  /** Overrides the phase title in either phase. */
  title?: string;
  rejoin?: boolean;
}>;

// Native and service text varies in punctuation and wording; match the cause,
// never the exact sentence, so the copy is independent of the Rust strings.
const causes: readonly Cause[] = [
  {
    test: /huddle audio unavailable in this deployment/i,
    title: "Huddle audio unavailable",
    description:
      "Huddle audio isn’t available on this server. A relay administrator needs to check its configuration.",
  },
  {
    test: /microphone disconnected/i,
    description: "Your microphone disconnected. Check it, then join again.",
    rejoin: true,
  },
  {
    test: /microphone access|permission denied|not allowed/i,
    description:
      "Buzz couldn’t use your microphone. Check it, then join again.",
    rejoin: true,
  },
  {
    test: /^connect to this channel/i,
    description: "Connect to this channel first, then try again.",
  },
  {
    test: /no longer have access|not a member|must belong to this huddle|channel is archived/i,
    ended: "Huddle ended",
    description: "You no longer have access to this channel.",
  },
  {
    test: /relay ended|huddle has ended/i,
    ended: "Huddle ended",
    description: "The community ended this Huddle.",
  },
  {
    test: /audio decoder|playback failed/i,
    title: "Couldn’t play Huddle audio",
    description: "Restart Buzz, then join again.",
  },
  {
    test: /disconnected|stalled|timed out|connection (?:closed|changed)|authorization (?:changed|expired)/i,
    description: "The connection dropped.",
    rejoin: true,
  },
];

/** One sentence for a failed or dropped Huddle; never the raw native text. */
export function huddleFailure(
  error: string | undefined,
  dropped: boolean,
): HuddleFailure {
  const phase = dropped ? "Huddle disconnected" : "Couldn’t join the Huddle";
  const cause = error && causes.find(({ test }) => test.test(error));
  if (!cause)
    return {
      title: phase,
      description: "Something went wrong with the Huddle connection.",
      rejoin: true,
    };
  return {
    title: cause.title ?? (dropped ? cause.ended : undefined) ?? phase,
    description: cause.description,
    rejoin: !!cause.rejoin,
  };
}
