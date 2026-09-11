import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import { terminalAppearance } from "./appearance";
import { createSplash } from "./splash";
import styles from "./Terminal.module.css";

export type TerminalScreen = {
  mount(host: HTMLElement): () => void;
  output(data: Uint8Array): Promise<void>;
  dispose(): void;
};
export function createScreen(
  input: (data: string) => void,
  resize: (cols: number, rows: number) => void,
): TerminalScreen {
  const element = document.createElement("div");
  element.dataset.buzzUi = "";
  element.className = `${styles.emulator} text-mono font-mono`;
  const splash = createSplash(element);
  const terminal = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    minimumContrastRatio: 4.5,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.onData((data) => {
    splash.dismiss();
    input(data);
  });
  terminal.onResize(({ cols, rows }) => resize(cols, rows));
  // Leave the app chord to its single dispatcher even in xterm's hidden textarea.
  terminal.attachCustomKeyEventHandler(
    (event) =>
      !(
        event.key.toLowerCase() === "j" &&
        !event.altKey &&
        !event.shiftKey &&
        (/Mac|iPhone|iPad/.test(navigator.platform)
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey)
      ),
  );
  let opened = false;
  let disposed = false;
  let receivedOutput = false;
  let detach: (() => void) | undefined;
  const pending = new Set<() => void>();
  return {
    mount(host) {
      detach?.();
      host.append(element);
      terminal.options = terminalAppearance(element);
      if (!opened) {
        terminal.open(element);
        opened = true;
      }
      let attached = true;
      const update = () => {
        if (!attached || disposed) return;
        terminal.options = terminalAppearance(element);
        if (host.clientWidth && host.clientHeight) {
          fit.fit();
          splash.layout();
          if (receivedOutput) splash.show();
        }
      };
      const observer = new ResizeObserver(update);
      observer.observe(host);
      const appearance = new MutationObserver(update);
      appearance.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-color-mode", "style", "class"],
      });
      element.addEventListener("keydown", splash.dismiss);
      element.addEventListener("pointerdown", splash.dismiss);
      update();
      // Loaded mono metrics can differ from the fallback used on first mount.
      void document.fonts.ready.then(update);
      terminal.focus();
      const cleanup = () => {
        attached = false;
        observer.disconnect();
        appearance.disconnect();
        element.removeEventListener("keydown", splash.dismiss);
        element.removeEventListener("pointerdown", splash.dismiss);
        splash.dismiss();
        element.remove();
        if (detach === cleanup) detach = undefined;
      };
      detach = cleanup;
      return cleanup;
    },
    output(data) {
      if (disposed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending.add(resolve);
        terminal.write(data, () => {
          if (!disposed && data.length) {
            receivedOutput = true;
            splash.show();
          }
          pending.delete(resolve);
          resolve();
        });
      });
    },
    dispose() {
      disposed = true;
      detach?.();
      splash.dismiss();
      terminal.dispose();
      element.remove();
      for (const resolve of pending) resolve();
      pending.clear();
    },
  };
}
