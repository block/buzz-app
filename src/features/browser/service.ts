import { Service, type Context } from "@deepseek-ai/cordis";
import type { Browser, BrowserOpenResult } from "./api";
import { createBrowserPlatform, type BrowserPlatform } from "./platform";

export class BrowserService extends Service implements Browser {
  constructor(
    ctx: Context,
    private readonly platform: BrowserPlatform = createBrowserPlatform(),
  ) {
    super(ctx, "browser");
  }
  get available() {
    return this.platform.available;
  }
  open(url: string): Promise<BrowserOpenResult> {
    return this.platform.open(url);
  }
}
