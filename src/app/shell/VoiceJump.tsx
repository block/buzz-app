import { isTauri } from "@tauri-apps/api/core";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import {
  ChatCircleIcon,
  MicrophoneIcon,
  ThreadIcon,
} from "../../shared/design-system/icons/index";
import {
  channelIcon,
  channelIconLabel,
} from "../../features/channels/channel-icon";
import type { KeyBinding } from "../../features/shortcuts/bindings";
import type { ShortcutBindingsSnapshot } from "../../features/shortcuts/preferences";
import {
  formatBinding,
  isApplePlatform,
} from "../../features/shortcuts/format";
import { communityDestination } from "../../features/communities/destination";
import { useIdentityNames } from "../../features/identity-names/react";
import { sortParticipantNames } from "../../features/identity-names/participant-order";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Decisions } from "../../features/decisions/service";
import {
  prepareVoice,
  useVoiceDictation,
  useVoiceSearchAvailable,
} from "../../features/search/voice-dictation";
import {
  holdsLead,
  type JumpCandidate,
  type JumpPlace,
  jumpPlaces,
  type LiveLead,
  pickPlace,
  VOICE_JUMP_THRESHOLD,
  type VoiceJump as JumpResult,
} from "../../features/search/voice-jump";
import type { AppServices } from "../services";
import { HOST_SHORTCUT_ORDER } from "../shortcuts";
import { conversationFocusTarget } from "../focus-navigation";
import "./SearchChoices.css";
import styles from "./VoiceJump.module.css";

export type VoiceJumpServices = Pick<
  AppServices,
  "communities" | "shortcuts" | "navigation"
> &
  Partial<Pick<AppServices, "decisions" | "shortcutBindings">>;

const VOICE_JUMP_ID = "voice-jump";
const NO_OVERRIDES: ShortcutBindingsSnapshot = { overrides: {}, error: null };
const noSubscribe = () => () => {};
const noOverrides = () => NO_OVERRIDES;
const VOICE_JUMP_BINDING: KeyBinding = { key: "k", mod: true, shift: true };

type Phase =
  | { kind: "listening" }
  | { kind: "matching" }
  | { kind: "none"; text: string }
  | { kind: "failed"; message: string };

/** Say where to go: the mic opens live, and when you stop, the best match
 * among the conversations already in memory opens. */
