import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useChannelReference } from "../../features/conversation/channel-reference";
import { useIdentityNames } from "../../features/identity-names/react";
import { DOCUMENT_PROFILE } from "../../features/markdown/document-profile";
import {
  MarkdownDocument,
  sharedComponents,
} from "../../features/markdown/MarkdownDocument";
import { AttachmentImage } from "../../features/messages/AttachmentImage";
import type { RelaySession } from "../../features/relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import {
  ChatCircleIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  LockIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { Button } from "../../shared/design-system/ui/Button";
import { TaskComments, type TaskCommentsProps } from "./TaskComments";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Select, type SelectGroup } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { formatPublicKey } from "../../shared/identity/public-key";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { readLinks, setLink, type TaskLink } from "./links";
import {
  MAX_ASSIGNEES,
  statuses,
  statusLabels,
  type Task,
  type TaskFields,
  type TaskImage,
  type TaskStatus,
} from "./model";
import {
  accessChange,
  canHoldTasks,
  type Place,
  placeLabel,
  projectOf,
  readReaders,
} from "./places";
import { usePlaceAccess, usePlaces, useTaskPlaces } from "./react";
import { saveTask, type SaveTarget } from "./store";
import { StatusIcon } from "./StatusIcon";
import styles from "./Tasks.module.css";

const empty: TaskFields = {
  title: "",
  description: "",
  status: "todo",
  images: [],
  assignees: [],
};

/** An open edit: the text, the revision it builds on, and the task's id. */
export type TaskDraft = Readonly<{
  fields: TaskFields;
  base: Task | undefined;
  id: string;
  home: string | undefined;
}>;

const fieldsOf = (task: Task): TaskFields => ({
  title: task.title,
  description: task.description,
  status: task.status,
  images: task.images,
  assignees: task.assignees,
});

const message = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;

export type TaskViewProps = {
  session: RelaySession;
  /** The task's current revision; undefined starts a new task. */
  task: Task | undefined;
  /** Where a new task starts. */
  home?: string | undefined;
  /** Where task comments show: the connection's scope and the plugin's
   * conversation services. Absent, the view shows no comments. */
  comments?: Pick<TaskCommentsProps, "scope" | "host"> | undefined;
  /** The conversation this view sits beside, which "Link this chat" links. */
  currentChat?: string | undefined;
  openConversation(channelId: string): void;
  onSaved(task: Task): void;
  /** Unsaved edits the list keeps while another task is open. */
  draft?: TaskDraft | undefined;
  onDraftChange?: ((draft: TaskDraft | undefined) => void) | undefined;
  /** Leaves a new task without saving it. */
  onDiscard?: (() => void) | undefined;
};

/** One task: read by default, with an explicit edit mode. Every save names
 * the revision it started from, so a concurrent edit is reported, never lost. */
export function TaskView(props: TaskViewProps) {
  const { session, task } = props;
  const [editing, setEditing] = useState(!task || !!props.draft);
  if (editing || !task)
    return (
      <TaskEditor
        {...props}
        onDone={(saved) => {
          props.onDraftChange?.(undefined);
          setEditing(false);
          if (!saved && !task) props.onDiscard?.();
        }}
      />
    );
  return (
    <TaskDetails
      {...props}
      session={session}
      task={task}
      edit={() => setEditing(true)}
    />
  );
}

