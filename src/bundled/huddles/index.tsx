import {
  remoteDmVoiceCalls,
  withRemoteDmVoiceCalls,
} from "../../features/huddle/remote-dm-voice";
import { dmVoiceAgent } from "../../features/huddle/dm-agent";
import { createHuddleVoices } from "../../features/huddle/voice";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { openFromPanel } from "../../features/panels/opening-pane";
import { createHuddleRing } from "../../features/huddle/ring";
import type { PluginModule } from "../../plugins/api";
import { nativeHuddles } from "../../features/huddle/bridge";
import { openHuddleAudio } from "../../features/huddle/audio";
import { registerHuddlePlayoutTool } from "../../features/huddle/playout-tool";
import {
  createHuddles,
  provideHuddleStatus,
} from "../../features/huddle/service";
import { createHuddleWindow } from "../../features/huddle/window";
import { HuddleCapsule } from "./HuddleCapsule";
import { HuddleLauncher, SoloHuddleMenu } from "./HuddleLauncher";
import { HuddleCard, huddleTarget, parseHuddleTarget } from "./HuddleCard";
import { HuddlePanel } from "./HuddlePanel";

export const inject = [
  "panels",
  "relay",
  "conversation",
  "navigation",
  "agents",
];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!nativeHuddles.available) return;
  const huddles = createHuddles(
    ctx.relay,
    nativeHuddles,
    openHuddleAudio,
    (connection, destination) =>
      dmVoiceAgent(connection, destination, ctx.agents)?.pubkey,
  );
  registerHuddlePlayoutTool(ctx.agents, huddles);
  const remoteVoices = remoteDmVoiceCalls(ctx.relay, ctx.agents);
  const stopVoices = createHuddleVoices(
    withRemoteDmVoiceCalls(huddles, remoteVoices),
    ctx.agents,
    ctx.relay,
    nativeHuddles,
    (call, error) => {
      if (remoteVoices.snapshot().id === call) huddles.remoteVoiceError(error);
      else huddles.voiceError(call, error);
    },
    huddles.voiceDiagnostic,
  );
  provideHuddleStatus(ctx, huddles);
  const stopRing = createHuddleRing(huddles);
  // The Huddle window has no pane; the side column's panel passes its own.
  const openLink = (url: string, pane?: "main" | "side") => {
    const connection = ctx.relay.snapshot();
    if (!connection.viewer || !connection.origin) return false;
    const target = buzzLinkTarget(url, {
      viewer: connection.viewer,
      communityOrigin: connection.origin,
    });
    if (!target) return false;
    openFromPanel(ctx.navigation, target, pane);
    return true;
  };
  const companion = createHuddleWindow(
    huddles,
    ctx.relay,
    undefined,
    ctx.conversation,
    openLink,
    ctx.agents,
  );
  ctx.conversation.registerMessage({
    id: "huddle",
    title: "Huddle",
    matches: (message) => !!message.huddle,
    component: (props) => (
      <HuddleCard
        {...props}
        open={
          props.canOpen(
            huddleTarget(
              props.message.channelId,
              props.message.huddle?.room ?? "",
            ),
          )
            ? props.open
            : undefined
        }
        relay={ctx.relay}
        huddles={huddles}
        showWindow={companion.open}
      />
    ),
  });
  ctx.effect(() => async () => {
    stopRing();
    remoteVoices.dispose();
    await Promise.all([stopVoices(), companion.dispose(), huddles.dispose()]);
  });
  ctx.conversation.registerChatMenu((props) => (
    <SoloHuddleMenu
      {...props}
      relay={ctx.relay}
      huddles={huddles}
      showWindow={companion.open}
    />
  ));
  ctx.panels.register({
    id: "huddles",
    title: "Huddles",
    // A live call: it stays a tab until it survives a dialog closing.
    inline: false,
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
        agents={ctx.agents}
        {...props}
        relay={ctx.relay}
        huddles={huddles}
        showWindow={companion.open}
      />
    ),
    channelPlacement: "side",
    component: (props) => (
      <HuddlePanel
        {...props}
        relay={ctx.relay}
        extensions={ctx.conversation}
        openLink={openLink}
      />
    ),
  });
};
