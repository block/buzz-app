// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { copyEmoji } from "./copy-emoji";

beforeEach(() => document.addEventListener("copy", copyEmoji));
afterEach(() => {
  document.removeEventListener("copy", copyEmoji);
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

const emoji = (code: string) =>
  `<img data-copy-emoji=":${code}:" alt=":${code}:">`;

// jsdom has no ClipboardEvent; a cancelable copy event with stubbed
// clipboardData reaches the same document listener.
function copy(start: [Node, number], end: [Node, number]) {
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const written: string[] = [];
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { setData: (_type: string, value: string) => written.push(value) },
  });
  document.body.dispatchEvent(event);
  return { prevented: event.defaultPrevented, written };
}

const node = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

it("omits user-select: none chrome from a cross-row copy", () => {
  document.body.innerHTML = [
    "<section>",
    `<div><div>Matt <time>10:30<span style="user-select: none">Monday, 6 October</span></time></div><p>Shipping ${emoji("party")} today</p><div style="user-select: none"><button>${emoji("wave")}</button></div></div>`,
    `<div><span style="user-select: none">Matt</span><span style="user-select: none">10:31</span><p>Second message</p></div>`,
    "</section>",
  ].join("");
  const section = node("section");
  expect(copy([section, 0], [section, section.childNodes.length])).toEqual({
    prevented: true,
    written: ["Matt 10:30\nShipping :party: today\nSecond message"],
  });
});

it("leaves the engine's copy alone when every emoji is excluded chrome", () => {
  document.body.innerHTML = `<section><p>First</p><div style="user-select: none">${emoji("wave")}</div><p>Second</p></section>`;
  const section = node("section");
  expect(copy([section, 0], [section, section.childNodes.length])).toEqual({
    prevented: false,
    written: [],
  });
});

it("slices boundary text nodes", () => {
  document.body.innerHTML = `<p>Shipping ${emoji("party")} today</p><p>Second message</p>`;
  const [first, second] = document.querySelectorAll("p");
  expect(
    copy([first?.firstChild as Node, 4], [second?.firstChild as Node, 6]),
  ).toEqual({ prevented: true, written: ["ping :party: today\n\nSecond"] });
});

it("keeps break, block and table separators", () => {
  document.body.innerHTML = `<section><p>One<br>${emoji("party")}</p><table><tbody><tr><td>${emoji("party")}</td><td></td><td>12</td></tr><tr><td></td><td>lead</td><td></td></tr></tbody></table></section>`;
  const section = node("section");
  expect(copy([section, 0], [section, section.childNodes.length])).toEqual({
    prevented: true,
    written: ["One\n:party:\n\n:party:\t\t12\n\tlead\t"],
  });
});
