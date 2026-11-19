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
import { KeyboardShortcut } from "../../shared/design-system/ui/KeyboardShortcut";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { ValueChip } from "../../shared/design-system/ui/ValueChip";
import {
  ChatCircleIcon,
  MicrophoneIcon,
  SparklesIcon,
  ThreadIcon,
  XIcon,
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
  useVoiceSearchBackend,
  type VoiceBackend,
} from "../../features/search/voice-dictation";
import {
  holdsLead,
  type JumpCandidate,
  type JumpPlace,
  jumpPlaces,
  type LiveLead,
  VOICE_JUMP_THRESHOLD,
  voiceHints,
} from "../../features/search/voice-jump";
import {
  captureVoiceThing,
  captureVoiceThingFromElement,
  isMiddleClickExcluded,
  middleClickElements,
  trackPointerPosition,
  type VoiceThing,
} from "../../features/search/voice-context";
import {
  type ActionCandidate,
  decideVoiceAction,
  holdsActionLead,
  type LiveActionLead,
  type ResolvedAction,
  VOICE_ACTION_AUTO_THRESHOLD,
  VOICE_ACTION_THRESHOLD,
  type VoiceActionDecisionOutcome,
  type VoiceSlotEntities,
} from "../../features/search/voice-actions";
import {
  sessionVoiceEntities,
  type AppVoiceAction,
  type VoiceActionContext,
} from "../../features/search/voice-actions-app";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import {
  matchSessionActionBindings,
  VOICE_ACTIONS,
} from "../../features/search/voice-actions-registry";
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
const NOTHING: VoiceThing = { kind: "nothing", label: "nothing" };

type ResolvedActionMatch = Extract<ResolvedAction, { kind: "action" }>;

type Phase =
  | { kind: "listening" }
  | { kind: "matching" }
  | { kind: "confirm"; resolved: ResolvedActionMatch; spoken: string }
  | { kind: "running"; summary: string }
  | { kind: "none"; text: string }
  | { kind: "failed"; message: string };

/** Say where to go or what to do to what you are pointing at: the mic opens
 * live, and when you stop, the best action or place opens or asks to confirm. */
