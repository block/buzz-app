import { expect, it } from "vitest";
import { shownChatTitle } from "./shown-title";

const media = `https://relay.example/media/${"a".repeat(64)}`;
// A name is its message's source, cut at 80 characters.
const stored = (source: string) => [...source].slice(0, 80).join("");

it("shows a name stored as a first message's media or link as its title", () => {
  expect(shownChatTitle(stored(`![video](${media}.mp4)`))).toBe("Video");
  expect(shownChatTitle(stored(`![image](${media}.png)`))).toBe("Image");
  expect(
    shownChatTitle("![a](https://x.example/1) ![b](https://x.example/2)"),
  ).toBe("2 images");
  expect(shownChatTitle(stored(`What is this? ![image](${media}.png)`))).toBe(
    "What is this?",
  );
  expect(shownChatTitle(stored(`[notes.txt](${media}.txt)`))).toBe("notes.txt");
  expect(shownChatTitle("https://www.example.com/a/b?c=d")).toBe(
    "Link to example.com",
  );
});

it("shows every other name as it is", () => {
  for (const name of [
    "Fix the build",
    "Summarize https://example.com/a",
    "Why [brackets] (and parentheses)?",
  ])
    expect(shownChatTitle(name)).toBe(name);
});
