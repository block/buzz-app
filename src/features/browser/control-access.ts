import type { Context as ToolContext } from "../../buzz-mcp/client";
import type { BrowserControl, BrowserControlRequest } from "./platform";

export type BrowserRecipient = Readonly<{
  agent: string;
  scope: string;
  channel: string;
  root?: string | undefined;
}>;

/** A recipient's grant operations. The grant token stays in `BrowserAccess`. */
export type BrowserRecipientControl = Readonly<{
  available(): Promise<boolean>;
  /** Replaces the recipient's grants on other sessions. */
  grant(sessionId: string): Promise<Readonly<{ revision: number }>>;
  revoke(sessionId: string): Promise<void>;
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
      revision?: number | undefined;
      /** The page stopped being shown, so the grant ended without the
       * person taking control. */
      ended?: true;
    }
  >();

  constructor(
    private readonly native: BrowserControl,
    private readonly eligible: (recipient: BrowserRecipient) => boolean,
  ) {}

  forRecipient(recipient: BrowserRecipient): BrowserRecipientControl {
    return {
      available: () => this.native.available(),
      grant: async (session) => {
        if (!this.eligible(recipient))
          throw new Error("Choose an agent running in this Buzz conversation.");
        const entry = {
          recipient,
          token: undefined as string | undefined,
          revision: undefined as number | undefined,
        };
        // No await between the removal and the add, so two concurrent grants
        // for one recipient cannot both survive.
        this.revokeRecipient(recipient, session);
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
            entry.revision = grant.revision;
            return { revision: grant.revision };
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
        if (!current?.ended) this.grants.delete(session);
        return this.ordered(session, () => this.native.revoke(session));
      },
    };
  }

  /** Removes the recipient's grants on sessions other than `keep`. */
  private revokeRecipient(recipient: BrowserRecipient, keep: string): void {
    for (const [session, entry] of this.grants) {
      if (
        session === keep ||
        entry.recipient.agent !== recipient.agent ||
        entry.recipient.scope !== recipient.scope ||
        entry.recipient.channel !== recipient.channel ||
        entry.recipient.root !== recipient.root
      )
        continue;
      if (entry.ended) {
        this.grants.delete(session);
        continue;
      }
      // A failed native revoke leaves a token that execute can no longer
      // reach, because the entry is already gone.
      void this.forRecipient(entry.recipient)
        .revoke(session)
        .catch(() => undefined);
    }
  }

  /** Native code ended the grant on `session` because its page stopped being
   * shown. Its agent then gets `not_visible`, which tells it to open the page
   * again, until the page is shared again. A `revision` older than the grant
   * comes from a status read before the grant and changes nothing. */
  ended(session: string, revision?: number): void {
    const entry = this.grants.get(session);
    if (
      entry?.token &&
      (revision === undefined || revision >= (entry.revision ?? 0))
    )
      this.grants.set(session, { recipient: entry.recipient, ended: true });
  }

  async execute(
    agent: string,
    context: ToolContext,
    request: BrowserControlRequest,
  ) {
    const root = context.topLevel ? undefined : context.root;
    const caller = [...this.grants.values()].filter(
      ({ recipient }) =>
        recipient.agent === agent &&
        recipient.channel === context.channel &&
        recipient.root === root &&
        this.eligible(recipient),
    );
    const matches = caller.filter(({ token }) => token);
    const entry = matches[0];
    if (!entry?.token && caller.some(({ ended }) => ended))
      throw new Error(
        "not_visible: The page is no longer shown, so open it again.",
      );
    if (matches.length !== 1 || !entry?.token)
      throw new Error(
        matches.length
          ? "unavailable: More than one browser is shared with this agent in this conversation."
          : "unavailable: No browser is shared with you in this conversation.",
      );
    const result = await this.native.execute(entry.token, request);
    if (
      !this.eligible(entry.recipient) ||
      ![...this.grants.values()].includes(entry)
    )
      throw new Error("not_visible: Browser access was revoked.");
    return result;
  }
}
