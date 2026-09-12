import { invoke, isTauri } from "@tauri-apps/api/core";

export type ShellContext = Readonly<{
  channelId: string;
  channelName: string;
  threadId?: string;
  npub: string;
  relayUrl: string;
}>;
export type TerminalBridge = {
  available: boolean;
  createOwner(): Promise<string>;
  spawn(
    owner: string,
    context: ShellContext,
    cols: number,
    rows: number,
  ): Promise<string>;
  read(owner: string, id: string): Promise<{ data: number[]; exited: boolean }>;
  write(owner: string, id: string, data: string): Promise<void>;
  resize(owner: string, id: string, cols: number, rows: number): Promise<void>;
  close(owner: string, id: string): Promise<void>;
  closeOwner(owner: string): Promise<void>;
};
export const nativeBridge: TerminalBridge = {
  available: isTauri(),
  createOwner: () => invoke("terminal_create_owner"),
  spawn: (owner, context, cols, rows) =>
    invoke("terminal_spawn", { owner, context, cols, rows }),
  read: (owner, id) => invoke("terminal_read", { owner, id }),
  write: (owner, id, data) => invoke("terminal_write", { owner, id, data }),
  resize: (owner, id, cols, rows) =>
    invoke("terminal_resize", { owner, id, cols, rows }),
  close: (owner, id) => invoke("terminal_close", { owner, id }),
  closeOwner: (owner) => invoke("terminal_close_owner", { owner }),
};
