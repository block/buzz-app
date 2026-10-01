import type { PluginModule } from "../../plugins/api";
import { nativeHuddles } from "../../features/huddle/bridge";
import { openHuddleAudio } from "../../features/huddle/audio";
import { createHuddles } from "../../features/huddle/service";
import { createHuddleWindow } from "../../features/huddle/window";
import { HuddleCapsule } from "./HuddleCapsule";
import { HuddleLauncher } from "./HuddleLauncher";
import { HuddleCard, parseHuddleTarget } from "./HuddleCard";
import { HuddlePanel } from "./HuddlePanel";

export const inject = ["panels", "relay", "conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!nativeHuddles.available) return;
  const huddles = createHuddles(ctx.relay, nativeHuddles, openHuddleAudio);
  const companion = createHuddleWindow(huddles, ctx.relay);
  ctx.conversation.registerMessage({
    id: "huddle",
    title: "Huddle",
    matches: (message) => !!message.huddle,
    component: (props) => (
      <HuddleCard
        {...props}
        relay={ctx.relay}
        huddles={huddles}
        showWindow={companion.open}
      />
    ),
  });
  ctx.effect(() => async () => {
    await Promise.all([companion.dispose(), huddles.dispose()]);
  });
  ctx.panels.register({
    id: "huddles",
    title: "Huddles",
    matches: (target) => !!parseHuddleTarget(target),
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
    channelPlacement: "side",
    component: (props) => <HuddlePanel {...props} relay={ctx.relay} />,
  });
};
