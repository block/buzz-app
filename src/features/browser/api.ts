export type BrowserOpenResult =
  | { status: "opened" }
  | { status: "unavailable" }
  | { status: "invalid-url"; reason: string }
  | { status: "failed"; reason: string };

export interface Browser {
  readonly available: boolean;
  open(url: string): Promise<BrowserOpenResult>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    browser: Browser;
  }
}
