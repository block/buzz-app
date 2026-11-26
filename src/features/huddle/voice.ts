import { MESSAGE_SOURCE_TAG } from "../relay/contracts";
import { tag } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import { createPcmSender } from "./sender";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  AgentVoiceConnection,
} from "../agents/service";
import { relayOrigin } from "../communities/destination";
import type { RelayData } from "../relay/service";
import type { HuddleBridge, HuddleDestination } from "./bridge";
import type { Huddles } from "./service";

type Seat = {
  call: string;
  agent: Agent;
  voice: RegisteredAgentType["voice"];
  stop(): Promise<void>;
  input(samples: number[], source?: string): void;
  mixesPeers: boolean;
};

/** A local call or verified owner participation on another device supplies the call.
 * Membership is the room's signed roster; parent membership never seats an agent. */
export function createHuddleVoices(
  huddles: Pick<
    Huddles,
    "snapshot" | "subscribe" | "voiceListening" | "voiceThinking"
  > &
    Partial<
      Pick<
        Huddles,
        "subscribePeerAudio" | "openLocalPlayout" | "subscribeLocalMicrophone"
      >
    > & {
      voiceAgent?(): string | undefined;
      endedByOwner?(call: string): boolean;
    },
  agents: Pick<Agents, "snapshot" | "subscribe" | "types" | "reserveVoice">,
  relay: RelayData,
  bridge: HuddleBridge,
  report: (call: string, error: string) => void,
) {
  const seats = new Map<string, Seat>();
  let session = relay.snapshot().session;
  let offMembers = session.channels.subscribeList(sync);
  let disposed = false;
  let resolution: { call: string; ready: boolean } | undefined;
  function open(
    agent: Agent,
    voice: NonNullable<RegisteredAgentType["voice"]>,
    call: string,
    destination: HuddleDestination,
    room: string,
    transcriptDestination:
      | NonNullable<ReturnType<Huddles["snapshot"]>["transcriptDestination"]>
      | undefined,
  ): Seat {
    const id = crypto.randomUUID();
    const callSession = session;
    const remoteCall = huddles.voiceAgent?.() === agent.pubkey;
    let ownerPresent = false;
    let ownerLeft = false;
    const abort = new AbortController();
    let connection: AgentVoiceConnection | undefined;
    let stopLocalMicrophone: (() => void) | undefined;
    let opening: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let starting: Promise<void> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let release: (() => void) | undefined;
    let localPlayout: ReturnType<Huddles["openLocalPlayout"]>;
    const fail = (error?: unknown) => {
      if (abort.signal.aborted) return;
      void stop();
      report(
        call,
        `${agent.name}: ${error instanceof Error ? error.message : error || "Voice disconnected"}. Leave and rejoin the Huddle to retry.`,
      );
    };
    const sender = createPcmSender(
      (samples) => bridge.send(id, samples),
      abort.signal,
      fail,
    );
    function input(samples: number[], source?: string) {
      if (abort.signal.aborted) return;
      try {
        if (source) connection?.input(samples, source);
        else connection?.input(samples);
      } catch (error) {
        fail(error);
      }
    }
    function stop() {
      if (closing) return closing;
      abort.abort();
      localPlayout?.close();
      stopLocalMicrophone?.();
      clearInterval(heartbeat);
      release?.();
      closing = Promise.allSettled([
        starting,
        Promise.resolve().then(() => connection?.close()),
        Promise.resolve(opening)
          .catch(() => {})
          .then(() => opening && bridge.close(id)),
      ]).then((results) => {
        for (const result of results)
          if (result.status === "rejected")
            report(call, `${agent.name}: ${String(result.reason)}`);
      });
      // Publishing re-enters sync: closing must already guard stop().
      huddles.voiceListening(call, agent.pubkey, false);
      huddles.voiceThinking(call, agent.pubkey, false);
      return closing;
    }
    // Start in a microtask so the seat is recorded before callbacks can re-enter sync.
    starting = Promise.resolve()
      .then(async () => {
        if (abort.signal.aborted) return;
        // Counted before the bridge opens, so a restart can't retire it then.
        release = agents.reserveVoice(agent.key);
        opening = bridge.open(
          id,
          destination,
          room,
          (event) => {
            if (abort.signal.aborted) return;
            if (event.type === "ended") {
              if (event.error) fail(event.error);
              else {
                ownerLeft = remoteCall && ownerPresent;
                void stop();
              }
              return;
            }
            if (event.type === "participants" || event.type === "connected") {
              if (!event.participants.includes(agent.owner)) {
                ownerLeft = remoteCall && ownerPresent;
                return void stop();
              }
              ownerPresent = true;
            }
            // Defense in depth; privacy tests count at the native decode site.
            if (
              event.type === "audio" &&
              event.peer === agent.owner &&
              (!stopLocalMicrophone ||
                huddles.snapshot().routing?.directAudio === false)
            )
              input(event.samples);
          },
          agent.pubkey,
        );
        await opening;
        if (abort.signal.aborted) return;
        localPlayout = huddles.openLocalPlayout?.(call, agent.pubkey);
        heartbeat = setInterval(() => {
          void bridge.touch(id).catch(fail);
        }, 5000);
        const participantKeys = () => {
          const current = huddles.snapshot();
          return current.id === call
            ? current.participants.filter((key) => key !== agent.pubkey)
            : [];
        };
        const profiles = callSession.profiles;
        const requested = new Set<string>();
        const loadNames = () => {
          const missing = participantKeys().filter(
            (key) => !profiles.snapshot().has(key) && !requested.has(key),
          );
          for (const key of missing) requested.add(key);
          if (missing.length)
            void profiles.ensure(missing, "background").catch(() => {});
        };
        loadNames();
        const conversation = transcriptDestination
          ? {
              channelId: transcriptDestination.channelId,
              ...(transcriptDestination.root !==
                transcriptDestination.parentId &&
                transcriptDestination.root && {
                  root: transcriptDestination.root,
                }),
            }
          : { channelId: room };
        const opened = await voice({
          agent,
          conversation,
          subscribeTypedMessages(listener) {
            const seen = new Set<string>();
            return callSession.subscribeLive(({ events }) => {
              for (const event of events) {
                if (
                  abort.signal.aborted ||
                  huddles.snapshot().id !== call ||
                  event.kind !== 9 ||
                  event.pubkey !== agent.owner ||
                  tag(event, "h") !== conversation.channelId ||
                  (threadReference(event)?.rootId !== conversation.root &&
                    threadReference(event)?.rootId !==
                      transcriptDestination?.root) ||
                  tag(event, MESSAGE_SOURCE_TAG) !== "typed" ||
                  !event.content.trim() ||
                  seen.has(event.id)
                )
                  continue;
                seen.add(event.id);
                listener({
                  speaker:
                    profiles.snapshot().get(event.pubkey)?.name ||
                    "Unnamed speaker",
                  text: event.content,
                });
              }
            });
          },
          participants: {
            snapshot: () => {
              const people = profiles.snapshot();
              const running = agents.snapshot().running;
              return participantKeys().map(
                (key) =>
                  running.find((other) => other.pubkey === key)?.name ||
                  people.get(key)?.name ||
                  "Unnamed participant",
              );
            },
            subscribe: (listener) => {
              const stopProfiles = profiles.subscribe(listener);
              const stopHuddle = huddles.subscribe(() => {
                loadNames();
                listener();
              });
              return () => {
                stopProfiles();
                stopHuddle();
              };
            },
          },
          ...(transcriptDestination && {
            transcriptDestination,
            streamTranscript: () =>
              huddles.snapshot().routing?.liveTranscript === true,
            resumeOnClose: () => {
              const current = huddles.snapshot();
              const relayState = relay.snapshot();
              return (
                ((current.id === call && current.cleanHangup === true) ||
                  (remoteCall &&
                    (ownerLeft || huddles.endedByOwner?.(call) === true))) &&
                relayState.session === callSession &&
                relayState.scope === destination.scope &&
                relayState.status === "ready"
              );
            },
          }),
          signal: abort.signal,
          ended: fail,
          thinking: (active) => {
            if (!abort.signal.aborted)
              huddles.voiceThinking(call, agent.pubkey, active);
          },
          output: (samples) => {
            if (abort.signal.aborted) return Promise.resolve();
            // The owner's local copy avoids the relay round trip. The relay
            // still carries the same frames to every other device in the room.
            localPlayout?.play(samples);
            return sender.send(samples);
          },
        });
        if (abort.signal.aborted) await opened.close();
        else {
          connection = opened;
          stopLocalMicrophone = huddles.subscribeLocalMicrophone?.(call, input);
          huddles.voiceListening(call, agent.pubkey, true);
        }
      })
      .catch(fail);
    return {
      call,
      agent,
      voice,
      stop,
      input,
      mixesPeers: !!transcriptDestination,
    };
  }
  function sync() {
    if (disposed) return;
    const current = relay.snapshot();
    if (session !== current.session) {
      offMembers();
      session = current.session;
      resolution = undefined;
      offMembers = session.channels.subscribeList(sync);
    }
    const call = huddles.snapshot();
    const destination = call.destination;
    const room = call.room;
    const types = agents.types();
    const connected =
      bridge.available &&
      call.phase === "connected" &&
      call.id &&
      room &&
      destination &&
      current.status === "ready" &&
      !current.cached &&
      current.scope === destination.scope &&
      current.viewer === destination.viewer &&
      call.participants.includes(destination.viewer);
    if (!connected || resolution?.call !== call.id) resolution = undefined;
    const candidates =
      connected && agents.snapshot().status === "ready"
        ? agents
            .snapshot()
            .running.filter(
              (agent) =>
                (!huddles.voiceAgent?.() ||
                  agent.pubkey === huddles.voiceAgent()) &&
                agent.place === "here" &&
                agent.owner === destination.viewer &&
                relayOrigin(agent.relay) ===
                  relayOrigin(destination.relayUrl) &&
                types.some((type) => type.key === agent.type && type.voice),
            )
        : [];
    if (connected && candidates.length && !resolution) {
      const pending = { call: call.id, ready: false };
      resolution = pending;
      // Resolve only for voice candidates. A failure leaves seats closed and
      // retries on the next notification, never from the rejection itself.
      void session.channels.resolve?.([room], { consistency: "strong" }).then(
        () => {
          if (resolution !== pending) return;
          pending.ready = true;
          sync();
        },
        () => {
          if (resolution === pending) resolution = undefined;
        },
      );
    }
    // relay/discovery.ts projects members from verified relay-authored 39002 p tags.
    const channel = room ? session.channels.get?.(room) : undefined;
    const available =
      connected &&
      (!session.channels.resolve || resolution?.ready) &&
      channel &&
      !channel.pending &&
      !channel.cached &&
      !channel.archived &&
      !channel.readOnly &&
      (!huddles.voiceAgent?.() ||
        (channel.huddle === true &&
          channel.parentChannelId === destination?.channelId));
    const transcriptDestination =
      channel?.parentChannelId === destination?.channelId
        ? channel?.huddleTranscript
        : undefined;
    const parent =
      transcriptDestination &&
      session.channels.get?.(transcriptDestination.channelId);
    const running = available
      ? candidates.filter(
          (agent) =>
            channel.members?.includes(agent.pubkey) &&
            (!transcriptDestination ||
              (agent.type === "buzz.codex/codex" &&
                parent?.members?.includes(agent.pubkey) &&
                !parent.archived &&
                !parent.cached)),
        )
      : [];
    for (const [key, seat] of seats) {
      const agent = running.find((agent) => agent.pubkey === key);
      if (
        !agent ||
        seat.call !== call.id ||
        agent.key !== seat.agent.key ||
        agent.protectionRevision !== seat.agent.protectionRevision ||
        types.find((type) => type.key === agent.type)?.voice !== seat.voice
      ) {
        // Keep closing seats reserved: native permits only one connection per agent.
        void seat.stop().then(() => {
          if (seats.get(key) !== seat) return;
          seats.delete(key);
          sync();
        });
      }
    }
    if (!available) return;
    for (const agent of running) {
      const voice = types.find((type) => type.key === agent.type)?.voice;
      if (voice && !seats.has(agent.pubkey))
        seats.set(
          agent.pubkey,
          open(agent, voice, call.id, destination, room, transcriptDestination),
        );
    }
  }
  // The human connection already receives playback. Mix only the other
  // authorized Codex seats on this device into each agent's microphone track.
  const stopPeerAudio = huddles.subscribePeerAudio?.((call, peer, samples) => {
    const source = seats.get(peer);
    if (
      !source?.mixesPeers ||
      source.call !== call ||
      !huddles.snapshot().listening?.includes(peer)
    )
      return;
    for (const seat of seats.values())
      if (seat !== source && seat.mixesPeers && seat.call === call)
        seat.input(samples, peer);
  });
  const stops = [
    huddles.subscribe(sync),
    agents.subscribe(sync),
    relay.subscribe(sync),
  ];
  sync();
  return async () => {
    disposed = true;
    offMembers();
    stopPeerAudio?.();
    for (const stop of stops) stop();
    await Promise.all([...seats.values()].map((seat) => seat.stop()));
    seats.clear();
  };
}
