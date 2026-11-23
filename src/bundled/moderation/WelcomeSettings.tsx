import {
  Fragment,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import {
  communityRequest,
  type CommunityInfo,
} from "../../features/communities/api";
import type { CommunityReader } from "../../features/communities/service";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  DEFAULT_WELCOME_MESSAGE,
  useDefaultWelcomeTitle,
} from "../../features/communities/WelcomeCard";
import { channelIcon } from "../../features/channels/channel-icon";
import { useChannelDirectory } from "../../features/channels/useChannelDirectory";
import { ChannelLifecycleUnconfirmed } from "../../features/relay/channel-lifecycle";
import type { WelcomeCommand } from "../../features/relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../../features/relay/contracts";
import { communityFromScope } from "../../features/relay/gifs";
import {
  normalizeWelcome,
  WELCOME_MAX_LENGTH,
  WELCOME_TITLE_MAX_LENGTH,
  welcomeTextProblem,
  welcomeTitleProblem,
} from "../../features/relay/landing";
import { PublishNotSent, PublishRejected } from "../../features/relay/outbox";
import {
  useChannelRoster,
  useRelayConnection,
} from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { matchName } from "../../features/search/match";
import { flushSync } from "react-dom";
import { Button } from "../../shared/design-system/ui/Button";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { Field } from "../../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { WelcomeMessageEditor } from "./WelcomeMessageEditor";
import styles from "./WelcomeSettings.module.css";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
const MAX = WELCOME_MAX_LENGTH.toLocaleString("en-US");
const TITLE_MAX = WELCOME_TITLE_MAX_LENGTH.toLocaleString("en-US");
// Every listed channel is an open stream, so each shows the public icon.
const ChannelIcon = channelIcon({ channelType: "stream" });

/**
 * The default message is never stored: a draft matching it restores it. The
 * default title depends on the viewer, so it is never inferred: an untouched
 * title resends what is published, Restore defaults (`null`) sends the
 * default, and an edited title is sent as written.
 */
function commandFor(
  draft: Readonly<{ text: string; title?: string | null }>,
  publishedTitle: string,
): WelcomeCommand {
  const text = normalizeWelcome(draft.text);
  return {
    message: text === DEFAULT_WELCOME_MESSAGE ? "" : text,
    title:
      draft.title === undefined
        ? publishedTitle
        : draft.title === null
          ? ""
          : draft.title.trim(),
  };
}

