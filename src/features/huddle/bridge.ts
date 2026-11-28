import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { relayOrigin } from "../communities/destination";

export type HuddleDestination = Readonly<{
  scope: string;
  viewer: string;
  relayUrl: string;
  channelId: string;
  channelName: string;
}>;
export type HuddleUpdate =
  | { type: "connected"; room: string; participants: string[] }
  | { type: "participants"; participants: string[] }
  | { type: "audio"; peer: string; samples: number[] }
  | { type: "ended"; error: string | null };
export type HuddleBridge = {
  available: boolean;
  open(
    id: string,
    destination: HuddleDestination,
    room: string | undefined,
    receive: (update: HuddleUpdate) => void,
    agent?: string,
  ): Promise<void>;
  close(id: string): Promise<void>;
  touch(id: string): Promise<void>;
  send(id: string, samples: number[]): Promise<void>;
  /** The OS input mute, where the host has one, so headset mute gestures and
   * the Huddle button stay in step. `start` resolves to a token, or null. */
  inputMute?: {
    start(change: (muted: boolean) => void): Promise<number | null>;
    set(muted: boolean): Promise<void>;
    stop(token: number): Promise<void>;
  };
};
export const nativeHuddles: HuddleBridge = {
  available: isTauri(),
  open(id, destination, room, receive, agent) {
    const updates = new Channel<HuddleUpdate>();
    updates.onmessage = receive;
    return invoke("huddle_open", {
      call: {
        id,
        community: relayOrigin(destination.relayUrl),
        viewer: destination.viewer,
        parent: destination.channelId,
        room: room ?? null,
        agent: agent ?? null,
      },
      updates,
    });
  },
  close: (id) => invoke("huddle_close", { id }),
  touch: (id) => invoke("huddle_touch", { id }),
  send: (id, samples) => invoke("huddle_pcm", { id, samples }),
  inputMute: {
    start(change) {
      const changes = new Channel<boolean>();
      changes.onmessage = change;
      return invoke("input_mute_start", { changes });
    },
    set: (muted) => invoke("input_mute_set", { muted }),
    stop: (token) => invoke("input_mute_stop", { token }),
  },
};
