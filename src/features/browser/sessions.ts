import type { BrowserBounds, BrowserPlatform } from "./platform";

/** Orders replacement cleanup before the next native guest is attached. */
export class BrowserSessions {
  private lifecycle = Promise.resolve();

  constructor(private readonly platform: BrowserPlatform) {}

  attach(
    url: string,
    bounds: BrowserBounds,
    current: () => boolean,
  ): Promise<string | undefined> {
    return this.enqueue(async () => {
      if (!current()) return undefined;
      const sessionId = await this.platform.attach(url, bounds);
      if (current()) return sessionId;
      await this.platform.detach(sessionId);
      return undefined;
    });
  }

  detach(sessionId: string): Promise<void> {
    return this.enqueue(() => this.platform.detach(sessionId));
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