/** What a definite failure means for the draft, which is always kept. */
function saveError(error: unknown) {
  if (error instanceof PublishNotSent) return "Not sent. Try again.";
  if (error instanceof PublishRejected) {
    const reason = error.reason?.replace(/^invalid:\s*/, "").trim();
    return reason
      ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}`
      : "Only community owners and admins can change this.";
  }
  return message(error);
}

const bidi = "Remove the hidden text-direction characters.";
const problems = {
  empty: "Enter a welcome message, or restore the defaults.",
  bidi,
  long: `Shorten the message to ${MAX} characters.`,
  control: "Remove control characters. Line breaks and tabs are fine.",
};
const titleProblems = {
  empty: "Enter a title, or restore the defaults.",
  bidi,
  long: `Shorten the title to ${TITLE_MAX} characters.`,
  control: "Use one line of text for the title.",
};

/** Community settings: where new members start, what they read there, and
 * which other channels they join. */
export function WelcomeSettings({
  relay,
  communities,
  active,
  extensions,
}: {
  relay: RelayData;
  /** Names the community in the default title. */
  communities?: CommunityReader | undefined;
  active(): boolean;
  /** Presents pasted links in the message editor as messages show them. */
  extensions?: ConversationExtensions | undefined;
}) {
  const connection = useRelayConnection(relay);
  const community =
    connection.status === "ready" && connection.scope
      ? communityFromScope(connection.scope)
      : null;
  return (
    <section aria-labelledby="welcome-settings-title">
      <Header
        id="welcome-settings-title"
        title="Welcome"
        subtitle="Choose the channel new members join and open first, the message they see there, and the other channels they join."
      />
      {community && connection.scope ? (
        <WelcomeEditor
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          scope={connection.scope}
          community={community}
          communities={communities}
          active={active}
          extensions={extensions}
        />
      ) : (
        <p role="status">Choose a connected community to set its welcome.</p>
      )}
    </section>
  );
}

/** The relay's current designation; `welcome` and `title` are `""` for the
 * defaults. */
type Published = Readonly<{
  channelId?: string;
  name?: string;
  welcome: string;
  title: string;
}>;
type Load =
  | { status: "loading" }
  | { status: "ready"; published: Published }
  | { status: "unsupported" }
  | { status: "error"; error: string };
type Option = Readonly<{
  id: string;
  name: string;
  /** Published: a joined channel's follows the roster, another's the
   * directory, and both take a confirmed change at once. */
  autoJoin: boolean;
  /** In the viewer's roster, which follows the relay's metadata. */
  joined: boolean;
}>;
/** `title` is absent until edited; `null` once Restore defaults is pressed. */
type Draft = Readonly<{
  channelId?: string;
  text: string;
  title?: string | null;
}>;
/** One starter flag Save sets. */
type StarterStep = Readonly<{ id: string; name: string; enabled: boolean }>;
/** Drafted starter flags by channel; Save sets each that differs from the
 * published one. */
type StarterDraft = ReadonlyMap<string, boolean>;

/** Browsing with no search lists this many channels by name; a search covers
 * every channel, so a community with thousands still opens a short list. */
const BROWSE_LIMIT = 50;

/** The options whose names match `needle`, best first; for no needle, the
 * first {@link BROWSE_LIMIT} by name. */
function ranked(options: readonly Option[], needle: string) {
  if (!needle) return options.slice(0, BROWSE_LIMIT);
  return options
    .flatMap((option) => {
      const rank = matchName(option.name, needle)?.rank;
      return rank === undefined ? [] : [{ option, rank }];
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ option }) => option);
}

/** Follows the results of a browse that {@link ranked} cut short. Like the
 * popup's empty line it stays mounted while the popup is open, so clearing a
 * search announces it. */
function BrowseLimit({ capped }: { capped: boolean }) {
  return (
    <div role="status" className="buzz-combobox-empty">
      {capped
        ? `Showing the first ${BROWSE_LIMIT} channels. Type a name to find more.`
        : null}
    </div>
  );
}

/** Open, active stream channels: the directory's, joined ones it may leave
 * out (such as unlisted ones), and the current welcome channel. The joined
 * list is live, so its flags win. */
function eligibleChannels(
  directory: ReturnType<typeof useChannelDirectory>["directory"],
  joined: readonly ChannelSummary[],
  current: Published | undefined,
) {
  const rows = new Map<string, Option>();
  for (const channel of directory)
    if (channel.channelType === "stream" && !channel.archived)
      rows.set(channel.id, {
        id: channel.id,
        name: channel.name,
        autoJoin: !!channel.autoJoin,
        joined: false,
      });
  for (const channel of joined)
    if (
      channel.channelType === "stream" &&
      channel.visibility === "public" &&
      !channel.archived &&
      !channel.huddle
    )
      rows.set(channel.id, {
        id: channel.id,
        name: channel.name,
        autoJoin: !!channel.autoJoin,
        joined: true,
      });
  const id = current?.channelId;
  if (id && !rows.has(id))
    rows.set(id, {
      id,
      name: current.name ?? id.slice(0, 8),
      autoJoin: false,
      joined: false,
    });
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The Check again button leaves with its notice; focus stays in the form,
 * on the first of `targets` shown. */
function stayInForm(
  check: HTMLElement | null,
  ...targets: readonly (HTMLElement | null)[]
) {
  if (document.activeElement === check)
    targets.find(Boolean)?.focus({ preventScroll: true });
}

const without = <T,>(map: ReadonlyMap<string, T>, id: string) => {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
};

function WelcomeEditor({
  session,
  scope,
  community,
  communities,
  active,
  extensions,
}: {
  session: RelaySession;
  scope: string;
  community: string;
  communities: CommunityReader | undefined;
  active(): boolean;
  extensions: ConversationExtensions | undefined;
}) {
  const lifecycle = session.channelLifecycle;
  const defaultTitle = useDefaultWelcomeTitle(communities, scope);
  const formId = useId();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [draft, setDraft] = useState<Draft>();
  const [starterDraft, setStarterDraft] = useState<StarterDraft>(
    () => new Map(),
  );
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // A failed starter step's reason: a removal's beside its row, an addition's
  // on the add control, since its row is gone.
  const [starterErrors, setStarterErrors] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [addError, setAddError] =
    useState<Readonly<{ id: string; message: string }>>();
  // An unconfirmed publication, of the welcome or of one starter flag: only a
  // fresh read, never a repeat, settles it.
  const [unconfirmed, setUnconfirmed] = useState<"welcome" | StarterStep>();
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  // Starter edits change the list without moving focus; this tells of them.
  const [announcement, setAnnouncement] = useState("");
  // Cleared first, so the same words said twice are heard twice.
  const announce = (text: string) => {
    flushSync(() => setAnnouncement(""));
    setAnnouncement(text);
  };
  // The check compares the relay's answer with the draft as it stands then.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The starter steps Save would run, for a check deciding whether all landed.
  const pendingSteps = useRef<readonly StarterStep[]>([]);
  const checkButton = useRef<HTMLButtonElement>(null);
  const channelInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<ComposerInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const actionsRow = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const saveController = useRef<AbortController>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      saveController.current?.abort();
    };
  }, []);
  // Each open reads the live designation, then its signed welcome.
  useEffect(() => {
    const reading = new AbortController();
    // A check keeps the published form in view; only the first read waits.
    const check = attempt > 0;
    setLoad((current) =>
      check && current.status === "ready" ? current : { status: "loading" },
    );
    void (async () => {
      try {
        const info = await communityRequest<CommunityInfo>(
          community,
          "info",
          undefined,
          reading.signal,
        );
        reading.signal.throwIfAborted();
        if (!info.landingChannels) {
          setLoad({ status: "unsupported" });
          // The welcome can no longer be saved here, so its draft and an
          // unconfirmed save of it end with this read.
          setDraft(undefined);
          setUnconfirmed((current) =>
            current === "welcome" ? undefined : current,
          );
          setChecking(false);
          if (check) stayInForm(checkButton.current, addInput.current);
          return;
        }
        const id = info.landingChannel;
        const state = id
          ? await lifecycle.readLanding(id, reading.signal)
          : undefined;
        reading.signal.throwIfAborted();
        const published: Published = {
          ...(id && state ? { channelId: id } : {}),
          ...(state?.name ? { name: state.name } : {}),
          welcome: (state?.landing && state.welcome) || "",
          title: (state?.landing && state.welcomeTitle) || "",
        };
        // A draft the relay now shows has landed; there is nothing to save.
        const current = draftRef.current;
        const wanted = current && commandFor(current, published.title);
        const landed =
          !!wanted &&
          current?.channelId === published.channelId &&
          wanted.message === published.welcome &&
          wanted.title === published.title;
        setLoad({ status: "ready", published });
        if (landed) {
          setDraft(undefined);
          // Starter changes still wait for Save.
          if (!pendingSteps.current.length) setSaved(true);
        }
        setUnconfirmed(undefined);
        setChecking(false);
        if (check)
          stayInForm(
            checkButton.current,
            messageInput.current,
            addInput.current,
          );
      } catch (reason) {
        if (reading.signal.aborted) return;
        setChecking(false);
        setLoad({ status: "error", error: message(reason) });
      }
    })();
    return () => reading.abort();
  }, [community, lifecycle, attempt]);
  const published = load.status === "ready" ? load.published : undefined;
  const supported = load.status !== "unsupported";
  const listing = load.status === "ready" || !supported;
  const directory = useChannelDirectory(session.channels, listing);
  const roster = useChannelRoster(session.channels);
  const options = useMemo(
    () => eligibleChannels(directory.directory, roster.channels, published),
    [directory.directory, roster.channels, published],
  );
  const channelId = draft ? draft.channelId : published?.channelId;
  const text = draft?.text ?? (published?.welcome || DEFAULT_WELCOME_MESSAGE);
  const titleDraft = draft?.title;
  const title =
    typeof titleDraft === "string"
      ? titleDraft
      : titleDraft === null || !published?.title
        ? defaultTitle
        : published.title;
  const normalized = normalizeWelcome(text);
  const trimmedTitle = title.trim();
  const command = commandFor(
    { text, ...(titleDraft !== undefined ? { title: titleDraft } : {}) },
    published?.title ?? "",
  );
  const problem = welcomeTextProblem(normalized);
  // Only an edited title needs checking: a published one passed the relay, and
  // the default is never sent.
  const titleProblem =
    typeof titleDraft === "string"
      ? welcomeTitleProblem(trimmedTitle)
      : undefined;
  const welcomeDirty =
    !!published &&
    (channelId !== published.channelId ||
      command.message !== published.welcome ||
      command.title !== published.title);
  // The welcome channel's own flag is left as it is. A drafted flag the relay
  // already shows, as after a check, needs no step.
  const welcomeChannel = published?.channelId
    ? options.find((option) => option.id === published.channelId)
    : undefined;
  const steps = useMemo(
    () =>
      options.flatMap((option): StarterStep[] => {
        const enabled = starterDraft.get(option.id);
        return enabled === undefined ||
          enabled === option.autoJoin ||
          option.id === welcomeChannel?.id
          ? []
          : [{ id: option.id, name: option.name, enabled }];
      }),
    [options, starterDraft, welcomeChannel?.id],
  );
  pendingSteps.current = steps;
  const dirty = welcomeDirty || steps.length > 0;
  const invalid = welcomeDirty && (!channelId || !!problem || !!titleProblem);
  const selected = options.find((option) => option.id === channelId) ?? null;
  // The input shows the chosen name; browsing from there lists every channel.
  const needle = typed === selected?.name ? "" : typed.trim().toLowerCase();
  const matches = useMemo(() => ranked(options, needle), [options, needle]);
  const edit = (patch: Partial<Draft>) => {
    setDraft({
      ...(channelId ? { channelId } : {}),
      text,
      ...(titleDraft !== undefined ? { title: titleDraft } : {}),
      ...patch,
    });
    setSaved(false);
    setError("");
  };
  const editStarter = (channel: Option, enabled: boolean) => {
    // Back to the published flag: the drafted change is undone, not reversed.
    const undo = enabled === channel.autoJoin;
    setStarterDraft((current) =>
      undo
        ? without(current, channel.id)
        : new Map(current).set(channel.id, enabled),
    );
    setStarterErrors((current) => without(current, channel.id));
    if (enabled || addError?.id === channel.id) setAddError(undefined);
    announce(
      undo
        ? enabled
          ? `#${channel.name} stays a starter channel`
          : `#${channel.name} won’t be added`
        : `#${channel.name} will be ${enabled ? "added" : "removed"} when you save`,
    );
    setSaved(false);
    setError("");
  };
  // Cancel and Save take the action row away; focus on it rests on the
  // welcome channel field, or the add field where there is no welcome form.
  const restFocus = () =>
    (channelInput.current ?? addInput.current)?.focus({ preventScroll: true });
  const actionsShown = useRef(false);
  const isActive = () => mounted.current && active();
  // The welcome first, then each starter flag in turn. A confirmed step is
  // published; a refused one returns to its published state, where its reason
  // shows; the steps after it stay in the draft.
  const save = () => {
    if (saving || !dirty || invalid || unconfirmed || !lifecycle.available)
      return;
    const welcome =
      welcomeDirty && channelId
        ? {
            target: channelId,
            sent: command,
            name: options.find((option) => option.id === channelId)?.name,
          }
        : undefined;
    const pending = steps;
    const owner = new AbortController();
    saveController.current = owner;
    setSaving(true);
    setSaved(false);
    setError("");
    setStarterErrors(new Map());
    setAddError(undefined);
    setAnnouncement("");
    void (async () => {
      let step: StarterStep | undefined;
      try {
        if (welcome) {
          await lifecycle.setLanding(
            welcome.target,
            welcome.sent,
            owner.signal,
            isActive,
          );
          if (!mounted.current) return;
          setLoad({
            status: "ready",
            published: {
              channelId: welcome.target,
              ...(welcome.name ? { name: welcome.name } : {}),
              welcome: welcome.sent.message,
              title: welcome.sent.title,
            },
          });
          setDraft(undefined);
        }
        for (const next of pending) {
          step = next;
          await lifecycle.run(
            next.enabled ? "auto-join-on" : "auto-join-off",
            next.id,
            owner.signal,
            isActive,
          );
          if (!mounted.current) return;
          // The confirmed readback already updated the published flag.
          setStarterDraft((current) => without(current, next.id));
        }
        setSaved(true);
      } catch (reason) {
        if (!mounted.current || owner.signal.aborted) return;
        if (reason instanceof ChannelLifecycleUnconfirmed)
          setUnconfirmed(step ?? "welcome");
        else if (!step) setError(saveError(reason));
        else {
          const { id, enabled } = step;
          setStarterDraft((current) => without(current, id));
          if (enabled) {
            setAddError({ id, message: saveError(reason) });
            // The reason shows on the add field; focus from Save follows it.
            if (actionsRow.current?.contains(document.activeElement))
              addInput.current?.focus({ preventScroll: true });
          } else setStarterErrors(new Map([[id, saveError(reason)]]));
        }
      } finally {
        if (mounted.current) setSaving(false);
      }
    })();
  };
  // A starter step is checked by a strong read of its channel, which also
  // updates the published flag; the welcome, by reading the card again.
  const check = () => {
    setChecking(true);
    const step = unconfirmed;
    if (typeof step !== "object") {
      setAttempt((n) => n + 1);
      return;
    }
    const owner = new AbortController();
    saveController.current = owner;
    setError("");
    void (async () => {
      try {
        const state = await lifecycle.readLanding(step.id, owner.signal);
        if (!mounted.current) return;
        if (!!state?.autoJoin === step.enabled) {
          setStarterDraft((current) => without(current, step.id));
          if (
            !draftRef.current &&
            !pendingSteps.current.some(({ id }) => id !== step.id)
          )
            setSaved(true);
        }
        setUnconfirmed(undefined);
        stayInForm(checkButton.current, messageInput.current, addInput.current);
      } catch (reason) {
        if (!mounted.current || owner.signal.aborted) return;
        setError(message(reason));
      } finally {
        if (mounted.current) setChecking(false);
      }
    })();
  };
  const disabled = saving || !published || !lifecycle.available;
  const starters = (
    <StarterChannels
      channels={options}
      welcomeChannel={welcomeChannel}
      draft={starterDraft}
      onChange={editStarter}
      available={lifecycle.available}
      saving={saving}
      errors={starterErrors}
      addError={addError}
      addInput={addInput}
      loading={directory.loading}
      failed={!!directory.error}
      // The welcome form offers this retry when it is shown.
      retry={supported ? undefined : directory.retry}
    />
  );
  const actions = (draft !== undefined || steps.length > 0) && (
    <div
      ref={actionsRow}
      className="flex flex-wrap items-center justify-end gap-3"
    >
      <Button
        type="button"
        disabled={saving}
        onClick={() => {
          setDraft(undefined);
          setStarterDraft(new Map());
          setError("");
          setStarterErrors(new Map());
          setAddError(undefined);
          if (steps.length) announce("Starter changes discarded");
        }}
      >
        Cancel
      </Button>
      <Button
        // Save submits the welcome form, so Enter in a field saves too.
        {...(supported
          ? { type: "submit" as const, form: formId }
          : { type: "button" as const, onClick: save })}
        variant="primary"
        loading={saving}
        disabled={
          !dirty || invalid || !lifecycle.available || unconfirmed !== undefined
        }
      >
        Save
      </Button>
    </div>
  );
  const footer = (error || unconfirmed || actions) && (
    <div className={styles.fields}>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {unconfirmed && (
        <div role="alert" className={styles.unconfirmed}>
          <p className="error">
            Not confirmed yet. The relay hasn’t shown{" "}
            {unconfirmed === "welcome"
              ? "this change"
              : `the change to #${unconfirmed.name}`}
            ; check before saving again.
          </p>
          <div>
            <Button
              ref={checkButton}
              type="button"
              loading={checking}
              onClick={check}
            >
              Check again
            </Button>
          </div>
        </div>
      )}
      {actions}
    </div>
  );
  // A Save or Cancel that was focused leaves with the row; an element that
  // stays takes the focus, which would otherwise fall to the document.
  useLayoutEffect(() => {
    const shown = !!actions;
    if (
      actionsShown.current &&
      !shown &&
      (!document.activeElement || document.activeElement === document.body)
    )
      restFocus();
    actionsShown.current = shown;
  });
  const toast = saved && (
    <ToastNotice
      title="Welcome saved"
      tone="success"
      timeout={5000}
      onDismiss={() => setSaved(false)}
    />
  );
  const status = (
    <p role="status" className="sr-only">
      {announcement}
    </p>
  );
  return (
    <LoadingRegion
      pending={load.status === "loading"}
      label="Loading welcome settings…"
      feedback={
        load.status === "error" ? (
          <div>
            <p role="alert" className="error">
              Welcome settings couldn’t be loaded. {load.error}
            </p>
            <Button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Retry loading welcome settings
            </Button>
          </div>
        ) : load.status === "unsupported" ? (
          <p role="status">
            This community’s relay doesn’t support a welcome channel.
          </p>
        ) : undefined
      }
    >
      {/* One container either way, so the starter list, its live region and
          their focus survive the relay's support changing on a re-read. */}
      <div
        className={styles.editor}
        data-placeholder={(supported && !published) || undefined}
        inert={supported && !published}
        aria-hidden={(supported && !published) || undefined}
      >
        {supported && (
          <SettingsGroup layout="form">
            <form
              id={formId}
              className={styles.fields}
              onSubmit={(event) => {
                event.preventDefault();
                if (!disabled) save();
              }}
            >
              <Combobox.Root<Option>
                items={options}
                filteredItems={matches}
                // Until something is typed, a field showing the chosen name
                // lists `items` instead of `filteredItems`; cap that browse too.
                limit={BROWSE_LIMIT}
                value={selected}
                onValueChange={(option) => {
                  if (option) edit({ channelId: option.id });
                }}
                onInputValueChange={setTyped}
                itemToStringLabel={(option) => option.name}
                itemToStringValue={(option) => option.id}
                isItemEqualToValue={(a, b) => a.id === b.id}
                disabled={disabled}
                autoHighlight
              >
                <Combobox.Control
                  ref={channelInput}
                  label="Welcome channel"
                  triggerLabel="Browse channels"
                  placeholder="Choose a public channel"
                  leading={
                    selected ? (
                      <ChannelIcon size={18} aria-hidden="true" />
                    ) : undefined
                  }
                  loading={directory.loading}
                  description="New members join this channel and open it first. People already in the community keep their channels."
                  error={
                    directory.error
                      ? "Public channels couldn’t be loaded."
                      : undefined
                  }
                />
                <Combobox.Popup
                  empty={
                    directory.loading
                      ? "Loading channels…"
                      : "No matching public channels."
                  }
                >
                  <Combobox.List>
                    {(option: Option) => (
                      <Combobox.Item key={option.id} value={option}>
                        <ChoiceRow
                          leading={<ChannelIcon size={18} />}
                          label={option.name}
                        />
                      </Combobox.Item>
                    )}
                  </Combobox.List>
                  <BrowseLimit
                    capped={!needle && options.length > BROWSE_LIMIT}
                  />
                </Combobox.Popup>
              </Combobox.Root>
              {directory.error && (
                <div>
                  <Button type="button" onClick={directory.retry}>
                    Retry loading channels
                  </Button>
                </div>
              )}
              <Field
                label="Title"
                description={`${[...trimmedTitle].length.toLocaleString("en-US")} of ${TITLE_MAX} characters`}
                error={titleProblem && titleProblems[titleProblem]}
              >
                <Input
                  disabled={disabled}
                  value={title}
                  onChange={(event) => edit({ title: event.target.value })}
                />
              </Field>
              <WelcomeMessageEditor
                ref={messageInput}
                label="Message"
                description={
                  <>
                    Format with the toolbar or Markdown. To link a channel or
                    person, paste a copied channel link or npub.{" "}
                    <span>
                      {[...normalized].length.toLocaleString("en-US")} of {MAX}{" "}
                      characters
                    </span>
                  </>
                }
                error={problem && problems[problem]}
                value={text}
                onChange={(body) => edit({ text: body })}
                disabled={disabled}
                session={session}
                scope={scope}
                channelId={channelId ?? ""}
                extensions={extensions}
              />
              {(normalized !== DEFAULT_WELCOME_MESSAGE || command.title) && (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      edit({ text: DEFAULT_WELCOME_MESSAGE, title: null })
                    }
                  >
                    Restore defaults
                  </Button>
                </div>
              )}
            </form>
          </SettingsGroup>
        )}
        {starters}
        {status}
        {footer}
        {toast}
      </div>
    </LoadingRegion>
  );
}

