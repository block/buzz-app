import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import type { PageProps } from "../../features/pages/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowLeftIcon,
  ClipboardCheckIcon,
  PlusIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Select, type SelectGroup } from "../../shared/design-system/ui/Select";
import { byRecent, isMine, isOpenStatus, type Task } from "./model";
import { type Place, type ProjectGroup, projectOf } from "./places";
import { usePlaces, useTasksWithSaved } from "./react";
import { taskRoute } from "./route";
import { holdsWords } from "./similar";
import { StatusIcon } from "./StatusIcon";
import { type TaskDraft, TaskView, type TaskViewProps } from "./TaskView";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import styles from "./Tasks.module.css";

type TasksPageProps = Pick<PageProps, "navigation"> & {
  relay: RelayData;
  navigator: Navigation;
  host: ConversationHostServices;
};

export function TasksPage({
  relay,
  navigation,
  navigator,
  host,
}: TasksPageProps) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  const scope = useMemo<NavigationScope | undefined>(
    () =>
      connection.viewer && connection.scope
        ? {
            viewer: connection.viewer,
            communityOrigin: connection.scope.slice(
              0,
              -(connection.viewer.length + 1),
            ),
          }
        : undefined,
    [connection.viewer, connection.scope],
  );
  // A page opened without a community takes the one it connected to.
  useEffect(() => {
    if (
      request?.target.kind !== "page" ||
      request.target.scope !== undefined ||
      connection.status !== "ready" ||
      !scope
    )
      return;
    request.resolve({ ...request.target, scope });
  }, [request, connection.status, scope]);
  const opened =
    navigation?.target.kind === "page"
      ? taskRoute(navigation.target.route?.params)
      : undefined;
  return (
    <FullPageSurface aria-label="Tasks">
      <div className={styles.page}>
        <PanelHeader
          title={
            <PanelHeaderLabel
              title="Tasks"
              icon={<ClipboardCheckIcon size="1rem" />}
            />
          }
        />
        {connection.status === "ready" && scope ? (
          <TaskBoard
            key={`${connection.scope}:${connection.generation}`}
            session={connection.session}
            opened={opened}
            comments={
              connection.scope ? { scope: connection.scope, host } : undefined
            }
            openConversation={(channelId) =>
              void navigator.open({
                version: 1,
                kind: "conversation",
                scope,
                channelId,
              })
            }
          />
        ) : (
          <div className={styles.body}>
            <p role="status" className="text-body-sm text-subtle m-0">
              {connection.status === "connecting"
                ? "Connecting to your community…"
                : "Connect to a community to see its tasks."}
            </p>
            {connection.status === "error" ? (
              <>
                <p role="alert" className="buzz-field-error m-0">
                  {connection.error}
                </p>
                <Button onClick={() => relay.tryAgain()}>
                  Retry connection
                </Button>
              </>
            ) : null}
          </div>
        )}
      </div>
    </FullPageSurface>
  );
}

type Filter = Readonly<{
  words: string;
  /** A project's id, NONE for tasks in no project, or ALL. */
  project: string;
  status: "open" | "closed" | "all";
  mine: boolean;
}>;
const ALL = "all";
const NONE = "none";
const everything: Filter = {
  words: "",
  project: ALL,
  status: "open",
  mine: false,
};

const statusGroups: readonly SelectGroup[] = [
  {
    label: "Status",
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Done and cancelled" },
      { value: "all", label: "Any status" },
    ],
  },
];
const showGroups: readonly SelectGroup[] = [
  {
    label: "Show",
    options: [
      { value: "everyone", label: "Everyone’s" },
      { value: "mine", label: "Mine" },
    ],
  },
];

type Group = ProjectGroup & { tasks: readonly Task[] };

/** Tasks by project, the newest activity first; tasks in no project last. */
function groupByProject(
  tasks: readonly Task[],
  places: ReadonlyMap<string, Place>,
): readonly Group[] {
  const groups = new Map<string | undefined, Group>();
  for (const task of [...tasks].sort(byRecent)) {
    const project = projectOf(task, places);
    const group = groups.get(project.id) ?? { ...project, tasks: [] };
    groups.set(project.id, { ...group, tasks: [...group.tasks, task] });
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.id === undefined) - Number(b.id === undefined) ||
      (a.name ?? "").localeCompare(b.name ?? ""),
  );
}

