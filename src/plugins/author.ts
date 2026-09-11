// FOUNDATION: Type-only author entry. Runtime capabilities come from injected ctx.
export type { PluginManifest, PluginModule } from "./api";
export type { Context } from "@deepseek-ai/cordis";
export type { Page, Pages } from "../features/pages/service";
export type { Panel, Panels } from "../features/panels/service";
export type { Conversation } from "../features/conversation/service";
export type {
  ComposerToolProps,
  ComposerTool,
  InlineContent,
  InlineRange,
  InlineRenderer,
} from "../features/conversation/contracts";
export type { RelayData, RelaySnapshot } from "../features/relay/service";

export type {
  Shortcuts,
  Shortcut,
  KeyBinding,
  RegisteredShortcut,
} from "../features/shortcuts/service";
