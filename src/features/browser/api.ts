import type { BrowserControlRequest, BrowserStatus } from "./platform";
import type { BrowserAccess, BrowserRecipient } from "./control-access";
import type { browserToolbarUi } from "./toolbar-ui";
import type { Context as ToolContext } from "../../buzz-mcp/client";
import type { ComponentType } from "react";

/** One signed-in Builderlab lifetime; never passed to website JavaScript.
 * `federated` is the public NIP-FI session revision; native holds its token. */
export type BuilderlabViewerSession = Readonly<
  (
    | { credential: string }
    | { federated: string }
    | { broker: { origin: string; revision: string } }
  ) & {
    storage: string;
    signal: AbortSignal;
  }
>;

export type BrowserToolbarProps = Readonly<{
  sessionId: string;
  status: BrowserStatus;
  prepare(): Promise<void>;
  onError(error: string | undefined): void;
  ui: typeof browserToolbarUi;
}>;

export type BrowserViewProps = Readonly<{
  url: string;
  /** Bootstrap only the configured Builderlab tenant's app using its native viewer exchange. */
  builderlab?: BuilderlabViewerSession;
  /** Which polled destinations may reopen after guest eviction. Native auth still validates the destination. */
  canResumeUrl?: ((url: string) => boolean) | undefined;
  /** A plugin contribution beside the address bar for the active session. */
  toolbar?: ComponentType<BrowserToolbarProps> | undefined;
  /** Distinguishes independent views with the same URL and storage. */
  sessionKey?: string | undefined;
  /** Keeps the website's cookies and storage under this name between opens
   * and restarts (1-64 of a-z, 0-9, `-`, `_`, `.`), where the platform can hold
   * them apart from Buzz's own. Without it each open is a private session. */
  storage?: string;
  /** Names the view's tab until the website has a title, and while a hidden
   * tab has not opened it yet. */
  label?: string | undefined;
}>;

export interface Browser {
  readonly available: boolean;
  readonly View: ComponentType<BrowserViewProps>;
  /** Optional browser control. Caller identity/context come from the host's tool call. */
  readonly control?:
    | Readonly<{
        available(): Promise<boolean>;
        eligible(recipient: BrowserRecipient): boolean;
        forRecipient: BrowserAccess["forRecipient"];
        execute(
          agent: string,
          context: ToolContext,
          request: BrowserControlRequest,
        ): Promise<unknown>;
      }>
    | undefined;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    browser: Browser;
  }
}
