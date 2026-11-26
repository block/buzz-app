import {
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import {
  BrowserIcon,
  ChatCircleIcon,
  MicrophoneIcon,
  ThreadIcon,
} from "../../shared/design-system/icons/index";
import {
  channelIcon,
  channelIconLabel,
} from "../../features/channels/channel-icon";
import { useIdentityNames } from "../../features/identity-names/react";
import { sortParticipantNames } from "../../features/identity-names/participant-order";
import type { PagesReader, RegisteredPage } from "../../features/pages/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Decisions } from "../../features/decisions/service";
import type { OpenTarget } from "../../features/navigation/targets";
import type { Speech } from "../../features/speech/service";
import { useDictation } from "../../features/speech/use-dictation";
import { conversationFocusTarget } from "../../app/focus-navigation";
import {
  BESTIE_PAGE,
  BestieNavigationContext,
  type BestieMark,
} from "../../app/shell/bestie-context";
import { PageIcon } from "../../app/shell/PageIcon";
import { orderPages, pagePresentation } from "../../app/shell/presentation";
import {
  holdsLead,
  type JumpCandidate,
  type JumpPlace,
  jumpPlaces,
  type LiveLead,
  pickPlace,
  VOICE_JUMP_THRESHOLD,
  type VoiceJump as JumpResult,
} from "./places";
import styles from "./VoiceJump.module.css";

export type VoiceJumpScope = Readonly<{
  viewer: string;
  communityOrigin: string;
}>;

type Phase =
  | { kind: "listening" }
  | { kind: "matching" }
  | { kind: "none"; text: string }
  | { kind: "failed"; message: string };

type OpenedDestination =
  | { kind: "page" }
  | { kind: "conversation"; channelId: string };

function presentPage(page: RegisteredPage, bestie: BestieMark | undefined) {
  return {
    ...pagePresentation(page),
    ...(page.key === BESTIE_PAGE ? bestie : undefined),
  };
}

/** Say where to go: it listens as it opens, and the best match among the
 * plugin pages and conversations already in memory opens, while speaking
 * when it is sure. */
export function VoiceJumpDialog({
  open,
  onOpenChange,
  speech,
  decisions,
  pages,
  session,
  scope,
  navigate,
  again,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  speech: Pick<Speech, "listen">;
  decisions: Decisions;
  pages: PagesReader;
  session: RelaySession;
  /** The connected community, or undefined while there is none. */
  scope: VoiceJumpScope | undefined;
  navigate(target: OpenTarget): void;
  again: { current: (() => void) | undefined };
}) {
  const input = useRef<HTMLElement>(null);
  // The destination a jump opened, which takes focus as the box closes.
  const opened = useRef<OpenedDestination | undefined>(undefined);
  useEffect(() => {
    if (open) opened.current = undefined;
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Jump by voice"
      presentation="search"
      size="default"
      motion="none"
      dismissOnOutsideClick
      initialFocus={input}
      finalFocus={() => {
        if (!opened.current) return true;
        if (opened.current.kind === "page")
          return document.getElementById("main-content") || false;
        return conversationFocusTarget(opened.current.channelId) || false;
      }}
    >
      {open && (
        <VoiceJumpBody
          speech={speech}
          decisions={decisions}
          pages={pages}
          session={session}
          scope={scope}
          input={input}
          again={again}
          go={(place) => {
            if (place.kind === "page") {
              opened.current = { kind: "page" };
              onOpenChange(false);
              navigate({
                version: 1,
                kind: "page",
                pluginId: place.pluginId,
                pageId: place.pageId,
                ...(scope ? { scope } : {}),
              });
              return;
            }
            if (!scope) return;
            opened.current = {
              kind: "conversation",
              channelId: place.channelId,
            };
            onOpenChange(false);
            navigate({
              version: 1,
              kind: "conversation",
              scope,
              channelId: place.channelId,
              ...(place.rootId
                ? { messageId: place.rootId, threadRootId: place.rootId }
                : {}),
            });
          }}
        />
      )}
    </Dialog>
  );
}

function VoiceJumpBody({
  speech,
  decisions,
  pages: pagesReader,
  session,
  scope,
  input,
  again,
  go,
}: {
  speech: Pick<Speech, "listen">;
  decisions: Decisions;
  pages: PagesReader;
  session: RelaySession;
  scope: VoiceJumpScope | undefined;
  input: RefObject<HTMLElement | null>;
  again: { current: (() => void) | undefined };
  go: (place: JumpPlace) => void;
}) {
  const resolveName = useIdentityNames(session.names);
  const pages = useSyncExternalStore(
    pagesReader.subscribe,
    pagesReader.snapshot,
  );
  const bestie = useContext(BestieNavigationContext);
  const pageByKey = useMemo(
    () => new Map(pages.map((page) => [page.key, page])),
    [pages],
  );
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
  const placesNow = () =>
    (run.current.places ??= jumpPlaces(
      sources(session, resolveName, pages, bestie, Boolean(scope)),
    ));
  const ask = (said: string, community: string | undefined) => {
    const current = run.current;
    const places = placesNow();
    let answer = current.answers.get(said);
    if (!answer) {
      // Threshold 0: the caller decides how sure is sure enough.
      answer = pickPlace(decisions, said, places, community, 0);
      current.answers.set(said, answer);
    }
    return answer;
  };
  const goTo = (place: JumpPlace) => {
    if (place.kind !== "page" && !scope) return;
    run.current.done = true;
    go(place);
  };
  const show = (result: JumpResult) => {
    if (result.outcome !== "failed") setCandidates(result.candidates);
  };
  /** While words are still landing: one check at a time, always on the
   * newest words, and a jump only once the decision stays sure of the same
   * place through another word, so a longer name still being said can win. */
  const live = (said: string) => {
    const current = run.current;
    if (current.done || !said.trim() || !placesNow().length) return;
    if (current.live) {
      current.pending = said;
      return;
    }
    current.live = true;
    void ask(said, scope?.communityOrigin).then((result) => {
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
    if (current.done || !said.trim() || !placesNow().length) return;
    void ask(said, scope?.communityOrigin).then((result) => {
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
    if (!placesNow().length)
      return setPhase(
        scope
          ? { kind: "none", text: said }
          : {
              kind: "failed",
              message: "Choose a community to jump to its conversations.",
            },
      );
    const current = run.current;
    if (current.done) return;
    setPhase({ kind: "matching" });
    void ask(said, scope?.communityOrigin).then((result) => {
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
  const dictation = useDictation(speech, {
    onText: (next) => {
      setPhase({ kind: "listening" });
      setText(next);
      // The dictation hook keeps the newest callbacks, so this is current.
      live(next);
    },
    onPause: (spoken) => settle(spoken),
    onEnd: (spoken) => submitRef.current(spoken),
    onError: (_failure, message) => setPhase({ kind: "failed", message }),
  });
  const { start, stop, cancel } = dictation;
  const listen = () => {
    restart();
    setCandidates([]);
    setText("");
    setPhase({ kind: "listening" });
    start(scope ? { community: scope.communityOrigin } : {});
  };
  const listenRef = useRef(listen);
  listenRef.current = listen;
  // Listening starts as the box opens.
  useEffect(() => {
    listenRef.current();
  }, []);
  const listening = dictation.state !== "idle";
  useEffect(() => {
    again.current = () => (listening ? stop() : listenRef.current());
    return () => {
      again.current = undefined;
    };
  }, [again, listening, stop]);
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
        placeholder="Say a page, channel, person, chat or thread"
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
              ? `Nothing you have open matched “${phase.text}”. Try a page, channel, person or chat name.`
              : "Didn't catch that. Try saying a page, channel, person or chat name."
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
                    page={
                      place.kind === "page"
                        ? pageByKey.get(place.pageKey)
                        : undefined
                    }
                    bestie={bestie}
                    channel={
                      place.kind === "page"
                        ? undefined
                        : session.channels.get?.(place.channelId)
                    }
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
  page,
  bestie,
  channel,
  probability,
  onChoose,
}: {
  place: JumpPlace;
  page: RegisteredPage | undefined;
  bestie: BestieMark | undefined;
  channel: ChannelSummary | undefined;
  probability: number;
  onChoose: () => void;
}) {
  const trailing = (
    <span className="text-body-sm tabular-nums">
      {Math.round(probability * 100)}%
      <span className="sr-only"> match score</span>
    </span>
  );
  if (place.kind === "page") {
    const presented = page ? presentPage(page, bestie) : undefined;
    return (
      <NavigationItem
        variant="search"
        icon={
          presented?.avatar ? (
            <Avatar
              alt=""
              fallback={place.name}
              src={presented.avatar.src}
              size="small"
              shape={presented.avatar.shape}
            />
          ) : (
            <span
              className="search-peek-tile"
              data-tone="page"
              aria-hidden="true"
            >
              <PageIcon
                icon={presented?.icon ?? BrowserIcon}
                image={presented?.image}
                size={15}
              />
            </span>
          )
        }
        label={
          <>
            <span className="block truncate text-body-sm">{place.name}</span>
            <span className="block truncate text-body-sm text-subtle">
              {place.about ?? "Page"}
            </span>
          </>
        }
        trailing={trailing}
        onClick={onChoose}
      />
    );
  }
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
      trailing={trailing}
      onClick={onChoose}
    />
  );
}

/** Everything in memory voice jump may go to: never reads the relay. */
function sources(
  session: RelaySession,
  resolveName: ReturnType<typeof useIdentityNames>,
  pages: readonly RegisteredPage[],
  bestie: BestieMark | undefined,
  includeConversations: boolean,
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
    pages: orderPages(pages).map((page) => {
      const presented = presentPage(page, bestie);
      const about =
        presented.detail ??
        (presented.label !== page.title ? page.title : undefined);
      return {
        key: page.key,
        pluginId: page.pluginId,
        pageId: page.id,
        name: presented.label,
        ...(about ? { about } : {}),
      };
    }),
    channels: includeConversations ? session.channels.list().channels : [],
    name,
    window: (channelId: string) => session.channels.window(channelId),
    activity: includeConversations ? session.unread.inbox().items : [],
    author: (pubkey: string, channel: ChannelSummary) =>
      person(pubkey, channel.members),
  };
}
