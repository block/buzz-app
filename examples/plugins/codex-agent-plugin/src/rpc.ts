import type { Host } from "@buzz/author";
export type Wire = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string };
};
export type Connection = Awaited<ReturnType<Host["connectCommand"]>>;
export type Connect = Host["connectCommand"];
/** Exactly one request owner, including startup, unexpected exit and timeout. */
export class AppServer {
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private connection?: Connection;
  private failure?: Error;
  private listeners = new Set<(message: Wire) => void>();
  async open(connect: Connect, signal: AbortSignal) {
    this.connection = await connect("app-server", {
      signal,
      onLine: (line) => {
        let message: Wire;
        try {
          message = JSON.parse(line);
        } catch {
          this.fail(new Error("Invalid JSON from Codex"));
          this.connection?.close();
          return;
        }
        const waiter =
          typeof message.id === "number" && !message.method
            ? this.pending.get(message.id)
            : undefined;
        if (waiter) {
          this.pending.delete(message.id as number);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new Error(message.error.message));
          else waiter.resolve(message.result);
        } else for (const listener of this.listeners) listener(message);
      },
      onClose: (error) => this.fail(error),
    });
    if (this.failure) {
      this.connection.close();
      throw this.failure;
    }
    await this.request("initialize", {
      clientInfo: {
        name: "buzz_codex_plugin",
        title: "Buzz Codex",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
          "item/plan/delta",
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
        ],
      },
    });
    await this.send({ method: "initialized" });
    return this;
  }
  onMessage(listener: (message: Wire) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners)
      listener({
        method: "connection/closed",
        params: { message: error.message },
      });
  }
  send(message: Wire) {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.connection)
      return Promise.reject(new Error("Codex is not connected"));
    return this.connection.send(JSON.stringify(message));
  }
  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      void this.send({ id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  close() {
    this.connection?.close();
    this.fail(new Error("Codex connection closed"));
  }
}
