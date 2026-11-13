import { expect, it } from "vitest";
import { keypair, signed } from "../relay/testing";
import { editedProfileTemplate } from "./profile-publication";

it.each(["null", "[]", '["old"]', '"text"', "42", "true"])(
  "repairs a signed non-object profile head %s through the editor",
  (content) => {
    const head = signed(keypair(), {
      kind: 0,
      tags: [["keep", "tag"]],
      content,
    });
    const template = editedProfileTemplate(
      { name: " Repaired ", picture: "", about: " New bio " },
      head,
    );
    expect(JSON.parse(template.content)).toEqual({
      name: "Repaired",
      display_name: "Repaired",
      picture: "",
      about: "New bio",
    });
    expect(template.tags).toEqual(head.tags);
    expect(template.created_at).toBeGreaterThan(head.created_at);
  },
);
