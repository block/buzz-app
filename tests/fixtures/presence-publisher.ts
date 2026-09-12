import { createPresenceActivity } from "../../src/features/presence/activity";
import {
  browserPresencePublisherLock,
  createPresencePublisher,
} from "../../src/features/presence/publisher";
const activity = createPresenceActivity();
const publications: string[] = [];
const owner = createPresencePublisher({
  activity: activity.activity,
  lock: browserPresencePublisherLock("isolated-browser-presence-fixture"),
  async publish(status, signal) {
    signal.throwIfAborted();
    publications.push(status);
  },
  random: () => 0,
});
owner.connection(true);
Object.assign(window, {
  publisherFixture: {
    publications,
    state: () => activity.activity.snapshot(),
    diagnostics: () => owner.diagnostics(),
    dispose() {
      owner.dispose();
      activity.dispose();
    },
  },
});