export function VoiceJump({
  services,
}: {
  services?: VoiceJumpServices | undefined;
}) {
  const decisions = services?.decisions;
  const voiceBackend = useVoiceSearchBackend(!!decisions && isTauri());
  const voiceAvailable = voiceBackend !== null;
  const available = !!decisions && (voiceAvailable || import.meta.env.DEV);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [hovered, setHovered] = useState<VoiceThing>(NOTHING);
  // Once access is denied, the box stops starting the microphone by itself
  // for the rest of this session and says where to allow it.
  const [denied, setDenied] = useState<string>();
  const input = useRef<HTMLElement>(null);
  const opened = useRef<string | undefined>(undefined);
  // The shortcut pressed while open hands off to the open box.
  const again = useRef<(() => void) | undefined>(undefined);
  // Middle-click while listening stops early without restarting when idle.
  const stopEarly = useRef<(() => void) | undefined>(undefined);

  const relay = useSyncExternalStore(
    services?.communities.relay.subscribe ?? noSubscribe,
    services?.communities.relay.snapshot ?? (() => undefined),
  );
  const resolveName = useIdentityNames(relay?.session.names);

  useEffect(() => {
    if (voiceAvailable) prepareVoice();
  }, [voiceAvailable]);

  const pointerRef = useRef<ReturnType<typeof trackPointerPosition> | null>(
    null,
  );
  useEffect(() => {
    if (!available) return;
    const tracker = trackPointerPosition();
    pointerRef.current = tracker;
    return () => {
      tracker.stop();
      pointerRef.current = null;
    };
  }, [available]);

  const captureHovered = useCallback((): VoiceThing => {
    if (!services) return NOTHING;
    const currentRelay = services.communities.relay.snapshot();
    const target = services.navigation.snapshot().entry.target;
    const activeChannelId =
      target.kind === "conversation" ? target.channelId : undefined;
    return captureVoiceThing({
      pointer: pointerRef.current?.current(),
      session: currentRelay.session,
      resolveName,
      activeChannelId,
    });
  }, [services, resolveName]);

  useEffect(() => {
    if (!available || !services) return;
    return services.shortcuts.registerHost({
      id: VOICE_JUMP_ID,
      title: "Jump or act by voice",
      binding: VOICE_JUMP_BINDING,
      order: HOST_SHORTCUT_ORDER.search + 2,
      allowInEditable: true,
      allowInModal: true,
      run: () => {
        if (again.current) return again.current();
        opened.current = undefined;
        setHovered(captureHovered());
        setOpen(true);
      },
    });
  }, [available, services, captureHovered]);

  useEffect(() => {
    if (!available || !services) return;
    const onAuxClick = (event: MouseEvent) => {
      if (event.button !== 1 || event.defaultPrevented) return;
      const elements = middleClickElements(event);
      if (isMiddleClickExcluded(event, elements)) return;
      if (stopEarly.current) {
        event.preventDefault();
        stopEarly.current();
        return;
      }
      if (openRef.current) return;
      const currentRelay = services.communities.relay.snapshot();
      const target = services.navigation.snapshot().entry.target;
      const activeChannelId =
        target.kind === "conversation" ? target.channelId : undefined;
      const captured = captureVoiceThingFromElement(elements[0], {
        session: currentRelay.session,
        resolveName,
        activeChannelId,
      });
      if (!captured) return;
      event.preventDefault();
      opened.current = undefined;
      setHovered(captured);
      setOpen(true);
    };
    window.addEventListener("auxclick", onAuxClick);
    return () => window.removeEventListener("auxclick", onAuxClick);
  }, [available, services, resolveName]);

  const close = useCallback(() => {
    setOpen(false);
    // Focus moved by the box itself, and returned on close, isn't the
    // person's: a resting pointer still decides the next hover.
    pointerRef.current?.forgetFocus();
  }, []);
  // The hint follows the person's rebind, as Search's does.
  const { overrides } = useSyncExternalStore(
    services?.shortcutBindings?.subscribe ?? noSubscribe,
    services?.shortcutBindings?.snapshot ?? noOverrides,
  );
  const binding = overrides[VOICE_JUMP_ID] ?? VOICE_JUMP_BINDING;
  if (!services || !decisions || !available) return null;
  const label = `Jump or act by voice (${formatBinding(binding, isApplePlatform(navigator.platform)).text})`;
  return (
    <>
      <IconButton
        data-shell-voice-jump=""
        variant="ghost"
        shape="round"
        aria-label="Jump or act by voice"
        title={label}
        aria-pressed={open}
        icon={<MicrophoneIcon size={16} aria-hidden="true" />}
        onClick={() => {
          opened.current = undefined;
          setHovered(captureHovered());
          setOpen(true);
        }}
      />
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title="Jump or act by voice"
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
            voiceBackend={voiceBackend}
            denied={denied}
            onAccess={setDenied}
            initialHovered={hovered}
            input={input}
            again={again}
            stopEarly={stopEarly}
            go={(place) => {
              opened.current = place.channelId;
              close();
            }}
            onDone={() => close()}
          />
        )}
      </Dialog>
    </>
  );
}

