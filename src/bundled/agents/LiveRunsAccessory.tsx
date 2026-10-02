import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import type {
  LiveRunView,
  LiveRuns,
  LiveStepView,
  StepKind,
} from "../../features/agent-types/live";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import { selectProfiles } from "../../features/relay/profile-selection";
import {
  CaretRightIcon,
  ChatCircleIcon,
  EyeIcon,
  LightbulbIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TerminalWindowIcon,
  WrenchIcon,
} from "../../shared/design-system/icons/index";
import styles from "./LiveRunsAccessory.module.css";

/** Steps shown before the earlier ones fold into "N previous steps". */
const RECENT = 4;
/** The host's icon and wording for each kind; a type's `label` replaces `noun`. */
const kinds: Record<
  StepKind,
  { Icon: typeof EyeIcon; running: string; done: string; noun?: string }
> = {
  thinking: { Icon: LightbulbIcon, running: "Thinking", done: "Thought" },
  message: { Icon: ChatCircleIcon, running: "Replying", done: "Replied" },
  command: {
    Icon: TerminalWindowIcon,
    running: "Running",
    done: "Ran",
    noun: "command",
  },
  read: { Icon: EyeIcon, running: "Reading", done: "Read" },
  write: { Icon: PencilSimpleIcon, running: "Writing", done: "Wrote" },
  search: { Icon: MagnifyingGlassIcon, running: "Searching", done: "Searched" },
  tool: { Icon: WrenchIcon, running: "Using", done: "Used", noun: "tool" },
};

function wording(step: LiveStepView) {
  const kind = kinds[step.kind];
  const running = step.state === "running";
  const text = [running ? kind.running : kind.done, step.label ?? kind.noun]
    .filter(Boolean)
    .join(" ");
  return running ? `${text}…` : text;
}

/** Plugin agents' runs in progress for this composer's conversation, as their
 * steps arrive. Local to this window: the relay carries only what a run publishes. */
export function LiveRunsAccessory({
  runs,
  session,
  channelId,
  threadRootId,
}: ComposerAccessoryProps & { runs: LiveRuns }) {
  const all = useSyncExternalStore(
    runs.subscribe,
    runs.snapshot,
    runs.snapshot,
  );
  // A thread shows the runs replying into it. The channel shows the runs whose
  // event is in its own timeline, so a run appears where its event does.
  const shown = all.filter(
    (run) =>
      run.channelId === channelId &&
      run.threadRootId === (threadRootId ?? run.eventId) &&
      visible(run).length,
  );
  const box = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  // Streamed text grows the newest row; follow it unless the reader scrolled up.
  useLayoutEffect(() => {
    const element = box.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });
  if (!shown.length) return null;
  return (
    <section
      ref={box}
      className={`${styles.root} text-body-sm`}
      data-buzz-ui=""
      aria-label={
        threadRootId
          ? "Agent runs in this thread"
          : "Agent runs in this channel"
      }
      onScroll={({ currentTarget: element }) => {
        pinned.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {shown.map((run) => (
        <Run
          key={run.id}
          run={run}
          session={session}
          // Opening the earlier steps is a request to read them, not the newest.
          onExpand={() => {
            pinned.current = false;
          }}
        />
      ))}
    </section>
  );
}

/** A published reply is already in the timeline as the real message. */
const visible = (run: LiveRunView) =>
  run.steps.filter((step) => !step.published);

function Run({
  run,
  session,
  onExpand,
}: {
  run: LiveRunView;
  session: ComposerAccessoryProps["session"];
  onExpand(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { pubkey, name } = run.agent;
  useEffect(() => {
    void session.profiles.ensure([pubkey], "background").catch(() => {});
  }, [session.profiles, pubkey]);
  const profiles = useMemo(
    () => selectProfiles(session.profiles, [pubkey]),
    [session.profiles, pubkey],
  );
  const picture = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
    profiles.snapshot,
  ).get(pubkey)?.picture;
  const steps = visible(run);
  const earlier = Math.max(0, steps.length - RECENT);
  return (
    <article className={styles.run} aria-label={`${name} is working`}>
      <AgentAvatar
        working
        src={picture ? (session.media(picture) ?? null) : null}
        alt=""
        fallback={name}
        size="small"
        shape="squircle"
      />
      <div className={styles.body}>
        {earlier ? (
          <button
            type="button"
            className={styles.earlier}
            aria-expanded={expanded}
            onClick={() => {
              if (!expanded) onExpand();
              setExpanded(!expanded);
            }}
          >
            {earlier} previous {earlier === 1 ? "step" : "steps"}
            <CaretRightIcon size={14} aria-hidden="true" />
          </button>
        ) : null}
        <ol className={styles.steps}>
          {(expanded ? steps : steps.slice(earlier)).map((step) => {
            const { Icon } = kinds[step.kind];
            return (
              <li key={step.id} className={styles.step} data-state={step.state}>
                <Icon size={16} aria-hidden="true" className={styles.icon} />
                <span className={styles.text}>
                  {step.text || wording(step)}
                  {step.error ? (
                    <span className={styles.error}>{step.error}</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </article>
  );
}
