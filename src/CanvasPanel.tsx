import {
  createElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import {
  AddMenu,
  Button,
  EmptyState,
  EyeIcon,
  IconButton,
  WheelIcon,
} from "./kit";
import {
  activateItem,
  closeItem,
  nextId,
  openItem,
  setDriver,
  updateItem,
  type CanvasItem,
  type CanvasScene,
} from "./scene";
import type { CanvasChannel } from "./store";
import type { CanvasViews, CanvasViewType } from "./view";
import { styles } from "./styles";

type Edit = (scene: CanvasScene) => CanvasScene;
type Own = { base: CanvasScene; edits: Edit[] } | undefined;

/** Applies each edit that still makes sense: a view it changed may be gone. */
const replay = (scene: CanvasScene, edits: readonly Edit[]) =>
  edits.reduce((current, edit) => {
    try {
      return edit(current);
    } catch {
      return current;
    }
  }, scene);

/** Set while this viewer looks around alone instead of following the driver:
 * the scene they left, and what they have done to it since. One for all the
 * tabs of a canvas, and never saved. */
export function createRoaming() {
  let own: Own;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => own,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: Own | ((was: Own) => Own)) {
      own = typeof next === "function" ? next(own) : next;
      for (const listener of [...listeners]) listener();
    },
  };
}
export type Roaming = ReturnType<typeof createRoaming>;

/** One view of a channel's canvas, in a tab of its own. The first view lives
 * in the canvas's own tab (no `id`); the host opens a tab for each other one.
 * Who drives and what each view shows is the shared scene; following is this
 * viewer's own choice. */
