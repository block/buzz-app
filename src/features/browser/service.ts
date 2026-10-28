import { Service, type Context } from "@deepseek-ai/cordis";
import { createElement, type ComponentType } from "react";
import type { Browser, BrowserViewProps } from "./api";
import { BrowserHostView } from "./BrowserHostView";
import { createBrowserPlatform, type BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";

export class BrowserService extends Service implements Browser {
  readonly View: ComponentType<BrowserViewProps>;
  readonly control: Browser["control"];

  constructor(
    ctx: Context,
    private readonly platform: BrowserPlatform = createBrowserPlatform(),
  ) {
    super(ctx, "browser");
    const control = platform.control;
    this.control = control
      ? Object.freeze({
          available: () => control.available(),
          execute: (token, request) => control.execute(token, request),
        })
      : undefined;
    const sessions = new BrowserSessions(this.platform);
    this.View = (props) =>
      createElement(BrowserHostView, {
        ...props,
        platform: this.platform,
        sessions,
      });
  }
  get available() {
    return this.platform.available;
  }
}