function TaskDetails({
  session,
  task,
  currentChat,
  openConversation,
  onSaved,
  edit,
  comments,
}: TaskViewProps & { task: Task; edit(): void }) {
  const notify = useToastNotification();
  // The relay's answer for the task's home decides every edit control.
  const { access } = usePlaceAccess(session, task.home);
  const canEdit = access === "edit";
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState(false);
  const places = usePlaces(session, [task.home]);
  const project = projectOf(task, places);
  const home = places.get(task.home);
  // Immediate changes: status and assignees, on the revision shown.
  const change = async (next: Partial<TaskFields>) => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await saveTask(
        session,
        session,
        { ...fieldsOf(task), ...next },
        { op: "update", base: task },
      );
      if (result.status === "saved") onSaved(result.task);
      else {
        onSaved(result.current);
        notify("Someone else changed this task. Try again.", "error");
      }
    } catch (reason) {
      notify(message(reason, "Couldn’t save the task."), "error");
    } finally {
      setSaving(false);
    }
  };
  const setStatus = (status: TaskStatus) => {
    // Starting a task assigns whoever starts it, when there's room.
    const viewer = session.viewer;
    const starts =
      status === "in_progress" &&
      viewer &&
      !task.assignees.includes(viewer) &&
      task.assignees.length < MAX_ASSIGNEES;
    void change({
      status,
      ...(starts ? { assignees: [...task.assignees, viewer] } : {}),
    });
  };
  return (
    <article className={styles.task} aria-label={task.title}>
      <div className={styles.heading}>
        <h2 className="text-title m-0">{task.title}</h2>
        <TaskByline session={session} task={task} />
        <p className="text-body-sm text-subtle m-0">
          {project.id && project.id !== task.home
            ? `${project.name ?? "Private project"}${home ? ` · ${placeLabel(home, places)}` : ""}`
            : home
              ? placeLabel(home, places)
              : ""}
        </p>
      </div>
      <div className={styles.controls}>
        {canEdit ? (
          <>
            <Select
              label="Status"
              variant="compact"
              value={task.status}
              leading={<StatusIcon status={task.status} />}
              disabled={saving}
              groups={statusGroups}
              onValueChange={(value) => setStatus(value as TaskStatus)}
            />
            <AssigneePicker
              session={session}
              home={task.home}
              assignees={task.assignees}
              disabled={saving}
              onChange={(assignees) => void change({ assignees })}
            />
            <span className={styles.wideOnly}>
              <Button size="sm" disabled={saving} onClick={edit}>
                Edit
              </Button>
              <Button
                size="sm"
                disabled={saving}
                onClick={() => setMoving(true)}
              >
                Move…
              </Button>
            </span>
            <span className={styles.more}>
              <MenuRoot>
                <MenuTrigger
                  render={
                    <Button size="sm" disabled={saving}>
                      More
                    </Button>
                  }
                />
                <MenuPopup>
                  <MenuItem onClick={edit}>Edit</MenuItem>
                  <MenuItem onClick={() => setMoving(true)}>Move…</MenuItem>
                </MenuPopup>
              </MenuRoot>
            </span>
          </>
        ) : (
          <>
            <span className={`text-body-sm ${styles.status}`}>
              <StatusIcon status={task.status} /> {statusLabels[task.status]}
            </span>
            <Assignees session={session} assignees={task.assignees} />
          </>
        )}
      </div>
      {task.description.trim() ? (
        <MarkdownDocument
          content={task.description}
          profile={DOCUMENT_PROFILE}
          components={sharedComponents}
          scale="document"
          capabilities={{ session }}
        />
      ) : (
        <p className="text-body-sm text-subtle m-0">No description.</p>
      )}
      {task.images.length > 0 && (
        <TaskImages session={session} images={task.images} />
      )}
      <LinkedConversations
        session={session}
        task={task}
        currentChat={currentChat}
        canEdit={canEdit}
        openConversation={openConversation}
      />
      <section className={styles.section} aria-labelledby={`${task.id}-talk`}>
        <InlineHeader id={`${task.id}-talk`} title="Comments" />
        {comments ? (
          <TaskComments session={session} task={task} {...comments} />
        ) : null}
      </section>
      {moving ? (
        <MoveTask
          session={session}
          task={task}
          onClose={() => setMoving(false)}
          onMoved={(moved) => {
            setMoving(false);
            onSaved(moved);
          }}
        />
      ) : null}
    </article>
  );
}

const statusGroups: readonly SelectGroup[] = [
  {
    label: "Status",
    options: statuses.map((status) => ({
      value: status,
      label: statusLabels[status],
      leading: <StatusIcon status={status} />,
    })),
  },
];

