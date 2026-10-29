import type { BrowserControlRequest } from "./platform";
import type { Context as ToolContext } from "../../buzz-mcp/client";
import type { ComponentType } from "react";

export type BrowserViewProps = Readonly<{
  url: string;
  /** Keeps the website's cookies and storage under this name between opens
   * and restarts (1-64 of a-z, 0-9, `-`, `_`, `.`), where the platform can hold
   * them apart from Buzz's own. Without it each open is a private session. */
  storage?: string;
  /** Names the view's tab until the website has a title, and while a hidden
   * tab has not opened it yet. */
  label?: string | undefined;
  /** The conversation this website was opened beside. */
  conversation?:
    | Readonly<{ channel: string; root?: string | undefined }>
    | undefined;
}>;

export interface Browser {
  readonly available: boolean;
  readonly View: ComponentType<BrowserViewProps>;
  /** Internal preview. Caller identity/context come from the host's tool call. */
  readonly control?:
    | Readonly<{
        available(): Promise<boolean>;
        readonly View: ComponentType<{
          target: string;
          conversation?: BrowserViewProps["conversation"];
        }>;
        open(
          agent: string,
          context: ToolContext,
          options: Pick<BrowserViewProps, "url" | "storage">,
        ): Promise<unknown>;
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
