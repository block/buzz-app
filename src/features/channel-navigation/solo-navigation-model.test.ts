import { expect, it } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import { REGION_PREFIX } from "../solo/region-labels";
import { projectSoloRegions } from "./solo-navigation-model";

const label = `${REGION_PREFIX}acme:prs`;
const chat = (
  id: string,
  viewerRole: ChannelSummary["viewerRole"],
): ChannelSummary => ({
  id,
  name: id,
  channelType: "solo",
  viewerRole,
  labels: [label],
});

it("files only the viewer's own chats by region; a joined chat lists normally", () => {
  const placement = projectSoloRegions(
    [chat("own", "owner"), chat("joined", "guest")],
    [],
    (value) => value,
  );
  expect([...placement.excluded]).toEqual(["own"]);
  expect(
    placement.regions.map((region) => region.channels.map((c) => c.id)),
  ).toEqual([["own"]]);
});
