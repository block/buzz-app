import { createHeadPersistence } from "../../src/features/relay/persistence";
import { createRelaySession } from "../../src/features/relay/session";
import { eventDto } from "../../src/features/relay/events";
import {
  keypair,
  message,
  bounds,
  profile,
  roster,
  metadata,
} from "../../src/features/relay/testing";

const fixture = {
  createHeadPersistence,
  createRelaySession,
  eventDto,
  keypair,
  message,
  bounds,
  profile,
  roster,
  metadata,
};
declare global {
  interface Window {
    headPersistence: typeof fixture;
  }
}
window.headPersistence = fixture;
