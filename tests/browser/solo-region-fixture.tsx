import type { BundledPlugin } from "../../src/plugins/manager";
import type {
  SoloRegionBinding,
  SoloRegionSnapshot,
} from "../../src/features/channel-navigation/solo-navigation-contract";

declare global {
  interface Window {
    fixtureSoloRegion?: {
      classify(id: string): Promise<void>;
      present(removed: string[], hidden: string[]): void;
    };
  }
}

export const soloRegionFixture: BundledPlugin = {
  manifest: {
    id: "fixture.solo-region",
    name: "Solo region fixture",
    apiVersion: 1,
  },
  module: {
    inject: ["soloNavigation"],
    apply(ctx) {
      if (!new URL(location.href).searchParams.has("solo-region-fixture"))
        return;
      let binding: SoloRegionBinding;
      let snapshot: SoloRegionSnapshot;
      let removed: string[] = [],
        hidden: string[] = [];
      let notify = () => {};
      if (!ctx.soloNavigation) throw new Error("Solo navigation unavailable");
      const handle = ctx.soloNavigation.registerSource({
        id: "work",
        title: "Solo",
        icon: null,
        bind(next) {
          binding = next;
          snapshot = { status: "ready", binding, revision: 1 };
        },
        read: () => snapshot,
        subscribe(listener) {
          notify = listener;
          return () => {
            notify = () => {};
          };
        },
        component: ({ ui, live }) => (
          <>
            {[...live]
              .filter((id) => !removed.includes(id))
              .map((id) => (
                <div
                  key={id}
                  style={hidden.includes(id) ? { display: "none" } : undefined}
                >
                  <ui.Conversation channelId={id}>
                    {(c) => (
                      <ui.Card>
                        <c.Menu>
                          <c.Link label={c.name} />
                          <c.Actions />
                        </c.Menu>
                      </ui.Card>
                    )}
                  </ui.Conversation>
                </div>
              ))}
          </>
        ),
      });
      window.fixtureSoloRegion = {
        classify: (id) => handle.classify(binding, id),
        present(nextRemoved, nextHidden) {
          removed = nextRemoved;
          hidden = nextHidden;
          snapshot = { ...snapshot, revision: snapshot.revision + 1 };
          notify();
        },
      };
      ctx.effect(() => () => {
        delete window.fixtureSoloRegion;
      });
    },
  },
};