/** Profiles for `pubkeys`, read in the background and kept current. */
function usePeople(session: RelaySession, pubkeys: readonly string[]) {
  const key = pubkeys.join(",");
  useEffect(() => {
    if (key)
      void session.profiles
        .ensure(key.split(","), "background")
        .catch(() => {});
  }, [session, key]);
  const snapshot = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const name = useIdentityNames(session.names);
  return useCallback(
    (pubkey: string) => {
      const profile = snapshot.get(pubkey);
      return {
        id: pubkey,
        name:
          pubkey === session.viewer
            ? "You"
            : name(
                pubkey,
                profile?.name ?? formatPublicKey(pubkey) ?? "Someone",
              ),
        src: avatarMedia(profile?.picture, session.media),
        isAgent: !!profile?.isAgent,
      };
    },
    [snapshot, name, session],
  );
}

function Assignees({
  session,
  assignees,
}: {
  session: RelaySession;
  assignees: readonly string[];
}) {
  const person = usePeople(session, assignees);
  const people = assignees.map(person);
  if (!people.length)
    return <span className="text-body-sm text-subtle">Nobody assigned</span>;
  return (
    <span className="text-body-sm">
      <AvatarStack
        size="small"
        max={MAX_ASSIGNEES}
        items={people.map((item) => ({ ...item, shape: "circle" }))}
      />{" "}
      {people.map((item) => item.name).join(", ")}
    </span>
  );
}

type Person = ReturnType<ReturnType<typeof usePeople>>;

/** Up to four people, chosen from the people who can see the task. Agents
 * are never offered: a person always answers for the work. */
