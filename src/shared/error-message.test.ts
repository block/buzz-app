import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-message";

describe("errorMessage", () => {
  it("reads an Error's message without its name", () => {
    expect(errorMessage(new Error("Couldn’t save."))).toBe("Couldn’t save.");
    expect(errorMessage(new TypeError("Bad value"))).toBe("Bad value");
  });

  it("strips error names an earlier caller stringified into the text", () => {
    expect(errorMessage("Error: Couldn’t save.")).toBe("Couldn’t save.");
    expect(errorMessage("TypeError: Error: nested")).toBe("nested");
    expect(errorMessage(new Error(String(new Error("inner"))))).toBe("inner");
  });

  it("keeps text that only mentions an error later on", () => {
    expect(errorMessage("Buzz hit an Error: retry")).toBe(
      "Buzz hit an Error: retry",
    );
  });

  it("reads a message from an error-like object", () => {
    expect(errorMessage({ message: "From a worker" })).toBe("From a worker");
  });

  it("falls back when there is nothing readable", () => {
    expect(errorMessage(undefined)).toBe("Something went wrong. Try again.");
    expect(errorMessage(new Error(""))).toBe(
      "Something went wrong. Try again.",
    );
    expect(errorMessage("Error:")).toBe("Something went wrong. Try again.");
    expect(errorMessage(42, "Couldn’t send.")).toBe("Couldn’t send.");
  });
});
