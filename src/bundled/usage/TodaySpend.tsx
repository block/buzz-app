import {
  type ComponentProps,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { relayOrigin } from "../../features/communities/destination";
import type { Navigation } from "../../features/navigation/controller";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { useScrollEdges } from "../../shared/design-system/ui/useScrollEdges";
import { amount, cost, costLabel } from "./format";
import type { Total } from "./stats";
import { latestSession, type TodayStore } from "./today";
import { useSpendBesideSend } from "./today-preference";
import styles from "./Usage.module.css";

/** A cost beside Send or in a row: `—` when unknown. Partial costs are named
 * in the accessible label and the card's note, not marked on the number. */
const shown = (total: Total) =>
  total.value === undefined ? "—" : cost(total.value);

/** Today's estimated agent spend, beside Send, while its setting is on. */
export function TodaySpend({
  store,
  open,
}: {
  store: TodayStore;
  open: Navigation["open"];
}) {
  return useSpendBesideSend() ? <Spend store={store} open={open} /> : null;
}

function Spend({
  store,
  open: navigate,
}: {
  store: TodayStore;
  open: Navigation["open"];
}) {
  const today = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [open, setOpen] = useState(false);
  const actions =
    useRef<
      NonNullable<ComponentProps<typeof PopoverRoot>["actionsRef"]>["current"]
    >(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useScrollEdges("block");
  // A composer coming into view reads again once the last read is stale.
  // The store watches agents, the window and midnight while one is shown.
  useEffect(() => {
    void store.refresh();
  }, [store]);
  // Nothing shows before the first read, or without an agent here to read.
  if (!today?.agents) return null;
  const { result } = today;
  const total: Total = result.cost;
  return (
    <PopoverRoot
      open={open}
      actionsRef={actions}
      onOpenChange={(next) => {
        if (next) void store.refresh();
        setOpen(next);
      }}
    >
      <PopoverTrigger
        ref={trigger}
        openOnHover="preview"
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Your agents’ estimated spend today: ${costLabel(total)}`}
          >
            <span className={styles.spendTrigger}>{shown(total)}</span>
          </Button>
        }
      />
      <PopoverPopup side="top" align="end" size="compact" padding="list">
        <div className={styles.spendHeader}>
          <PopoverTitle>Today</PopoverTitle>
          <span className={styles.label}>Estimated</span>
        </div>
        <p className={styles.spendTotal}>{amount(total, cost)}</p>
        {!today.unpriced && total.partial && (
          <p className={styles.spendNote}>Some costs are unknown.</p>
        )}
        {today.unpriced && (
          <p className={styles.spendNote} role="status">
            Couldn’t load prices to estimate costs.
          </p>
        )}
        {result.agents.length > 0 && (
          <ul
            ref={list}
            className={styles.spendList}
            data-scroll-fade="scrolled"
            aria-label="By agent"
          >
            {result.agents.map((entry) => {
              const session = latestSession(today, entry.agent);
              const channelId = session?.channelId;
              const label = (
                <span className={styles.spendRow}>
                  <Avatar
                    src={entry.agent.picture}
                    alt=""
                    fallback={entry.agent.name}
                    size="small"
                  />
                  <span className={styles.name}>{entry.agent.name}</span>
                </span>
              );
              const value = (
                <span className={styles.value} title={costLabel(entry.cost)}>
                  {shown(entry.cost)}
                </span>
              );
              return (
                <li key={`${entry.agent.key}:${entry.harness}`}>
                  {session && channelId ? (
                    <NavigationItem
                      label={label}
                      trailing={value}
                      aria-label={`${entry.agent.name}, ${costLabel(entry.cost)}. Open its latest conversation`}
                      onClick={() => {
                        // As the Working now card does: the composer stays
                        // when the conversation is this one, so focus goes
                        // back to the amount and the card closes.
                        trigger.current?.focus({ preventScroll: true });
                        if (actions.current) actions.current.close();
                        else setOpen(false);
                        void navigate({
                          version: 1,
                          kind: "conversation",
                          scope: {
                            viewer: entry.agent.owner,
                            communityOrigin: relayOrigin(entry.agent.relay),
                          },
                          channelId,
                          ...(session.root
                            ? {
                                messageId: session.root,
                                threadRootId: session.root,
                              }
                            : {}),
                        });
                      }}
                    />
                  ) : (
                    <div className={styles.spendStatic}>
                      {label}
                      {value}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}
