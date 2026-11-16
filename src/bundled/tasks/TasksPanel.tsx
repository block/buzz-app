import { useEffect, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowLeftIcon,
  ClipboardCheckIcon,
  LinkIcon,
  PlusIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { readLinks, setLink } from "./links";
import { byRecent, isOpenStatus } from "./model";
import { useTasksWithSaved } from "./react";
import { StatusIcon } from "./StatusIcon";
import { TaskView, type TaskViewProps } from "./TaskView";
import styles from "./Tasks.module.css";

/** Open tasks the "Link a task" menu offers, newest first. */
const LINK_CHOICES = 20;

/** Tasks beside one conversation: those living in it and those linked to
 * it, and ways to make or link one from here. A task opens in place, with
 * Back. */
export function TasksPanel({
  session,
  chat,
  openConversation,
  comments,
}: {
  session: RelaySession;
  /** The conversation this panel sits beside. */
  chat: string;
} & Pick<TaskViewProps, "openConversation" | "comments">) {
  const state = useTasksWithSaved(session);
  const notify = useToastNotification();
  const [open, setOpen] = useState<string>();
  const [linked, setLinked] = useState<ReadonlySet<string>>();
  const [linking, setLinking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change is a new read.
  useEffect(() => {
    const controller = new AbortController();
    readLinks(session, { conversation: chat }, controller.signal).then(
      (links) =>
        !controller.signal.aborted &&
        setLinked(new Set(links.map((link) => link.task))),
      () => !controller.signal.aborted && setLinked(new Set()),
    );
    return () => controller.abort();
  }, [session, chat, attempt]);
  const here = state.tasks
    .filter((task) => task.home === chat || linked?.has(task.id))
    .sort(byRecent);
  const choices = state.tasks
    .filter(
      (task) =>
        isOpenStatus(task.status) &&
        task.home !== chat &&
        !linked?.has(task.id),
    )
    .sort(byRecent)
    .slice(0, LINK_CHOICES);
  const linkTo = async (task: string) => {
    if (linking) return;
    setLinking(true);
    try {
      await setLink(
        session,
        session,
        task,
        chat,
        true,
        AbortSignal.timeout(20_000),
      );
      setAttempt((count) => count + 1);
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "Couldn’t link the task.",
        "error",
      );
    } finally {
      setLinking(false);
    }
  };
  const task =
    open && open !== "new"
      ? state.tasks.find((item) => item.id === open)
      : undefined;
  if (open === "new" || task)
    return (
      <div className={styles.body}>
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(undefined);
              // Links may have changed in the task.
              setAttempt((count) => count + 1);
            }}
          >
            <ArrowLeftIcon size={16} aria-hidden="true" />
            Back
          </Button>
        </div>
        <TaskView
          key={task?.id ?? "new"}
          session={session}
          task={task}
          home={chat}
          currentChat={chat}
          openConversation={openConversation}
          comments={comments}
          onSaved={(next) => {
            state.setSaved(next);
            setOpen(next.id);
          }}
          onDiscard={() => setOpen(undefined)}
        />
      </div>
    );
  return (
    <div className={styles.body}>
      <div className={styles.actions}>
        <Button
          size="sm"
          variant="prominent"
          disabled={linking}
          onClick={() => setOpen("new")}
        >
          <PlusIcon size={16} aria-hidden="true" />
          New task
        </Button>
        <MenuRoot>
          <MenuTrigger
            render={
              <Button size="sm" loading={linking} disabled={!choices.length}>
                <LinkIcon size={16} aria-hidden="true" />
                Link a task
              </Button>
            }
          />
          <MenuPopup>
            {choices.map((item) => (
              <MenuItem key={item.id} onClick={() => void linkTo(item.id)}>
                {item.title || "Untitled task"}
              </MenuItem>
            ))}
          </MenuPopup>
        </MenuRoot>
      </div>
      <LoadingRegion
        pending={state.status === "loading" || !linked}
        label="Loading tasks…"
        feedback={
          state.status === "error" ? (
            <p role="alert" className="buzz-field-error m-0">
              {state.error}
            </p>
          ) : undefined
        }
      >
        {state.status === "loading" || !linked ? null : here.length ? (
          <ul className={styles.rows} aria-label="Tasks here">
            {here.map((item) => (
              <li key={item.id}>
                <NavigationItem
                  icon={<StatusIcon status={item.status} />}
                  label={item.title || "Untitled task"}
                  onClick={() => setOpen(item.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<ClipboardCheckIcon size={24} />}
            title="No tasks here"
            description="Make a task from this conversation, or link one that already exists."
          />
        )}
      </LoadingRegion>
    </div>
  );
}
