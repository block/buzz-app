import { expect, it, vi } from "vitest";
import { lanes } from "./lanes";
import { link } from "./link";

it("carries a link on each lane of one port, apart from the others", async () => {
  const channel = new MessageChannel();
  const close = vi.spyOn(channel.port1, "close");
  const one = lanes(channel.port1, ["agents", "page"]);
  const other = lanes(channel.port2, ["agents", "page"]);
  const agents = link(one.agents, {
    topics: {
      shared: () => ({ get: () => "agents", subscribe: () => () => {} }),
    },
  });
  const page = link(one.page, {
    topics: {
      shared: () => ({ get: () => "page", subscribe: () => () => {} }),
    },
  });
  const agentsPeer = link(other.agents);
  const pagePeer = link(other.page);
  agentsPeer.watch("shared", null, () => {});
  pagePeer.watch("shared", null, () => {});
  await vi.waitFor(() => {
    expect(agentsPeer.read("shared")).toBe("agents");
    expect(pagePeer.read("shared")).toBe("page");
  });
  // The port stays open while a lane is.
  agents.close();
  expect(close).not.toHaveBeenCalled();
  page.close();
  expect(close).toHaveBeenCalledTimes(1);
  agentsPeer.close();
  pagePeer.close();
});

it("holds what reaches a lane before it listens, as a MessagePort does", async () => {
  const channel = new MessageChannel();
  const one = lanes(channel.port1, ["agents"]);
  const other = lanes(channel.port2, ["agents"]);
  one.agents.postMessage("early");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const heard: unknown[] = [];
  other.agents.onmessage = ({ data }) => heard.push(data);
  one.agents.postMessage("later");
  await vi.waitFor(() => expect(heard).toEqual(["early", "later"]));
  one.agents.close();
  other.agents.close();
});
