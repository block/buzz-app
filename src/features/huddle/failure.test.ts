import { describe, expect, it } from "vitest";
import { huddleFailure } from "./failure";

describe("huddleFailure", () => {
  it("titles a failure by whether the call had connected", () => {
    expect(huddleFailure("Huddle connection stalled", false)).toEqual({
      title: "Couldn’t join the Huddle",
      description: "The connection dropped.",
      rejoin: true,
    });
    expect(huddleFailure("Huddle connection stalled", true).title).toBe(
      "Huddle disconnected",
    );
  });

  it.each([
    "Huddle disconnected",
    "Huddle disconnected.",
    "Huddle disconnected. You can join again.",
    "Huddle connection timed out. You can join again.",
    "Huddle audio connection closed",
    "Huddle authorization expired. Join again to reconnect.",
    "The connection changed. Join the Huddle again when connected.",
  ])("maps a dropped connection without its own suffix: %s", (error) => {
    expect(huddleFailure(error, true)).toEqual({
      title: "Huddle disconnected",
      description: "The connection dropped.",
      rejoin: true,
    });
  });

  it("maps each known cause to one sentence and offers Join again only where it can work", () => {
    expect(
      huddleFailure("The relay ended this Huddle connection", true),
    ).toEqual({
      title: "Huddle ended",
      description: "The community ended this Huddle.",
      rejoin: false,
    });
    expect(
      huddleFailure(
        "The microphone disconnected. Check your device and join again.",
        true,
      ),
    ).toEqual({
      title: "Huddle disconnected",
      description: "Your microphone disconnected. Check it, then join again.",
      rejoin: true,
    });
    expect(
      huddleFailure("Connect to this channel before starting a Huddle.", false),
    ).toEqual({
      title: "Couldn’t join the Huddle",
      description: "Connect to this channel first, then try again.",
      rejoin: false,
    });
    expect(
      huddleFailure("You no longer have access to this channel.", true),
    ).toEqual({
      title: "Huddle ended",
      description: "You no longer have access to this channel.",
      rejoin: false,
    });
    expect(huddleFailure("not a member", false)).toEqual({
      title: "Couldn’t join the Huddle",
      description: "You no longer have access to this channel.",
      rejoin: false,
    });
    expect(
      huddleFailure("Audio decoder unavailable: invalid codec state", true),
    ).toEqual({
      title: "Couldn’t play Huddle audio",
      description: "Restart Buzz, then join again.",
      rejoin: false,
    });
    expect(huddleFailure("Microphone access denied", false).description).toBe(
      "Buzz couldn’t use your microphone. Check it, then join again.",
    );
    expect(
      huddleFailure("huddle audio unavailable in this deployment", true),
    ).toEqual({
      title: "Huddle audio unavailable",
      description:
        "Huddle audio isn’t available on this server. A relay administrator needs to check its configuration.",
      rejoin: false,
    });
  });

  it("never shows or appends to unmapped native text", () => {
    expect(huddleFailure("Invalid Huddle update", true)).toEqual({
      title: "Huddle disconnected",
      description: "Something went wrong with the Huddle connection.",
      rejoin: true,
    });
    expect(huddleFailure(undefined, false)).toEqual({
      title: "Couldn’t join the Huddle",
      description: "Something went wrong with the Huddle connection.",
      rejoin: true,
    });
  });
});
