import type { ReadTransport } from "../src/features/relay/transport";
import type { LiveSubscription } from "../src/features/relay/live";
import type { RelayEvent } from "../src/features/relay/events";
export function brokerSocket(
  publish?: (event: RelayEvent) => string | Promise<string>,
): {
  factory: (url: string) => WebSocket;
  publications: RelayEvent[];
};
export function openBrokerSocket(
  transport: ReadTransport,
): Promise<LiveSubscription>;