export function VoiceJumpBody({
  services,
  decisions,
  voiceBackend,
  denied,
  onAccess,
  initialHovered = NOTHING,
  input,
  again,
  stopEarly,
  go,
  onDone,
}: {
  services: VoiceJumpServices;
  decisions: Decisions;
  voiceBackend: VoiceBackend | null;
  /** Why microphone or speech access was denied this session, if it was. */
  denied?: string | undefined;
  /** Records a denial's message, or clears it once listening works. */
  onAccess?: ((denied: string | undefined) => void) | undefined;
  initialHovered?: VoiceThing | undefined;
  input: RefObject<HTMLElement | null>;
  again: { current: (() => void) | undefined };
  stopEarly?: { current: (() => void) | undefined } | undefined;
  go: (place: JumpPlace) => void;
  onDone: () => void;
}) {
  const voiceAvailable = voiceBackend !== null;
  const notify = useToastNotification();
  const channelNavigation = useChannelNavigation();
  const relay = useSyncExternalStore(
    services.communities.relay.subscribe,
    services.communities.relay.snapshot,
  );
  const session = relay.session;
  const resolveName = useIdentityNames(session.names);
  const [hovered, setHovered] = useState<VoiceThing>(initialHovered);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "listening" });
  // The likeliest actions and places for the words so far, refined as words land.
  const [candidates, setCandidates] = useState<readonly JumpCandidate[]>([]);
  const [actionCandidates, setActionCandidates] = useState<
    readonly ActionCandidate[]
  >([]);

  // Ensure sidebar preferences are available and warm Decisions connection on open.
  useEffect(() => {
    void session.sidebarPreferences.ensure();
    if (decisions.status?.() === "ready") {
      const client = services.communities.snapshot();
      const community = client.selected
        ? communityDestination(client.selected).url
        : undefined;
      void decisions
        .decide({
          state: "{}",
          questions: { warm: { type: "yes_no", instructions: "ok" } },
          timeoutMs: 2_000,
          ...(community ? { community } : {}),
        })
        .catch(() => {});
    }
  }, [session, decisions, services.communities]);

  // Each listen or edit starts a new epoch; answers from an older one are
  // dropped. Within one, answers are kept by text, so the final check reuses
  // the live check of the same words.
  const run = useRef<{
    epoch: number;
    places?: JumpPlace[];
    entities?: VoiceSlotEntities;
    answers: Map<string, Promise<VoiceActionDecisionOutcome>>;
    live: boolean;
    pending?: string | undefined;
    lead?: LiveLead | undefined;
    actionLead?: LiveActionLead | undefined;
    /** The newest words heard or typed; a pause's answer for older words
     * never shows a chip over them. */
    latest?: string | undefined;
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

  const buildContext = (
    communityOrigin: string | undefined,
    scope: ReturnType<typeof scopeNow>,
  ): VoiceActionContext => {
    const navTarget = services.navigation.snapshot().entry.target;
    const activeChannelId =
      navTarget.kind === "conversation"
        ? navTarget.channelId
        : hovered.kind === "nothing"
          ? hovered.activeChannelId
          : undefined;
    return {
      session,
      hovered,
      resolveName,
      community: communityOrigin,
      scope,
      activeChannelId,
      ...(channelNavigation
        ? {
            channelNavigation: {
              mute: channelNavigation.mute,
              openLifecycle: (channel, action) =>
                channelNavigation.openLifecycle(channel, action),
            },
          }
        : {}),
    };
  };

  const ask = (
    said: string,
    community: string,
    scope: ReturnType<typeof scopeNow>,
  ) => {
    const current = run.current;
    current.places ??= jumpPlaces(sources(session, resolveName));
    current.entities ??= sessionVoiceEntities(session, resolveName);
    let answer = current.answers.get(said);
    if (!answer) {
      const ctx = buildContext(community, scope);
      const bindings = matchSessionActionBindings(
        VOICE_ACTIONS,
        ctx,
        current.entities,
      );
      // Threshold 0: the caller decides how sure is sure enough.
      answer = decideVoiceAction(
        decisions,
        {
          spoken: said,
          hovered,
          actions: VOICE_ACTIONS,
          entities: current.entities,
          places: current.places,
          community,
          bindings,
        },
        0,
      );
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

  const show = (result: VoiceActionDecisionOutcome) => {
    if (result.kind !== "failed") {
      setCandidates(result.placeCandidates);
      setActionCandidates(result.actionCandidates);
    }
  };

  const runAction = async (resolved: ResolvedActionMatch, spoken: string) => {
    const current = run.current;
    const scope = scopeNow();
    if (current.done || !scope) return;
    const action = resolved.binding.action as AppVoiceAction;
    const ctx = buildContext(scope.communityOrigin, scope);
    const invocation = {
      ctx,
      ...(resolved.owner ? { owner: resolved.owner } : {}),
      ...(resolved.target ? { target: resolved.target } : {}),
      ...(resolved.text !== undefined ? { text: resolved.text } : {}),
      spoken,
    };
    const summaryText = action.summary(invocation);
    current.done = true;
    setPhase({ kind: "running", summary: summaryText });
    try {
      await action.run(invocation, {
        navigation: services.navigation,
        communities: services.communities,
        ...(channelNavigation
          ? {
              channelNavigation: {
                mute: channelNavigation.mute,
                openLifecycle: (channel, action) =>
                  channelNavigation.openLifecycle(channel, action),
              },
            }
          : {}),
        notify,
      });
      if (run.current !== current) return;
      onDone();
    } catch (error) {
      if (run.current !== current) return;
      current.done = false;
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't complete that action. Try again.";
      setPhase({ kind: "failed", message });
    }
  };

  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;

  /** While words are still landing: one check at a time, always on the
   * newest words. Confirm-gated actions never execute on partial speech. */
  const live = (said: string) => {
    const current = run.current;
    const scope = scopeNow();
    if (current.done || !scope || !said.trim()) return;
    if (current.live) {
      current.pending = said;
      return;
    }
    current.live = true;
    void ask(said, scope.communityOrigin, scope).then((result) => {
      if (run.current !== current || current.done) return;
      current.live = false;
      show(result);

      if (result.kind === "navigate") {
        const held = holdsLead(
          current.lead,
          {
            outcome: "found",
            place: result.place,
            probability: result.probability,
            candidates: result.placeCandidates,
          },
          said,
          current.places ?? [],
        );
        current.lead = held.lead;
        current.actionLead = undefined;
        if (held.jump) return goTo(result.place);
      } else if (result.kind === "action") {
        current.lead = undefined;
        const heldAction = holdsActionLead(
          current.actionLead,
          result,
          said,
          current.entities ?? {},
        );
        current.actionLead = heldAction.lead;
        if (heldAction.fire) {
          return void runActionRef.current(result, said);
        }
      } else {
        current.lead = undefined;
        current.actionLead = undefined;
      }

      const next = current.pending;
      current.pending = undefined;
      if (next !== undefined && next !== said) live(next);
    });
  };

  /** A short pause in speech: auto-run if >= 0.7 (no confirm), confirm if
   * >= 0.5 (confirm-gated), or navigate if >= 0.5; otherwise keep listening. */
  const settle = (said: string) => {
    const current = run.current;
    const scope = scopeNow();
    if (current.done || !scope || !said.trim()) return;
    // A pause is on the newest words; anything heard or typed after it wins.
    current.latest = said;
    void ask(said, scope.communityOrigin, scope).then((result) => {
      if (run.current !== current || current.done || current.latest !== said)
        return;
      show(result);
      if (
        result.kind === "navigate" &&
        result.probability >= VOICE_JUMP_THRESHOLD
      ) {
        goTo(result.place);
      } else if (result.kind === "action") {
        if (result.binding.missingSlot === "text" && !result.text?.trim()) {
          return;
        }
        const needed =
          result.binding.action.confirm === "none"
            ? VOICE_ACTION_AUTO_THRESHOLD
            : VOICE_ACTION_THRESHOLD;
        if (result.probability < needed) return;
        if (result.binding.action.confirm === "confirm") {
          setPhase({ kind: "confirm", resolved: result, spoken: said });
        } else {
          void runActionRef.current(result, said);
        }
      }
    });
  };

  /** Once speech ends or Enter is pressed: apply the same single decision rule. */
  const submit = (spoken: string) => {
    const said = spoken.trim();
    if (!said) return setPhase({ kind: "none", text: "" });
    const scope = scopeNow();
    if (!scope)
      return setPhase({
        kind: "failed",
        message: "Choose a community to jump or run voice actions.",
      });
    const current = run.current;
    if (current.done) return;
    current.latest = said;
    setPhase({ kind: "matching" });
    void ask(said, scope.communityOrigin, scope).then((result) => {
      if (run.current !== current || current.done) return;
      show(result);
      if (
        result.kind === "navigate" &&
        result.probability >= VOICE_JUMP_THRESHOLD
      ) {
        goTo(result.place);
      } else if (result.kind === "action") {
        if (result.binding.missingSlot === "text" && !result.text?.trim()) {
          setPhase({ kind: "none", text: said });
          return;
        }
        const needed =
          result.binding.action.confirm === "none"
            ? VOICE_ACTION_AUTO_THRESHOLD
            : VOICE_ACTION_THRESHOLD;
        if (result.probability < needed) {
          setPhase({ kind: "none", text: said });
          return;
        }
        if (result.binding.action.confirm === "confirm") {
          setPhase({ kind: "confirm", resolved: result, spoken: said });
        } else {
          void runActionRef.current(result, said);
        }
      } else if (result.kind !== "failed") {
        setPhase({ kind: "none", text: said });
      } else {
        setPhase({
          kind: "failed",
          message:
            result.reason === "missing_credentials" ||
            result.reason === "unauthorized" ||
            result.reason === "unavailable"
              ? "Set up the Decisions API in Settings to use voice actions."
              : "Couldn't match that just now. Try again.",
        });
      }
    });
  };

  const submitRef = useRef(submit);
  submitRef.current = submit;

  const dictation = useVoiceDictation({
    backend: voiceBackend,
    onText: (next) => {
      run.current.latest = next;
      setPhase({ kind: "listening" });
      setText(next);
      // The dictation hook keeps the newest callbacks, so this is current.
      live(next);
    },
    onPause: (spoken) => settle(spoken),
    onEnd: (spoken) => submitRef.current(spoken),
    onError: (message, failure) => {
      if (failure === "denied") onAccess?.(message);
      setPhase({ kind: "failed", message });
    },
  });
  const { start, stop, cancel } = dictation;

  const listen = useCallback(() => {
    restart();
    // Both recognizers use the same place and people context for decisions.
    const places = jumpPlaces(sources(session, resolveName));
    run.current.places = places;
    setCandidates([]);
    setActionCandidates([]);
    setText("");
    setPhase({ kind: "listening" });
    void start(voiceBackend === "apple" ? voiceHints(places) : undefined);
  }, [restart, start, session, resolveName, voiceBackend]);

  // Listening starts as the box opens when speech recognition is available.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Once per opening.
  useEffect(() => {
    if (voiceAvailable && !denied) listen();
  }, []);

  const listening = dictation.state !== "idle";
  // Listening started, so access was allowed after all.
  useEffect(() => {
    if (dictation.state === "listening" && denied) onAccess?.(undefined);
  }, [dictation.state, denied, onAccess]);
  useEffect(() => {
    if (!voiceAvailable) return;
    again.current = () => (listening ? stop() : listen());
    if (stopEarly) stopEarly.current = listening ? stop : undefined;
    return () => {
      again.current = undefined;
      if (stopEarly) stopEarly.current = undefined;
    };
  }, [again, stopEarly, listening, stop, listen, voiceAvailable]);

  const runnableActions = actionCandidates.flatMap((candidate) => {
    if (candidate.kind !== "action" || !candidate.binding) return [];
    const { binding } = candidate;
    if (binding.missingSlot === "text" && !candidate.text?.trim()) return [];
    if (
      binding.missingSlot &&
      binding.missingSlot !== "text" &&
      !(binding.hoveredRole === "target" ? candidate.owner : candidate.target)
    ) {
      return [];
    }
    const action = binding.action as AppVoiceAction;
    const scope = scopeNow();
    const ctx = buildContext(scope?.communityOrigin, scope);
    const label = action.summary({
      ctx,
      ...(candidate.owner ? { owner: candidate.owner } : {}),
      ...(candidate.target ? { target: candidate.target } : {}),
      ...(candidate.text !== undefined ? { text: candidate.text } : {}),
      spoken: text,
    });
    const resolved: ResolvedActionMatch = {
      kind: "action",
      actionId: binding.action.id,
      binding,
      probability: candidate.probability,
      ...(candidate.owner ? { owner: candidate.owner } : {}),
      ...(candidate.target ? { target: candidate.target } : {}),
      ...(candidate.text !== undefined ? { text: candidate.text } : {}),
      actionCandidates,
      placeCandidates: candidates,
    };
    return [{ candidate, resolved, label }];
  });

  const needsName =
    actionCandidates[0]?.binding?.missingSlot === "text" &&
    actionCandidates[0].probability >= VOICE_ACTION_AUTO_THRESHOLD;

  const confirmDetails =
    phase.kind === "confirm"
      ? (() => {
          const action = phase.resolved.binding.action as AppVoiceAction;
          const scope = scopeNow();
          const ctx = buildContext(scope?.communityOrigin, scope);
          return action.summary({
            ctx,
            ...(phase.resolved.owner ? { owner: phase.resolved.owner } : {}),
            ...(phase.resolved.target ? { target: phase.resolved.target } : {}),
            ...(phase.resolved.text !== undefined
              ? { text: phase.resolved.text }
              : {}),
            spoken: phase.spoken,
          });
        })()
      : undefined;

  const status =
    phase.kind === "running" ? (
      <ShimmerText>{phase.summary}…</ShimmerText>
    ) : phase.kind === "matching" ? (
      <ShimmerText>Finding it…</ShimmerText>
    ) : phase.kind === "failed" ? (
      phase.message
    ) : dictation.state === "downloading" ? (
      <ShimmerText>Downloading speech model…</ShimmerText>
    ) : dictation.state === "starting" ? (
      <ShimmerText>Starting the microphone…</ShimmerText>
    ) : listening ? (
      hovered.kind !== "nothing" ? (
        <ShimmerText>Listening. Say an action or where to go.</ShimmerText>
      ) : (
        <ShimmerText>Listening. Say where to go.</ShimmerText>
      )
    ) : denied ? (
      denied
    ) : voiceAvailable ? (
      "Press Enter to go, or the microphone to speak again."
    ) : (
      "Type an action or destination, then press Enter."
    );

  return (
    <div className={styles.body}>
      <SearchField
        variant="palette"
        label={
          hovered.kind !== "nothing" ? "Action or destination" : "Where to"
        }
        placeholder={
          hovered.kind !== "nothing"
            ? `Say an action for ${hovered.label}, or a place to jump`
            : "Say a channel, person, chat or thread"
        }
        inputRef={input}
        value={text}
        onValueChange={(next) => {
          // Typing takes over from the microphone.
          cancel();
          restart();
          setCandidates([]);
          setActionCandidates([]);
          setPhase({ kind: "listening" });
          setText(next);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (phase.kind === "confirm") {
            cancel();
            void runActionRef.current(phase.resolved, phase.spoken);
            return;
          }
          cancel();
          submit(text);
        }}
        trailing={
          voiceAvailable ? (
            <IconButton
              variant={listening ? "tint" : "ghost"}
              aria-label={listening ? "Stop listening" : "Speak again"}
              aria-pressed={listening}
              title={listening ? "Stop listening" : "Speak again"}
              loading={
                dictation.state === "starting" ||
                dictation.state === "downloading"
              }
              icon={<MicrophoneIcon size={16} aria-hidden="true" />}
              onClick={() => {
                if (listening) stop();
                else listen();
                input.current?.focus();
              }}
            />
          ) : undefined
        }
      />

      {hovered.kind !== "nothing" && (
        <div className={styles.contextBar} data-voice-context={hovered.kind}>
          <span className={styles.contextTarget}>
            <SparklesIcon size={14} aria-hidden="true" />
            <span>Context:</span>
            <ValueChip title={hovered.label}>{hovered.label}</ValueChip>
          </span>
          <IconButton
            size="compact"
            variant="ghost"
            aria-label="Clear hovered context"
            title="Ignore hovered item"
            icon={<XIcon size={14} aria-hidden="true" />}
            onClick={() => {
              restart();
              setHovered(NOTHING);
              setPhase({ kind: "listening" });
              input.current?.focus();
            }}
          />
        </div>
      )}

      {phase.kind === "confirm" && confirmDetails ? (
        <section
          className={styles.confirmBar}
          aria-label="Confirm voice action"
        >
          <div className={styles.confirmCopy}>
            <p className={styles.confirmTitle}>{confirmDetails}</p>
            <p className={styles.confirmHint}>
              Confirm before running this action.
            </p>
          </div>
          <div className={styles.confirmActions}>
            <Button size="sm" variant="subtle" onClick={onDone}>
              Cancel <KeyboardShortcut text="Esc" label="Escape" />
            </Button>
            <Button
              size="sm"
              variant="prominent"
              onClick={() => {
                cancel();
                void runActionRef.current(phase.resolved, phase.spoken);
              }}
            >
              Confirm <KeyboardShortcut text="Enter" label="Enter" />
            </Button>
          </div>
        </section>
      ) : phase.kind === "none" &&
        !candidates.length &&
        !runnableActions.length ? (
        <EmptyState
          frame="none"
          icon={<MicrophoneIcon size={20} />}
          title={needsName ? "Say the section's name" : "Didn't find anything"}
          description={
            needsName
              ? "Try saying the name you want to use, for example “create a section called Work”."
              : phase.text
                ? `Nothing matched “${phase.text}”. Try an action name or a channel, person or chat.`
                : "Didn't catch that. Try saying an action or a channel, person or chat name."
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
            // Close but not sure enough: the nearest actions/places stay to choose.
            <div className={styles.notice}>
              <p className={styles.status} aria-live="polite">
                {needsName
                  ? "Say the section's name, or pick an option:"
                  : "Not sure enough to act automatically. Closest options:"}
              </p>
              <Button size="sm" variant="subtle" onClick={listen}>
                Try again
              </Button>
            </div>
          )}
          {phase.kind !== "failed" && runnableActions.length > 0 && (
            <ul className={styles.candidates} aria-label="Likeliest actions">
              {runnableActions.map(({ candidate, resolved, label }) => (
                <li
                  key={`${candidate.actionId ?? candidate.label}:${candidate.owner?.id ?? ""}:${candidate.target?.id ?? ""}`}
                >
                  <NavigationItem
                    variant="search"
                    icon={
                      <span
                        className="search-peek-tile"
                        data-tone="agent"
                        aria-hidden="true"
                      >
                        <SparklesIcon size={15} />
                      </span>
                    }
                    label={
                      <span className="block truncate text-body-sm">
                        {label}
                      </span>
                    }
                    trailing={
                      <span className="text-body-sm tabular-nums">
                        {Math.round(candidate.probability * 100)}%
                        <span className="sr-only"> match score</span>
                      </span>
                    }
                    onClick={() => {
                      cancel();
                      if (resolved.binding.action.confirm === "confirm") {
                        setPhase({
                          kind: "confirm",
                          resolved,
                          spoken: text,
                        });
                      } else {
                        void runActionRef.current(resolved, text);
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
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