function TaskBoard({
  session,
  opened,
  openConversation,
  comments,
}: {
  session: RelaySession;
  opened: string | undefined;
  openConversation(channelId: string): void;
} & Pick<TaskViewProps, "comments">) {
  const state = useTasksWithSaved(session);
  const places = usePlaces(
    session,
    state.tasks.map((task) => task.home),
  );
  const [filter, setFilter] = useState<Filter>(everything);
  const [selected, setSelected] = useState<string | undefined>(opened);
  useEffect(() => {
    if (opened) setSelected(opened);
  }, [opened]);
  const viewer = session.viewer ?? "";
  const groups = useMemo(
    () => groupByProject(state.tasks, places),
    [state.tasks, places],
  );
  const shown = groups
    .filter(
      (group) =>
        filter.project === ALL ||
        (filter.project === NONE ? !group.id : group.id === filter.project),
    )
    .map((group) => ({
      ...group,
      tasks: group.tasks.filter(
        (task) =>
          (filter.status === "all" ||
            isOpenStatus(task.status) === (filter.status === "open")) &&
          (!filter.mine || isMine(task, viewer)) &&
          (!filter.words.trim() ||
            holdsWords(filter.words, `${task.title} ${task.description}`)),
      ),
    }))
    .filter((group) => group.tasks.length);
  const projectGroups: readonly SelectGroup[] = [
    {
      label: "Project",
      options: [
        { value: ALL, label: "All projects" },
        ...groups.flatMap((group) =>
          group.id
            ? [{ value: group.id, label: group.name ?? "Private project" }]
            : [],
        ),
        { value: NONE, label: "Not in a project" },
      ],
    },
  ];
  const task =
    selected === "new"
      ? undefined
      : state.tasks.find((item) => item.id === selected);
  const missing = !!selected && selected !== "new" && !task;
  const detail = selected === "new" || !!task || missing;
  const back = useCallback(() => setSelected(undefined), []);
  // Unsaved edits survive opening another task (DESIGN.md master/detail).
  const drafts = useRef(new Map<string, TaskDraft>());
  const onDraftChange = useCallback(
    (draft: TaskDraft | undefined) => {
      if (!selected) return;
      if (draft) drafts.current.set(selected, draft);
      else drafts.current.delete(selected);
    },
    [selected],
  );
  const filtered = filter !== everything;
  return (
    <div className={styles.board} data-detail={detail || undefined}>
      <section className={styles.list} aria-label="Task list">
        <div className={styles.toolbar}>
          <SearchField
            label="Search tasks"
            placeholder="Search tasks"
            value={filter.words}
            onValueChange={(words) => setFilter({ ...filter, words })}
          />
          <div className={styles.actions}>
            <Select
              label="Project"
              variant="compact"
              value={filter.project}
              groups={projectGroups}
              onValueChange={(project) => setFilter({ ...filter, project })}
            />
            <Select
              label="Status"
              variant="compact"
              value={filter.status}
              groups={statusGroups}
              onValueChange={(status) =>
                setFilter({ ...filter, status: status as Filter["status"] })
              }
            />
            <Select
              label="Show"
              variant="compact"
              value={filter.mine ? "mine" : "everyone"}
              groups={showGroups}
              onValueChange={(show) =>
                setFilter({ ...filter, mine: show === "mine" })
              }
            />
            <span className={styles.spacer} />
            <Button
              size="sm"
              variant="prominent"
              onClick={() => setSelected("new")}
            >
              <PlusIcon size={16} aria-hidden="true" />
              New task
            </Button>
          </div>
        </div>
        <LoadingRegion
          pending={state.status === "loading"}
          label="Loading tasks…"
          feedback={
            state.status === "error" ? (
              <p role="alert" className="buzz-field-error m-0">
                {state.error}
              </p>
            ) : undefined
          }
        >
          {state.status === "loading" ? null : shown.length ? (
            <div className={styles.groups}>
              {shown.map((group) => (
                <section
                  key={group.id ?? NONE}
                  className={styles.section}
                  aria-label={group.name ?? "Not in a project"}
                >
                  <InlineHeader
                    title={
                      group.id
                        ? (group.name ?? "Private project")
                        : "Not in a project"
                    }
                  />
                  <ul className={styles.rows}>
                    {group.tasks.map((item) => (
                      <li key={item.id}>
                        <NavigationItem
                          icon={<StatusIcon status={item.status} />}
                          label={item.title || "Untitled task"}
                          selected={item.id === selected}
                          onClick={() => setSelected(item.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<ClipboardCheckIcon size={24} />}
              title={
                state.tasks.length
                  ? "No tasks match these filters"
                  : "No tasks yet"
              }
              description={
                state.tasks.length
                  ? "Change the filters to see other tasks."
                  : "A task holds the context for a piece of work, so anyone can pick it up. You can also ask your agent to make one."
              }
              action={
                state.tasks.length && filtered ? (
                  <Button onClick={() => setFilter(everything)}>
                    Show all open tasks
                  </Button>
                ) : (
                  <Button onClick={() => setSelected("new")}>New task</Button>
                )
              }
            />
          )}
        </LoadingRegion>
      </section>
      {detail ? (
        <section className={styles.detail} aria-label="Task">
          <div className={styles.back}>
            <Button size="sm" variant="ghost" onClick={back}>
              <ArrowLeftIcon size={16} aria-hidden="true" />
              Back
            </Button>
          </div>
          {missing ? (
            state.status === "loading" ? null : (
              <EmptyState
                icon={<ClipboardCheckIcon size={24} />}
                title="This task isn’t available"
                description="You may not have access, or it may have been deleted."
              />
            )
          ) : (
            <TaskView
              key={selected}
              session={session}
              task={task}
              home={
                filter.project !== ALL && filter.project !== NONE
                  ? filter.project
                  : undefined
              }
              openConversation={openConversation}
              comments={comments}
              draft={selected ? drafts.current.get(selected) : undefined}
              onDraftChange={onDraftChange}
              onSaved={(next) => {
                state.setSaved(next);
                setSelected(next.id);
              }}
              onDiscard={back}
            />
          )}
        </section>
      ) : null}
    </div>
  );
}
