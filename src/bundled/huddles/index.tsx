import type { PluginModule } from "../../plugins/api";
import { nativeHuddles } from "../../features/huddle/bridge";
import { openHuddleAudio } from "../../features/huddle/audio";
import { createHuddles } from "../../features/huddle/service";
import { createHuddleWindow } from "../../features/huddle/window";
import { HuddleCapsule } from "./HuddleCapsule";
import { HuddleLauncher } from "./HuddleLauncher";

export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!nativeHuddles.available) return;
  const huddles = createHuddles(ctx.relay, nativeHuddles, openHuddleAudio);
  const companion = createHuddleWindow(huddles, ctx.relay);
  ctx.effect(() => async () => {
    await Promise.all([companion.dispose(), huddles.dispose()]);
  });
  ctx.panels.register({
    id: "huddles",
    title: "Huddles",
    matches: () => false,
    toolbar: () => (
      <HuddleCapsule
        huddles={huddles}
        relay={ctx.relay}
        companion={companion}
      />
    ),
    channelLauncher: (props) => (
      <HuddleLauncher
        {...props}
        huddles={huddles}
        showWindow={companion.open}
      />
    ),
    // This contribution supplies controls only; it never opens a channel panel.
    component: () => null,
  });
};
