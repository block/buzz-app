import type { Context } from "@deepseek-ai/cordis";
import { createElement, useState, type ComponentType } from "react";
import type { Browser, BrowserViewProps } from "./api";
import { BrowserHostView } from "./BrowserHostView";
import { ExternalBrowserNotice } from "./ExternalBrowserNotice";
import { inAppBrowserDisabled } from "./in-app-browser-preference";
import { createBrowserPlatform, type BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";

export class BrowserService implements Browser {
  readonly View: ComponentType<BrowserViewProps>;

  constructor(
    ctx: Context,
    private readonly platform: BrowserPlatform = createBrowserPlatform(),
  ) {
    const sessions = new BrowserSessions(this.platform);
    this.View = (props) => {
      // Fixed at mount: turning the setting on leaves open tabs alone.
      const [external] = useState(inAppBrowserDisabled.read);
      return createElement(external ? ExternalBrowserNotice : BrowserHostView, {
        ...props,
        platform: this.platform,
        sessions,
      });
    };
    ctx.provide("browser", this);
  }
  get available() {
    return this.platform.available && !inAppBrowserDisabled.read();
  }
}
