import type { ComponentType } from "react";

export type BrowserViewProps = Readonly<{ url: string }>;

export interface Browser {
  readonly available: boolean;
  readonly View: ComponentType<BrowserViewProps>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    browser: Browser;
  }
}
