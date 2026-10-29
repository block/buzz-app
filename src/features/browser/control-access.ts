import type { Context as ToolContext } from "../../buzz-mcp/client";
import type { BrowserControl, BrowserControlRequest } from "./platform";

export type BrowserRecipient = Readonly<{
  agent: string;
  scope: string;
  channel: string;
  root?: string | undefined;
}>;

/** One-time assignment minted by the host only for an agent-created page. */
export type BrowserInitialShare = Readonly<{
  agent: string;
  claim(): boolean;
  valid(): boolean;
  prepare(): Promise<void>;
  complete(error?: unknown): void;
}>;

/** Tokens stay in this app, never in agent arguments or conversation messages. */
export class BrowserAccess {
  private readonly pending = new Map<string, Promise<unknown>>();
  private ordered<T>(session: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(session) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.pending.set(session, next);
    void next
      .finally(() => {
        if (this.pending.get(session) === next) this.pending.delete(session);
      })
      .catch(() => undefined);
    return next;
  }
  private readonly grants = new Map<
    string,
    {
      recipient: BrowserRecipient;
      token?: string | undefined;
    }
  >();

  constructor(
    private readonly native: BrowserControl,
    private readonly eligible: (recipient: BrowserRecipient) => boolean,
  ) {}

  forRecipient(recipient: BrowserRecipient): BrowserControl {
    return {
      available: () => this.native.available(),
      grant: async (session) => {
        if (!this.eligible(recipient))
          throw new Error("Choose an agent running in this Buzz conversation.");
        const entry = { recipient, token: undefined as string | undefined };
        this.grants.set(session, entry);
        try {
          return await this.ordered(session, async () => {
            if (this.grants.get(session) !== entry)
              throw new Error("Browser access was revoked.");
            const grant = await this.native.grant(session);
            if (this.grants.get(session) !== entry)
              throw new Error("Browser access was revoked.");
            if (!this.eligible(recipient)) {
              this.grants.delete(session);
              await this.native.revoke(session);
              throw new Error("Browser access was revoked.");
            }
            entry.token = grant.token;
            return grant;
          });
        } catch (error) {
          if (this.grants.get(session) === entry) this.grants.delete(session);
          throw error;
        }
      },
      revoke: (session) => {
        const current = this.grants.get(session);
        if (current && current.recipient !== recipient)
          return Promise.resolve();
        this.grants.delete(session);
        return this.ordered(session, () => this.native.revoke(session));
      },
      // Execution always enters through the authenticated tool caller below.
      execute: async () => {
        throw new Error("Use the browser agent tool.");
      },
    };
  }

  /** An agent-created page becomes that caller's browser for this conversation. */
  async revokeRecipient(recipient: BrowserRecipient): Promise<void> {
    await Promise.all(
      [...this.grants]
        .filter(
          ([, entry]) =>
            entry.recipient.agent === recipient.agent &&
            entry.recipient.scope === recipient.scope &&
            entry.recipient.channel === recipient.channel &&
            entry.recipient.root === recipient.root,
        )
        .map(([session, entry]) =>
          this.forRecipient(entry.recipient).revoke(session),
        ),
    );
  }

  async execute(
    agent: string,
    context: ToolContext,
    request: BrowserControlRequest,
  ) {
    const root = context.topLevel ? undefined : context.root;
    const matches = [...this.grants.values()].filter(
      ({ recipient, token }) =>
        token &&
        recipient.agent === agent &&
        recipient.channel === context.channel &&
        recipient.root === root &&
        this.eligible(recipient),
    );
    const entry = matches[0];
    if (matches.length !== 1 || !entry?.token)
      throw new Error(
        matches.length
          ? "More than one browser is shared. Take control of the other browser first."
          : "No browser is shared with you in this conversation. Use action open with a URL to create a new page, or ask the owner to share an existing page.",
      );
    const result = await this.native.execute(entry.token, request);
    if (
      !this.eligible(entry.recipient) ||
      ![...this.grants.values()].includes(entry)
    )
      throw new Error("Browser access was revoked.");
    return result;
  }
}
