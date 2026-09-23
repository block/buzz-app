/** Private DOM handoff for xterm, not an injected/exported plugin capability. */
export const TERMINAL_KEY_EVENT = "buzz:terminal-keydown";

/**
 * xterm calls this before translating a key into PTY input. Keep the original
 * event (and its editable/modal composed path) while synchronously consulting
 * the one dispatcher; never redispatch an in-flight KeyboardEvent.
 */
export function forwardTerminalKey(host: Window, event: KeyboardEvent) {
  if (event.type !== "keydown") return true;
  if (!event.defaultPrevented) {
    host.dispatchEvent(
      new CustomEvent<KeyboardEvent>(TERMINAL_KEY_EVENT, { detail: event }),
    );
  }
  return !event.defaultPrevented;
}