/**
 * Connected objects: the channels whose relay `auto_join` flag is on, and a
 * search that adds another. Only starter channels are listed, so the list
 * stays short however many channels the community has. Add and Remove edit
 * the draft; Save publishes them. A drafted addition is listed as not saved
 * yet, and a drafted removal leaves the list until Cancel. Community owners
 * and admins may also flag channels they have not joined. The welcome channel
 * is always joined first, so its row is fixed and its own flag is left as it
 * is.
 */
function StarterChannels({
  channels,
  welcomeChannel,
  draft,
  onChange,
  available,
  saving,
  errors,
  addError,
  addInput,
  loading,
  failed,
  retry,
}: {
  channels: readonly Option[];
  welcomeChannel?: Option | undefined;
  draft: StarterDraft;
  onChange(channel: Option, enabled: boolean): void;
  available: boolean;
  saving: boolean;
  errors: ReadonlyMap<string, string>;
  addError?: Readonly<{ id: string; message: string }> | undefined;
  addInput: RefObject<HTMLInputElement | null>;
  loading: boolean;
  failed: boolean;
  /** Offered here only when nothing else on the card offers it. */
  retry?: (() => void) | undefined;
}) {
  const heading = useId();
  const [typed, setTyped] = useState("");
  const { starters, addable } = useMemo(() => {
    const starters: Option[] = [];
    const addable: Option[] = [];
    for (const channel of channels)
      if (channel.id !== welcomeChannel?.id)
        ((draft.get(channel.id) ?? channel.autoJoin) ? starters : addable).push(
          channel,
        );
    return { starters, addable };
  }, [channels, welcomeChannel?.id, draft]);
  const needle = typed.trim().toLowerCase();
  const matches = useMemo(() => ranked(addable, needle), [addable, needle]);
  const capped = !needle && addable.length > BROWSE_LIMIT;
  const failedAdd =
    addError && !starters.some((channel) => channel.id === addError.id)
      ? `#${channels.find((channel) => channel.id === addError.id)?.name ?? addError.id.slice(0, 8)}: ${addError.message}`
      : undefined;
  const busy = saving || !available;
  const empty = starters.length
    ? undefined
    : loading
      ? "Loading channels…"
      : failed
        ? undefined
        : welcomeChannel
          ? "No other channels added yet"
          : "No channels added yet";
  return (
    <section aria-labelledby={heading} className={styles.section}>
      <InlineHeader
        id={heading}
        title="Also add new members to"
        subtitle="Changes apply when you save, to people who join from then on, not people already in the community. In an open community, an added channel also adds people who come back and have never been in it."
      />
      {(welcomeChannel || starters.length > 0 || empty) && (
        <SettingsGroup>
          {welcomeChannel && (
            <PreferenceRow
              icon={<ChannelIcon />}
              title={welcomeChannel.name}
              subtitle="Welcome channel · always joined"
            />
          )}
          {starters.map((channel) => {
            const error = errors.get(channel.id);
            return (
              <Fragment key={channel.id}>
                <PreferenceRow
                  icon={<ChannelIcon />}
                  title={channel.name}
                  subtitle={
                    channel.autoJoin ? undefined : "Added · not saved yet"
                  }
                  trailing={
                    <Button
                      variant="outline"
                      disabled={busy}
                      aria-label={`Remove #${channel.name} from starter channels`}
                      onClick={() => {
                        onChange(channel, false);
                        // The row leaves with its button; focus stays in the list.
                        addInput.current?.focus({ preventScroll: true });
                      }}
                    >
                      Remove
                    </Button>
                  }
                />
                {error && (
                  <p role="alert" className="buzz-field-error">
                    {error}
                  </p>
                )}
              </Fragment>
            );
          })}
          {empty && (
            <PreferenceRow title={<span role="status">{empty}</span>} />
          )}
        </SettingsGroup>
      )}
      <Combobox.Root<Option>
        items={addable}
        filteredItems={matches}
        value={null}
        inputValue={typed}
        onInputValueChange={(next, details) => {
          if (
            details.reason === "input-change" ||
            details.reason === "input-clear"
          )
            setTyped(next);
        }}
        onValueChange={(option) => {
          if (!option) return;
          setTyped("");
          onChange(option, true);
        }}
        itemToStringLabel={(option) => option.name}
        itemToStringValue={(option) => option.id}
        isItemEqualToValue={(a, b) => a.id === b.id}
        disabled={!available}
        autoHighlight
      >
        <Combobox.Control
          ref={addInput}
          label="Add a channel"
          triggerLabel="Browse channels to add"
          placeholder="Search public channels"
          loading={loading}
          error={
            failedAdd ??
            (failed ? "Public channels couldn’t be loaded." : undefined)
          }
        />
        <Combobox.Popup
          empty={loading ? "Loading channels…" : "No matching public channels."}
        >
          <Combobox.List>
            {(option: Option) => (
              <Combobox.Item key={option.id} value={option} disabled={busy}>
                <ChoiceRow
                  leading={<ChannelIcon size={18} />}
                  label={option.name}
                />
              </Combobox.Item>
            )}
          </Combobox.List>
          <BrowseLimit capped={capped} />
        </Combobox.Popup>
      </Combobox.Root>
      {failed && retry && (
        <div>
          <Button type="button" onClick={retry}>
            Retry loading channels
          </Button>
        </div>
      )}
    </section>
  );
}
