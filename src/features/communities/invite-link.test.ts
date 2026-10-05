import { expect, it } from "vitest";
import { parseInviteLink } from "./invite-link";

it("parses the reference join form and canonicalizes the relay", () => {
  expect(
    parseInviteLink(
      "buzz://join?relay=wss%3A%2F%2Frelay.example%2F&code=v2.invite&policy_receipt=receipt",
    ),
  ).toEqual({
    community: "https://relay.example",
    code: "v2.invite",
    policyReceipt: "receipt",
  });
});
it("parses the relay-hosted share URL", () => {
  expect(parseInviteLink("https://relay.example/invite/v2.invite")).toEqual({
    community: "https://relay.example",
    code: "v2.invite",
  });
});
it.each([
  "buzz://join?relay=example&code=x",
  "buzz://join?relay=ws%3A%2F%2Frelay.example&code=x",
  "buzz://join?relay=wss%3A%2F%2Fuser%40relay.example&code=x",
  "buzz://join?relay=wss%3A%2F%2Frelay.example%2Fother&code=x",
  "buzz://join?relay=wss%3A%2F%2Frelay.example&code=",
  "buzz://join?relay=wss%3A%2F%2Frelay.example&code=x&code=y",
  "buzz://join?relay=wss%3A%2F%2Frelay.example&code=x#fragment",
  "https://relay.example/invite/x?redirect=evil",
])("rejects an unsafe or ambiguous invite: %s", (url) => {
  expect(parseInviteLink(url)).toBeNull();
});
