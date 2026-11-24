import { createElement, Fragment, useState, useSyncExternalStore } from "react";
import { AddMenu, Button, EmptyState, Tabs } from "./kit";
import {
  activateItem,
  closeItem,
  openItem,
  setDriver,
  updateItem,
  type CanvasItem,
  type CanvasScene,
} from "./scene";
import type { CanvasChannel } from "./store";
import type { CanvasViews } from "./view";
import { styles } from "./styles";

type Edit = (scene: CanvasScene) => CanvasScene;

/** Applies each edit that still makes sense: a view it changed may be gone. */
const replay = (scene: CanvasScene, edits: readonly Edit[]) =>
  edits.reduce((current, edit) => {
    try {
      return edit(current);
    } catch {
      return current;
    }
  }, scene);

/** A channel's canvas: the views on it, who is driving, and whether this
 * viewer follows them. Following is this viewer's own choice and is never
 * saved; everything else is the shared scene. */
export function CanvasPanel({
  channel,
  views,
  viewer,
  name,
}: {
  channel: CanvasChannel;
  views: CanvasViews;
  viewer: string;
  name(pubkey: string): string;
}) {
  const shared = useSyncExternalStore(channel.subscribe, channel.snapshot);
  const types = useSyncExternalStore(views.subscribe, views.list);
  // Set while this viewer looks around alone instead of following the driver:
  // the scene they left, and what they have done to it since.
  const [own, setOwn] = useState<{ base: CanvasScene; edits: Edit[] }>();
  const driver = shared.scene.driver;
  const driving = driver === viewer;
  const led = !!driver && !driving;
  if (own && !led) setOwn(undefined);
  const roaming = led && !!own;
  const following = led && !own;
  const scene = roaming && own ? replay(own.base, own.edits) : shared.scene;
  const change = (update: Edit) => {
    if (following) return;
    if (roaming)
      setOwn(
        (current) =>
          current && { ...current, edits: [...current.edits, update] },
      );
    else
      void channel
        // Someone may have taken control while this change waited its turn.
        .change((latest) =>
          latest.driver && latest.driver !== viewer ? latest : update(latest),
        )
        // The channel shows why a save failed; nothing more to do with it here.
        .catch(() => {});
  };
  const takeControl = () => {
    // Followers are taken to the view this viewer was looking at alone.
    const looking = roaming ? scene.active : undefined;
    const edits = [
      ...(own?.edits ?? []),
      ...(looking
        ? [(latest: CanvasScene) => activateItem(latest, looking)]
        : []),
    ];
    setOwn(undefined);
    void channel
      // Onto the latest scene, so what others added meanwhile survives.
      .change((latest) => setDriver(replay(latest, edits), viewer))
      .catch(() => {});
  };
  const driverName = driver ? name(driver) : "";
  const status = driving
    ? "You are driving. Followers see what you see."
    : following
      ? `Following ${driverName}.`
      : roaming
        ? `Looking around on your own. ${driverName} is driving.`
        : "Nobody is driving. Changes are shared with everyone.";
  const addable = types.filter((view) => view.initial !== undefined);
  const shown = scene.items.find((item) => item.id === scene.active);
  const view = (item: CanvasItem) => {
    const type = views.get(item.type);
    if (!type)
      return (
        <div className={styles.empty}>
          <EmptyState
            title="This view needs a plugin"
            description={`Nothing on this device can show a "${item.type}" view.`}
          />
        </div>
      );
    const View = type.component;
    return (
      <div key={item.id} className={styles.view}>
        <View
          state={item.state}
          interactive={!following}
          update={(next) =>
            change((current) => updateItem(current, views, item.id, next))
          }
        />
      </div>
    );
  };
  return (
    <section className={styles.canvas} aria-label="Canvas">
      <div className={styles.bar}>
        <p
          className={styles.status}
          role="status"
          data-driving={driving ? "" : undefined}
        >
          {shared.status === "loading" ? "Loading the canvas…" : status}
        </p>
        {following && (
          <Button
            variant="outline"
           
            onClick={() => setOwn({ base: shared.scene, edits: [] })}
          >
            Stop following
          </Button>
        )}
        {roaming && (
          <Button variant="outline" onClick={() => setOwn(undefined)}>
            Follow {driverName}
          </Button>
        )}
        {driving ? (
          <Button
            variant="outline"
           
            onClick={() => change((current) => setDriver(current))}
          >
            Stop driving
          </Button>
        ) : (
          <Button
            variant="prominent"
           
            disabled={shared.status === "loading"}
            onClick={takeControl}
          >
            Take control
          </Button>
        )}
      </div>
      {shared.error && (
        <p className={styles.error} role="alert">
          {shared.error}
        </p>
      )}
      <div className={styles.stage}>
        {scene.items.length ? (
          <>
            <Tabs
              label="Canvas views"
                            value={scene.active}
              onValueChange={(id) =>
                change((current) => activateItem(current, id))
              }
              items={scene.items.map((item) => ({
                value: item.id,
                label:
                  item.title ?? views.get(item.type)?.title ?? "Unknown view",
                onClose: following
                  ? undefined
                  : () => change((current) => closeItem(current, item.id)),
              }))}
              trailing={
                !following && addable.length ? (
                  <AddMenu
                    label="Add a view"
                    items={addable.map((type) => ({
                      label: type.title,
                      onSelect: () =>
                        change((current) =>
                          openItem(current, views, {
                            type: type.type,
                            state: type.initial,
                          }),
                        ),
                    }))}
                  />
                ) : undefined
              }
            />
            {shown && view(shown)}
          </>
        ) : (
          <div className={styles.empty}>
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
                      <Button
                        key={type.type}
                        variant="outline"
                       
                        onClick={() =>
                          change((current) =>
                            openItem(current, views, {
                              type: type.type,
                              state: type.initial,
                            }),
                          )
                        }
                      >
                        {type.title}
                      </Button>
                    ))}
                  </div>
                ) : undefined
              }
            />
          </div>
        )}
      </div>
    </section>
  );
}
