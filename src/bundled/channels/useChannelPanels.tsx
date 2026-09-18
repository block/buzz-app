import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  ChannelPanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import { PanelView } from "../../features/panels/PanelView";
import styles from "./Channels.module.css";

type Opening = {
  panel: RegisteredPanel;
  context: ChannelPanelContext;
  target: string;
  trigger: HTMLElement | null;
};
/** Page-local presentation; optional plugins retain their own work outside this mount. */
export function useChannelPanels(
  panels: Panels,
  context?: ChannelPanelContext,
) {
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [opened, setOpened] = useState<Opening>();
  const mounted = useRef<ChannelPanelContext>(undefined);
  useLayoutEffect(() => {
    mounted.current = context;
    return () => {
      mounted.current = undefined;
    };
  }, [context]);
  const selected =
    opened &&
    context &&
    opened.context.scope === context.scope &&
    opened.context.channelId === context.channelId &&
    available.includes(opened.panel)
      ? opened
      : undefined;
  useLayoutEffect(() => {
    if (opened && !selected) setOpened(undefined);
  }, [opened, selected]);
  const activeOpening = useRef<Opening>(undefined);
  useLayoutEffect(() => {
    activeOpening.current = selected;
    return () => {
      activeOpening.current = undefined;
    };
  }, [selected]);
  const hide = (opening: Opening) => {
    if (activeOpening.current !== opening) return;
    setOpened((current) => (current === opening ? undefined : current));
    if (opening.trigger?.isConnected) opening.trigger.focus();
  };
  return {
    launchers: context && (
      <div className={styles.channelLaunchers}>
        {available
          .filter((panel) => panel.channelLauncher)
          .map((panel) => {
            const Launcher = panel.channelLauncher;
            if (!Launcher) return null;
            return (
              <Launcher
                key={`${panel.key}:${panel.revision}`}
                context={context}
                pressed={selected?.panel === panel}
                available={() =>
                  mounted.current === context &&
                  panels.snapshot().includes(panel)
                }
                toggle={(target) => {
                  if (
                    mounted.current !== context ||
                    !panels.snapshot().includes(panel)
                  )
                    return;
                  if (selected?.panel === panel) hide(selected);
                  else
                    setOpened({
                      panel,
                      context,
                      target,
                      trigger:
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null,
                    });
                }}
              />
            );
          })}
      </div>
    ),
    content: selected && (
      <section
        className={styles.channelDrawer}
        aria-label={`${selected.panel.title} drawer`}
      >
        <PanelView
          panel={selected.panel}
          target={selected.target}
          channelContext={context}
          close={() => hide(selected)}
        />
      </section>
    ),
  };
}