function AssigneePicker({
  session,
  home,
  assignees,
  disabled,
  onChange,
}: {
  session: RelaySession;
  home: string;
  assignees: readonly string[];
  disabled: boolean;
  onChange(assignees: readonly string[]): void;
}) {
  // Its members and those of the places it is filed under. An open place
  // has more readers than these; the relay checks every assignee either way.
  const readers = useReadersOf(session, home);
  const pubkeys = useMemo(
    () => [...new Set([...assignees, ...(readers?.people ?? [])])],
    [assignees, readers],
  );
  const person = usePeople(session, pubkeys);
  const [search, setSearch] = useState("");
  // Stable between renders: the combobox syncs its selection to these.
  const people = useMemo(
    () =>
      pubkeys
        .map(person)
        .filter((item) => !item.isAgent || assignees.includes(item.id)),
    [pubkeys, person, assignees],
  );
  const chosen = useMemo(
    () => people.filter((item) => assignees.includes(item.id)),
    [people, assignees],
  );
  const full = chosen.length >= MAX_ASSIGNEES;
  return (
    <Combobox.Root<Person, true>
      multiple
      items={people}
      value={chosen}
      itemToStringLabel={(item) => item.name}
      itemToStringValue={(item) => item.id}
      isItemEqualToValue={(a, b) => a.id === b.id}
      inputValue={search}
      onInputValueChange={setSearch}
      onOpenChange={(open) => open && setSearch("")}
      disabled={disabled}
      onValueChange={(next) => {
        if (next.length <= MAX_ASSIGNEES) onChange(next.map((item) => item.id));
      }}
    >
      <Combobox.Trigger variant="compact" label="Assignees" disabled={disabled}>
        {chosen.length ? (
          <AvatarStack
            size="mini"
            max={MAX_ASSIGNEES}
            items={chosen.map((item) => ({ ...item, shape: "circle" }))}
          />
        ) : (
          "Nobody assigned"
        )}
      </Combobox.Trigger>
      <Combobox.Popup search size="compact" empty="No one here matches.">
        <Combobox.List>
          {(item: Person) => (
            <Combobox.Item
              key={item.id}
              value={item}
              disabled={full && !assignees.includes(item.id)}
              description={
                full && !assignees.includes(item.id)
                  ? `Up to ${MAX_ASSIGNEES} people`
                  : undefined
              }
            >
              {item.name}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Popup>
    </Combobox.Root>
  );
}

function TaskByline({ session, task }: { session: RelaySession; task: Task }) {
  const person = usePeople(
    session,
    [task.creator, task.via, task.editor].flatMap((key) => key ?? []),
  );
  const label = (pubkey: string) =>
    pubkey === session.viewer ? "you" : person(pubkey).name;
  const created = task.creator
    ? `Created by ${label(task.creator)}${task.via ? ` via ${label(task.via)}` : ""} · `
    : "";
  return (
    <p className="text-body-sm text-subtle m-0">
      {created}Updated {relativeTimestamp(task.updatedAt * 1000)} by{" "}
      {label(task.editor)}
    </p>
  );
}

function TaskImages({
  session,
  images,
  remove,
}: {
  session: RelaySession;
  images: readonly TaskImage[];
  remove?: ((image: TaskImage) => void) | undefined;
}) {
  return (
    <ul className={styles.images} aria-label="Images">
      {images.map((image) => {
        const [width, height] = image.dim?.split("x").map(Number) ?? [];
        return (
          <li key={image.url} className={styles.image}>
            <AttachmentImage
              compact
              session={session}
              label="Open image"
              source={session.media(image.url)}
              attachment={{
                url: image.url,
                kind: "image",
                ...(image.type ? { mime: image.type } : {}),
                ...(width && height ? { dimensions: { width, height } } : {}),
              }}
            />
            {remove ? (
              <IconButton
                size="sm"
                variant="ghost"
                aria-label="Remove image"
                icon={<XIcon size={16} aria-hidden="true" />}
                onClick={() => remove(image)}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Conversations linked to the task that the viewer can read. A link lives
 * with its conversation, so nobody learns of a link they can't read. */
function LinkedConversations({
  session,
  task,
  currentChat,
  canEdit,
  openConversation,
}: {
  session: RelaySession;
  task: Task;
  currentChat: string | undefined;
  /** Linking and unlinking edit the task, as the relay allows. */
  canEdit: boolean;
  openConversation(channelId: string): void;
}) {
  const notify = useToastNotification();
  const [links, setLinks] = useState<readonly TaskLink[]>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change is a new read.
  useEffect(() => {
    const controller = new AbortController();
    readLinks(session, { task: task.id }, controller.signal).then(
      (read) => !controller.signal.aborted && setLinks(read),
      () => !controller.signal.aborted && setLinks([]),
    );
    return () => controller.abort();
  }, [session, task.id, attempt]);
  const toggle = async (conversation: string, linked: boolean) => {
    setBusy(true);
    try {
      await setLink(
        session,
        session,
        task.id,
        conversation,
        linked,
        AbortSignal.timeout(20_000),
      );
      setAttempt((count) => count + 1);
    } catch (reason) {
      notify(message(reason, "Couldn’t change the link."), "error");
    } finally {
      setBusy(false);
    }
  };
  const linkedHere =
    !!currentChat && !!links?.some((link) => link.conversation === currentChat);
  return (
    <section className={styles.section} aria-labelledby={`${task.id}-links`}>
      <InlineHeader id={`${task.id}-links`} title="Linked conversations" />
      {links?.length ? (
        <ul className={styles.rows}>
          {links.map((link) => (
            <li key={link.id} className={styles.linkRow}>
              <LinkedConversation
                session={session}
                channelId={link.conversation}
                open={() => openConversation(link.conversation)}
              />
              {canEdit ? (
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label="Unlink"
                  icon={<XIcon size={16} aria-hidden="true" />}
                  disabled={busy}
                  onClick={() => void toggle(link.conversation, false)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body-sm text-subtle m-0">
          {links ? "No conversations you can see are linked." : "Loading…"}
        </p>
      )}
      {canEdit && currentChat && links && !linkedHere ? (
        <div className={styles.actions}>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void toggle(currentChat, true)}
          >
            <LinkIcon size={16} aria-hidden="true" />
            Link this chat
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function LinkedConversation({
  session,
  channelId,
  open,
}: {
  session: RelaySession;
  channelId: string;
  open(): void;
}) {
  const reference = useChannelReference(session.channels, channelId);
  let icon: ReactNode = <HashIcon size={16} aria-hidden="true" />;
  let label = "Loading…";
  if (reference.state === "found") {
    const solo = reference.channelType === "solo";
    if (solo) icon = <ChatCircleIcon size={16} aria-hidden="true" />;
    label = reference.name || (solo ? "Chat" : "Channel");
  } else if (reference.state === "withheld") {
    icon = <LockIcon size={16} aria-hidden="true" />;
    label = "Private channel";
  }
  return (
    <NavigationItem
      icon={icon}
      label={label}
      disabled={reference.state !== "found" || reference.readable === false}
      onClick={open}
    />
  );
}

/** Where a task can go, by the one place-name rule. Whether the viewer can
 * post there is asked when they pick it. */
function homeGroups(
  homes: readonly { id: string; name: string; channelType?: string }[],
  places: ReadonlyMap<string, Place>,
  except?: string,
): readonly SelectGroup[] {
  const options = (kind: "chat" | "channel") =>
    homes
      .filter((item) => item.id !== except)
      .filter((item) => (item.channelType === "solo") === (kind === "chat"))
      .map((item) => ({
        value: item.id,
        label: placeLabel(
          { id: item.id, name: item.name || "Untitled", kind },
          places,
        ),
      }));
  return [
    { label: "Channels", options: options("channel") },
    { label: "Chats", separator: true, options: options("chat") },
  ].filter((group) => group.options.length);
}

/** The places a picker offers, named and with their projects known. */
function useHomeChoices(session: RelaySession, except?: string) {
  const homes = useTaskPlaces(session);
  const places = usePlaces(
    session,
    homes.map((item) => item.id),
  );
  const groups = useMemo(
    () => homeGroups(homes, places, except),
    [homes, places, except],
  );
  return { groups, places };
}

/** Why the viewer can't put a task in `place` yet, from the relay's answer;
 * undefined once they can. */
function placeProblem(access: string, label: string): string | undefined {
  switch (access) {
    case "edit":
      return undefined;
    case "loading":
      return "";
    case "failed":
      return `Couldn’t check whether you can post in ${label}. Try again.`;
    default:
      return `You can’t post in ${label}, so a task can’t live there.`;
  }
}

/** Moving one task: choose where, then confirm whose access changes, by
 * place. An assignee who can't see the new place is named, the one time a
 * person is, and moving unassigns them. The task's comments go with it. */
function MoveTask({
  session,
  task,
  onClose,
  onMoved,
}: {
  session: RelaySession;
  task: Task;
  onClose(): void;
  onMoved(task: Task): void;
}) {
  const choices = useHomeChoices(session, task.home);
  const [to, setTo] = useState<string>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const target = usePlaceAccess(session, to);
  const places = usePlaces(session, to ? [task.home, to] : [task.home]);
  const named = new Map([...choices.places, ...places]);
  const change = to ? accessChange(task.home, to, named) : undefined;
  const destination = to && named.get(to);
  const label = destination ? placeLabel(destination, named) : "that place";
  const readers = useReadersOf(session, to);
  const person = usePeople(session, task.assignees);
  const dropped =
    readers && !readers.anyone
      ? task.assignees.filter((pubkey) => !readers.people.has(pubkey))
      : [];
  const problem = to ? placeProblem(target.access, label) : "";
  const ready = !!to && problem === undefined && !!readers;
  const move = async () => {
    if (!to || !ready) return;
    setPending(true);
    setError("");
    try {
      const result = await saveTask(
        session,
        session,
        {
          ...fieldsOf(task),
          assignees: task.assignees.filter((key) => !dropped.includes(key)),
        },
        { op: "move", base: task, home: to },
      );
      if (result.status === "saved") onMoved(result.task);
      else setError("Someone else changed this task. Close and try again.");
    } catch (reason) {
      setError(message(reason, "Couldn’t move the task."));
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog
      title="Move task"
      description="Choose where this task lives. Who can see it, and its comments, comes from there."
      pending={pending}
      onClose={onClose}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={!ready || pending}
            onClick={() => void move()}
          >
            Move
          </Button>
        </>
      }
    >
      {choices.groups.length ? (
        <Select
          label="Move to"
          variant="field"
          value={to ?? ""}
          placeholder="Choose a place"
          groups={choices.groups}
          onValueChange={setTo}
        />
      ) : (
        <p className="text-body-sm m-0">
          There’s nowhere else you can move this task.
        </p>
      )}
      {problem ? (
        <div className={styles.actions} role="alert">
          <p className="buzz-field-error m-0">{problem}</p>
          {target.access === "failed" ? (
            <Button size="sm" onClick={target.retry}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
      {problem === undefined && change?.gain.length ? (
        <p className="text-body-sm m-0">
          Everyone in {placeList(change.gain, named)} will be able to see this
          task and its comments.
        </p>
      ) : null}
      {problem === undefined && change?.lose.length ? (
        <p className="text-body-sm m-0">
          People who are only in {placeList(change.lose, named)} will lose
          access.
        </p>
      ) : null}
      {problem === undefined && dropped.length ? (
        <p className="text-body-sm m-0">
          {listNames(dropped.map((key) => person(key).name))} can’t see {label}{" "}
          and will be unassigned.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="buzz-field-error m-0">
          {error}
        </p>
      ) : null}
    </AlertDialog>
  );
}

const placeList = (
  list: readonly Place[],
  places: ReadonlyMap<string, Place>,
) => listNames(list.map((place) => placeLabel(place, places)));

const listNames = (names: readonly string[]) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(names);

/** Who can see what lives in `home`; undefined until read, or with no home. */
function useReadersOf(session: RelaySession, home: string | undefined) {
  const [readers, setReaders] =
    useState<Awaited<ReturnType<typeof readReaders>>>();
  useEffect(() => {
    setReaders(undefined);
    if (!home) return;
    const controller = new AbortController();
    readReaders(session, home, controller.signal).then(
      (read) => !controller.signal.aborted && setReaders(read),
      () => {},
    );
    return () => controller.abort();
  }, [session, home]);
  return readers;
}

function TaskEditor({
  session,
  task,
  home: startHome,
  draft: kept,
  onDraftChange,
  onSaved,
  onDone,
}: TaskViewProps & { onDone(saved: boolean): void }) {
  const inputId = useId();
  const choices = useHomeChoices(session);
  const [draft, setDraft] = useState<TaskFields>(
    kept?.fields ?? (task ? fieldsOf(task) : empty),
  );
  const [picked, setHome] = useState(kept?.home ?? startHome);
  const startPlaces = usePlaces(session, picked ? [picked] : []);
  const chosen = picked ? startPlaces.get(picked) : undefined;
  // The store's rule for where a task can live: from a DM or a huddle, the
  // place starts empty and must be chosen.
  const home = chosen && !canHoldTasks(chosen) ? undefined : picked;
  // The revision this draft builds on; a conflict moves it to theirs.
  const [base, setBase] = useState(kept ? kept.base : task);
  // One id for a new task across retries, so a create that landed unseen
  // is found rather than made twice.
  const [taskId] = useState(() => kept?.id ?? task?.id ?? crypto.randomUUID());
  useEffect(
    () => onDraftChange?.({ fields: draft, base, id: taskId, home }),
    [draft, base, taskId, home, onDraftChange],
  );
  const [conflict, setConflict] = useState<Task>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  // Only a place the relay says the viewer can post in takes a new task.
  const target = usePlaceAccess(session, task ? undefined : home);
  const problem =
    !task && home
      ? placeProblem(
          target.access,
          chosen ? placeLabel(chosen, startPlaces) : "that place",
        )
      : undefined;
  const where = problem === undefined ? home : undefined;
  const update = (next: Partial<TaskFields>) =>
    setDraft((current) => ({ ...current, ...next }));
  const submit = async () => {
    const save: SaveTarget | undefined = base
      ? { op: "update", base }
      : where
        ? { op: "create", home: where, id: taskId }
        : undefined;
    if (!save) {
      setError(problem || "Choose where this task lives.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const result = await saveTask(session, session, draft, save);
      if (result.status === "saved") {
        onSaved(result.task);
        onDone(true);
      } else {
        // Keep the person's text; the next Save is a deliberate overwrite.
        setConflict(result.current);
        setBase(result.current);
      }
    } catch (reason) {
      setError(message(reason, "Couldn’t save the task."));
    } finally {
      setSaving(false);
    }
  };
  const upload = async (list: FileList | null) => {
    // Media access is community-wide; saving the task is the guarded write.
    const uploadImage = session.attachments?.uploadForNewChat;
    const chosen = [...(list ?? [])].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!chosen.length) return;
    if (!uploadImage) {
      setError("Images can’t be uploaded in this community.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const uploaded = await Promise.all(
        chosen.map((file) => uploadImage(file, AbortSignal.timeout(120_000))),
      );
      setDraft((current) => ({
        ...current,
        images: [
          ...current.images,
          ...uploaded.map((item) => ({
            url: item.url,
            type: item.type,
            ...(item.dim ? { dim: item.dim } : {}),
          })),
        ],
      }));
    } catch {
      setError("Couldn’t upload the image. Try again.");
    } finally {
      setUploading(false);
      if (files.current) files.current.value = "";
    }
  };
  const busy = saving || uploading;
  return (
    <form
      className={styles.task}
      aria-label={task ? "Edit task" : "New task"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onPaste={(event) => {
        if (event.clipboardData.files.length) {
          event.preventDefault();
          void upload(event.clipboardData.files);
        }
      }}
    >
      {conflict ? (
        <div role="alert" className={styles.actions}>
          <p className="buzz-field-error m-0">
            Someone else changed this task. Your text is kept. Saving now
            replaces their version.
          </p>
          <Button
            size="sm"
            onClick={() => {
              setDraft(fieldsOf(conflict));
              setConflict(undefined);
            }}
          >
            Show their version
          </Button>
        </div>
      ) : null}
      <Field label="Title">
        <Input
          value={draft.title}
          autoFocus
          maxLength={200}
          onChange={(event) => update({ title: event.target.value })}
        />
      </Field>
      {task ? null : (
        <Select
          label="Where it lives"
          variant="field"
          description="People who can see this place can see the task."
          value={home ?? ""}
          placeholder="Choose a place"
          required
          groups={choices.groups}
          onValueChange={setHome}
        />
      )}
      {problem ? (
        <div className={styles.actions} role="alert">
          <p className="buzz-field-error m-0">{problem}</p>
          {target.access === "failed" ? (
            <Button size="sm" onClick={target.retry}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
      <Field
        label="Description"
        description="Markdown. Write it so someone who can’t read this conversation can pick it up."
      >
        <Textarea
          rows={8}
          value={draft.description}
          onChange={(event) => update({ description: event.target.value })}
        />
      </Field>
      {draft.images.length > 0 && (
        <TaskImages
          session={session}
          images={draft.images}
          remove={(image) =>
            update({
              images: draft.images.filter((item) => item.url !== image.url),
            })
          }
        />
      )}
      <input
        ref={files}
        id={`${inputId}-files`}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => void upload(event.target.files)}
      />
      {error ? (
        <p role="alert" className="buzz-field-error m-0">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          disabled={busy}
          loading={uploading}
          onClick={() => files.current?.click()}
        >
          <ImageIcon size={16} aria-hidden="true" />
          Add image
        </Button>
        <span className={styles.spacer} />
        <Button disabled={saving} onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="prominent"
          loading={saving}
          disabled={busy || !draft.title.trim() || (!task && !where)}
        >
          {task ? "Save" : "Create task"}
        </Button>
      </div>
    </form>
  );
}
