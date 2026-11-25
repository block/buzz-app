/*
 * The plugin API services Vim keys uses, set when the plugin starts, so the
 * modules below read them without passing them through every call.
 */
import type { Messages } from "../../plugins/author";

export const host: { messages: Messages } = {
  messages: undefined as unknown as Messages,
};