export function CanvasPanel({
  channel,
  roaming,
  views,
  viewer,
  name,
  id,
  open,
  close,
  TabTitle,
}: {
  channel: CanvasChannel;
  roaming: Roaming;
  views: CanvasViews;
  viewer: string;
  name(pubkey: string): string;
  /** The view this tab shows; none for the canvas's own tab. */
  id?: string | undefined;
  /** Shows the tab of a view, or the canvas's own. */
  open(id?: string): void;
  /** Closes this tab, for this viewer only. */
  close(): void;
  /** Names this tab, where the host can. */
  TabTitle?: ComponentType<{ label: string }> | undefined;
}) {
  const shared = useSyncExternalStore(channel.subscribe, channel.snapshot);
  const types = useSyncExternalStore(views.subscribe, views.list);
  const own = useSyncExternalStore(roaming.subscribe, roaming.snapshot);
  const driver = shared.scene.driver;
  const driving = driver === viewer;
  const led = !!driver && !driving;
  useEffect(() => {
    if (own && !led) roaming.set(undefined);
  }, [own, led, roaming]);
  const alone = led && !!own;
  const following = led && !own;
  const scene = alone && own ? replay(own.base, own.edits) : shared.scene;
  const first = scene.items[0];
  const item = id ? scene.items.find((other) => other.id === id) : first;
  /** The tab a view is in. */
  const tabOf = (view: string) => (view === first?.id ? undefined : view);

  const change = async (update: Edit) => {
    if (following) return;
    if (alone)
      roaming.set(
        (current) =>
          current && { ...current, edits: [...current.edits, update] },
      );
    else
      await channel
        // Someone may have taken control while this change waited its turn.
        .change((latest) =>
          latest.driver && latest.driver !== viewer ? latest : update(latest),
        )
        // The channel shows why a save failed; nothing more to do with it here.
        .catch(() => {});
  };

  // The host covers a tab that isn't the one chosen in its pane.
  const root = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const check = () => setShown(!root.current?.closest("[data-covered]"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-covered"],
    });
    return () => observer.disconnect();
  }, []);

  const now = { change, open, close, tabOf };
  const latest = useRef(now);
  latest.current = now;
  // The tab the driver looks at is the view in front, for everyone following.
  const mine = item?.id;
  useEffect(() => {
    if (shown && mine && (driving || alone))
      void latest.current.change((current) =>
        current.active === mine ? current : activateItem(current, mine),
      );
  }, [shown, mine, driving, alone]);
  // Whoever doesn't steer is taken to the view in front when it changes. The
  // one who steers never is, or a slow save could take them back and forth.
  const front = scene.active;
  const went = useRef(following ? undefined : front);
  useEffect(() => {
    if (went.current === front) return;
    went.current = front;
    if (front && front !== mine && !driving && !alone)
      latest.current.open(latest.current.tabOf(front));
  }, [front, mine, driving, alone]);
  // A tab whose view is gone closes, and so does one whose view has become
  // the first: the canvas's own tab shows that now.
  const gone = !!id && shared.status === "ready" && !item;
  const moved = !!id && item === first;
  useEffect(() => {
    if (!gone && !moved) return;
    if (moved && shown) latest.current.open();
    latest.current.close();
  }, [gone, moved, shown]);

  // Room for the buttons at the end of a view's top row.
  const buttons = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = buttons.current;
    const canvas = root.current;
    if (!element || !canvas) return;
    const measure = () =>
      canvas.style.setProperty(
        "--buzz-canvas-room",
        `${element.offsetWidth}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The "+" belongs beside the tabs, in the host's strip above this panel. A
  // plugin has no place of its own there, so the button's element is moved
  // into the strip, after the last tab, and moved back before it is hidden or
  // removed. Without a strip it stays in the view's row.
  const plus = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = plus.current;
    const home = element?.parentElement;
    const canvas = root.current;
    if (!element || !home || !canvas || !shown) return;
    let strip: Element | null = null;
    for (let up = canvas.parentElement; up && !strip; up = up.parentElement)
      strip = up.querySelector('[role="tablist"]');
    if (!strip) return;
    const tabs = strip;
    const place = () => {
      // Past every tab; another tab's "+" may briefly be here too.
      let after =
        element.parentElement === tabs ? element.nextElementSibling : tabs;
      while (after && after !== tabs && after.hasAttribute("data-canvas-plus"))
        after = after.nextElementSibling;
      if (after) tabs.append(element);
      // Exactly as tall as a tab and level with it, however the strip lays
      // its tabs out: the button is then centred on the tabs' own centre line.
      const tab = tabs.querySelector('[role="tab"]')?.getBoundingClientRect();
      if (!tab) return;
      element.style.height = `${tab.height}px`;
      element.style.marginTop = "0px";
      const off = tab.top - element.getBoundingClientRect().top;
      element.style.marginTop = `${off}px`;
    };
    place();
    // The host adds tabs at the end: stay after them.
    const changed = new MutationObserver(place);
    changed.observe(tabs, { childList: true });
    const resized = new ResizeObserver(place);
    resized.observe(tabs);
    return () => {
      changed.disconnect();
      resized.disconnect();
      element.removeAttribute("style");
      home.prepend(element);
    };
  }, [shown]);

  const takeControl = () => {
    // Followers are taken to the view this viewer is looking at.
    const edits = [
      ...(own?.edits ?? []),
      ...(mine ? [(next: CanvasScene) => activateItem(next, mine)] : []),
    ];
    // Looking around alone ends once this viewer drives, not before: the tabs
    // of views only they have yet would close in between.
    void channel
      // Onto the latest scene, so what others added meanwhile survives.
      .change((next) => setDriver(replay(next, edits), viewer))
      .catch(() => {});
  };
  const add = (type: CanvasViewType) => {
    const wanted = nextId(scene, type.type);
    void change((current) =>
      openItem(current, views, {
        type: type.type,
        state: type.initial,
        // Someone may have taken that id meanwhile; theirs is not replaced.
        ...(current.items.some((other) => other.id === wanted)
          ? {}
          : { id: wanted }),
      }),
    ).then(() => {
      if (first) latest.current.open(wanted);
    });
  };
  const titleOf = (view: CanvasItem) =>
    view.title ?? views.get(view.type)?.title ?? "Unknown view";
  const driverName = driver ? name(driver) : "";
  const status = driving
    ? "You are driving. Followers see what you see."
    : following
      ? `Following ${driverName}.`
      : alone
        ? `Looking around on your own. ${driverName} is driving.`
        : "Nobody is driving. Changes are shared with everyone.";
  const addable = types.filter((view) => view.initial !== undefined);
  const menu = [
    ...scene.items
      .filter((other) => other !== item)
      .map((other) => ({
        label: `Go to ${titleOf(other)}`,
        onSelect: () => open(tabOf(other.id)),
      })),
    ...(following
      ? []
      : [
          ...addable.map((type) => ({
            label: `New ${type.title.toLowerCase()}`,
            onSelect: () => add(type),
          })),
          ...(item
            ? [
                {
                  label: "Remove this view for everyone",
                  onSelect: () =>
                    void change((current) => closeItem(current, item.id)),
                },
              ]
            : []),
        ]),
  ];
  const type = item && views.get(item.type);
  const View = type?.component;
  return (
    <section ref={root} className={styles.canvas} aria-label="Canvas">
      <p className={styles.quiet} role="status">
        {shared.status === "loading" ? "Loading the canvas…" : status}
      </p>
      {TabTitle && item && <TabTitle label={titleOf(item)} />}
      <div ref={buttons} className={styles.buttons}>
        <span ref={plus} className={styles.plus} data-canvas-plus="">
          {shown && menu.length > 0 && <AddMenu label="Views" items={menu} />}
        </span>
        {led && (
          <IconButton
            label={following ? "Stop following" : `Follow ${driverName}`}
            title={
              following
                ? `Following ${driverName}. Look around on your own`
                : `Follow ${driverName}`
            }
            selected={following}
            onClick={() =>
              roaming.set(
                following ? { base: shared.scene, edits: [] } : undefined,
              )
            }
          >
            <EyeIcon />
          </IconButton>
        )}
        <IconButton
          label={driving ? "Stop driving" : "Take control"}
          title={
            driving
              ? "You are driving. Stop driving"
              : led
                ? `${driverName} is driving. Take control`
                : "Take control: others see what you see"
          }
          selected={driving}
          disabled={shared.status === "loading"}
          onClick={
            driving
              ? () => void change((current) => setDriver(current))
              : takeControl
          }
        >
          <WheelIcon />
        </IconButton>
      </div>
      {shared.error && (
        <p className={styles.error} role="alert">
          {shared.error}
        </p>
      )}
      {item && View ? (
        <div key={item.id} className={styles.view}>
          <View
            state={item.state}
            interactive={!following}
            update={(next) =>
              void change((current) =>
                updateItem(current, views, item.id, next),
              )
            }
          />
        </div>
      ) : (
        <div className={styles.empty}>
          {item ? (
            <EmptyState
              title="This view needs a plugin"
              description={`Nothing on this device can show a "${item.type}" view.`}
            />
          ) : (
            <EmptyState
              title="Nothing on the canvas yet"
              description={
                following
                  ? `${driverName} hasn't opened anything.`
                  : "Add a view, or ask an agent to open one. Everyone in this conversation sees it."
              }
              action={
                !following && addable.length ? (
                  <div className={styles.actions}>
                    {addable.map((type) => (
                      <Button key={type.type} onClick={() => add(type)}>
                        {type.title}
                      </Button>
                    ))}
                  </div>
                ) : undefined
              }
            />
          )}
        </div>
      )}
    </section>
  );
}