export function VoiceJump({
  services,
}: {
  services?: VoiceJumpServices | undefined;
}) {
  const decisions = services?.decisions;
  const available = useVoiceSearchAvailable(!!decisions && isTauri());
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLElement>(null);
  const opened = useRef<string | undefined>(undefined);
  // The shortcut pressed while open hands off to the open box.
  const again = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (available) prepareVoice();
  }, [available]);
  useEffect(() => {
    if (!available || !services) return;
    return services.shortcuts.registerHost({
      id: VOICE_JUMP_ID,
      title: "Jump by voice",
      binding: VOICE_JUMP_BINDING,
      order: HOST_SHORTCUT_ORDER.search + 2,
      allowInEditable: true,
      allowInModal: true,
      run: () => {
        if (again.current) return again.current();
        opened.current = undefined;
        setOpen(true);
      },
    });
  }, [available, services]);
  const close = useCallback(() => {
    setOpen(false);
    // The next opening starts with a key already fetched.
    prepareVoice();
  }, []);
  // The hint follows the person's rebind, as Search's does.
  const { overrides } = useSyncExternalStore(
    services?.shortcutBindings?.subscribe ?? noSubscribe,
    services?.shortcutBindings?.snapshot ?? noOverrides,
  );
  const binding = overrides[VOICE_JUMP_ID] ?? VOICE_JUMP_BINDING;
  if (!services || !decisions || !available) return null;
  const label = `Jump by voice (${formatBinding(binding, isApplePlatform(navigator.platform)).text})`;
  return (
    <>
      <IconButton
        data-shell-voice-jump=""
        variant="ghost"
        shape="round"
        aria-label="Jump by voice"
        title={label}
        aria-pressed={open}
        icon={<MicrophoneIcon size={16} aria-hidden="true" />}
        onClick={() => {
          opened.current = undefined;
          setOpen(true);
        }}
      />
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title="Jump by voice"
        presentation="search"
        size="default"
        motion="none"
        dismissOnOutsideClick
        initialFocus={input}
        finalFocus={() =>
          opened.current
            ? conversationFocusTarget(opened.current) || false
            : true
        }
      >
        {open && (
          <VoiceJumpBody
            services={services}
            decisions={decisions}
            input={input}
            again={again}
            go={(place) => {
              opened.current = place.channelId;
              close();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function VoiceJumpBody({
  services,
  decisions,
  input,
  again,
  go,
}: {
  services: VoiceJumpServices;
  decisions: Decisions;
  input: RefObject<HTMLElement | null>;
  again: { current: (() => void) | undefined };
  go: (place: JumpPlace) => void;
}) {
  const relay = useSyncExternalStore(
    services.communities.relay.subscribe,
    services.communities.relay.snapshot,
  );
  const session = relay.session;
  const resolveName = useIdentityNames(session.names);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "listening" });
  // The likeliest places for the words so far, refined as words land.
  const [candidates, setCandidates] = useState<readonly JumpCandidate[]>([]);
  // Each listen or edit starts a new epoch; answers from an older one are
  // dropped. Within one, answers are kept by text, so the final check reuses
  // the live check of the same words.
  const run = useRef<{
    epoch: number;
    places?: JumpPlace[];
    answers: Map<string, Promise<JumpResult>>;
    live: boolean;
    pending?: string | undefined;
    /** The place a live check was last sure of, and at how many words. */
    lead?: LiveLead | undefined;
    done: boolean;
  }>({ epoch: 0, answers: new Map(), live: false, done: false });
  const restart = useCallback(() => {
    run.current = {
      epoch: run.current.epoch + 1,
      answers: new Map(),
      live: false,
      done: false,
    };
  }, []);
  const scopeNow = () => {
    const client = services.communities.snapshot();
    if (!client.selected || !client.viewer) return undefined;
    return {
      viewer: client.viewer,
      communityOrigin: communityDestination(client.selected).url,
    };
  };
  const ask = (said: string, community: string) => {
    const current = run.current;
    current.places ??= jumpPlaces(sources(session, resolveName));
    let answer = current.answers.get(said);
    if (!answer) {
      // Threshold 0: the caller decides how sure is sure enough.
      answer = pickPlace(decisions, said, current.places, community, 0);
      current.answers.set(said, answer);
    }
    return answer;
  };
  const goTo = (place: JumpPlace) => {
    const scope = scopeNow();
    if (!scope) return;
    run.current.done = true;
    go(place);
    void services.navigation.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId: place.channelId,
      ...(place.rootId
        ? { messageId: place.rootId, threadRootId: place.rootId }
        : {}),
    });
  };
  const show = (result: JumpResult) => {
    if (result.outcome !== "failed") setCandidates(result.candidates);
  };
  /** While words are still landing: one check at a time, always on the
   * newest words, and a jump only once Jev stays sure of the same place
   * through another word, so a longer name still being said can win. */
  const live = (said: string) => {
    const current = run.current;
    const scope = scopeNow();
    if (current.done || !scope || !said.trim()) return;
    if (current.live) {
      current.pending = said;
      return;
    }
    current.live = true;
    void ask(said, scope.communityOrigin).then((result) => {
      if (run.current !== current || current.done) return;
      current.live = false;
      show(result);
      const held = holdsLead(current.lead, result, said, current.places ?? []);
      current.lead = held.lead;
      if (held.jump && result.outcome === "found") return goTo(result.place);
      const next = current.pending;
      current.pending = undefined;
      if (next !== undefined && next !== said) live(next);
    });
  };
  /** A short pause in speech: jump if the words so far reach 0.5, and
   * otherwise keep listening, so only a long pause can come up empty. */
  const settle = (said: string) => {
    const current = run.current;
    const scope = scopeNow();
    if (current.done || !scope || !said.trim()) return;
    void ask(said, scope.communityOrigin).then((result) => {
      if (run.current !== current || current.done) return;
      show(result);
      if (
        result.outcome === "found" &&
        result.probability >= VOICE_JUMP_THRESHOLD
      )
        goTo(result.place);
    });
  };
  /** Once speech ends or Enter is pressed: the best match at 0.5 or more. */
  const submit = (spoken: string) => {
    const said = spoken.trim();
    if (!said) return setPhase({ kind: "none", text: "" });
    const scope = scopeNow();
    if (!scope)
      return setPhase({
        kind: "failed",
        message: "Choose a community to jump to its conversations.",
      });
    const current = run.current;
    if (current.done) return;
    setPhase({ kind: "matching" });
    void ask(said, scope.communityOrigin).then((result) => {
      if (run.current !== current || current.done) return;
      show(result);
      if (
        result.outcome === "found" &&
        result.probability >= VOICE_JUMP_THRESHOLD
      )
        goTo(result.place);
      else if (result.outcome !== "failed")
        setPhase({ kind: "none", text: said });
      else
        setPhase({
          kind: "failed",
          message:
            result.reason === "missing_credentials" ||
            result.reason === "unauthorized" ||
            result.reason === "unavailable"
              ? "Set up the Decisions API in Settings to jump by voice."
              : "Couldn't match that just now. Try again.",
        });
    });
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const dictation = useVoiceDictation({
    onText: (next) => {
      setPhase({ kind: "listening" });
      setText(next);
      // The dictation hook keeps the newest callbacks, so this is current.
      live(next);
    },
    onPause: (spoken) => settle(spoken),
    onEnd: (spoken) => submitRef.current(spoken),
    onError: (message) => setPhase({ kind: "failed", message }),
  });
  const { start, stop, cancel } = dictation;
  const listen = useCallback(() => {
    restart();
    setCandidates([]);
    setText("");
    setPhase({ kind: "listening" });
    void start();
  }, [restart, start]);
  // Listening starts as the box opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Once per opening.
  useEffect(() => {
    listen();
  }, []);
  const listening = dictation.state !== "idle";
  useEffect(() => {
    again.current = () => (listening ? stop() : listen());
    return () => {
      again.current = undefined;
    };
  }, [again, listening, stop, listen]);
  const status =
    phase.kind === "matching" ? (
      <ShimmerText>Finding it…</ShimmerText>
    ) : phase.kind === "failed" ? (
      phase.message
    ) : dictation.state === "starting" ? (
      <ShimmerText>Starting the microphone…</ShimmerText>
    ) : listening ? (
      <ShimmerText>Listening. Say where to go.</ShimmerText>
    ) : (
      "Press Enter to go, or the microphone to speak again."
    );
  return (
    <div className={styles.body}>
      <SearchField
        variant="palette"
        label="Where to"
        placeholder="Say a channel, person, chat or thread"
        inputRef={input}
        value={text}
        onValueChange={(next) => {
          // Typing takes over from the microphone.
          cancel();
          restart();
          setCandidates([]);
          setPhase({ kind: "listening" });
          setText(next);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          cancel();
          submit(text);
        }}
        trailing={
          <IconButton
            variant={listening ? "tint" : "ghost"}
            aria-label={listening ? "Stop listening" : "Speak again"}
            aria-pressed={listening}
            title={listening ? "Stop listening" : "Speak again"}
            loading={dictation.state === "starting"}
            icon={<MicrophoneIcon size={16} aria-hidden="true" />}
            onClick={() => {
              if (listening) stop();
              else listen();
              input.current?.focus();
            }}
          />
        }
      />
      {phase.kind === "none" && !candidates.length ? (
        <EmptyState
          frame="none"
          icon={<MicrophoneIcon size={20} />}
          title="Didn't find anything"
          description={
            phase.text
              ? `Nothing you have open matched “${phase.text}”. Try a channel, person or chat name.`
              : "Didn't catch that. Try saying a channel, person or chat name."
          }
          action={
            <Button size="sm" variant="subtle" onClick={listen}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          {phase.kind === "none" && (
            // Close but not sure enough: the nearest places stay to choose.
            <div className={styles.notice}>
              <p className={styles.status} aria-live="polite">
                Didn't find a great match. Closest places:
              </p>
              <Button size="sm" variant="subtle" onClick={listen}>
                Try again
              </Button>
            </div>
          )}
          {phase.kind !== "failed" && candidates.length > 0 && (
            <ul className={styles.candidates} aria-label="Likeliest places">
              {candidates.map(({ place, probability }) => (
                <li key={place.key}>
                  <VoiceJumpRow
                    place={place}
                    channel={session.channels.get?.(place.channelId)}
                    probability={probability}
                    onChoose={() => {
                      cancel();
                      goTo(place);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          {phase.kind !== "none" && (
            <p className={styles.status} aria-live="polite">
              {status}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function VoiceJumpRow({
  place,
  channel,
  probability,
  onChoose,
}: {
  place: JumpPlace;
  channel: ChannelSummary | undefined;
  probability: number;
  onChoose: () => void;
}) {
  const { kind } = place;
  const Icon =
    kind === "thread"
      ? ThreadIcon
      : kind === "channel"
        ? channelIcon(channel)
        : ChatCircleIcon;
  const excerpt = place.recent?.at(-1) ?? place.first;
  const detail =
    kind === "thread"
      ? place.in && `Thread in ${place.in}`
      : kind === "channel"
        ? (place.about ?? excerpt ?? channelIconLabel(channel))
        : (excerpt ??
          place.about ??
          (kind === "dm" ? "Direct message" : "Chat"));

  return (
    <NavigationItem
      variant="search"
      icon={
        <span
          className="search-peek-tile"
          data-tone={kind === "dm" ? "person" : kind}
          aria-hidden="true"
        >
          <Icon size={15} />
        </span>
      }
      label={
        <>
          <span className="block truncate text-body-sm">{place.name}</span>
          {detail && (
            <span className="block truncate text-body-sm text-subtle">
              {detail}
            </span>
          )}
        </>
      }
      trailing={
        <span className="text-body-sm tabular-nums">
          {Math.round(probability * 100)}%
          <span className="sr-only"> match score</span>
        </span>
      }
      onClick={onChoose}
    />
  );
}

/** Everything in memory voice jump may go to: never reads the relay. */
function sources(
  session: RelaySession,
  resolveName: ReturnType<typeof useIdentityNames>,
) {
  const profiles = session.profiles.snapshot();
  const person = (id: string, among?: readonly string[]) =>
    resolveName(id, profiles.get(id)?.name ?? id.slice(0, 10), among);
  const name = (channel: ChannelSummary) =>
    channel.channelType === "dm" && channel.participants
      ? sortParticipantNames(
          channel.participants.map((id) => person(id, channel.participants)),
        ).join(", ") || "Notes to self"
      : channel.name;
  return {
    channels: session.channels.list().channels,
    name,
    window: (channelId: string) => session.channels.window(channelId),
    activity: session.unread.inbox().items,
    author: (pubkey: string, channel: ChannelSummary) =>
      person(pubkey, channel.members),
  };
}
