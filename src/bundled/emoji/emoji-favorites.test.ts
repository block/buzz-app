// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  subscribeFavorites,
  toggleFavoriteEmoji,
  useFavoriteEmoji,
} from "./emoji-favorites";

afterEach(() => {
  localStorage.clear();
});

it("adds, keeps insertion order, and removes favorites per scope", () => {
  toggleFavoriteEmoji("https://a.test", "bufo-pray");
  toggleFavoriteEmoji("https://a.test", "bufo-thumbs-up");
  toggleFavoriteEmoji("https://b.test", "party");
  expect(read("https://a.test")).toEqual(["bufo-pray", "bufo-thumbs-up"]);
  expect(read("https://b.test")).toEqual(["party"]);
  toggleFavoriteEmoji("https://a.test", "bufo-pray");
  expect(read("https://a.test")).toEqual(["bufo-thumbs-up"]);
});

it("persists as one JSON document keyed by scope", () => {
  toggleFavoriteEmoji("https://a.test", "party");
  toggleFavoriteEmoji("https://a.test", "sparkles");
  expect(
    JSON.parse(localStorage.getItem("buzz.emoji.favorites") ?? ""),
  ).toEqual({
    "https://a.test": ["party", "sparkles"],
  });
});

it("normalizes shortcodes and ignores invalid ones", () => {
  toggleFavoriteEmoji("https://a.test", ":PaRtY:");
  toggleFavoriteEmoji("https://a.test", "not a code");
  toggleFavoriteEmoji("", "party");
  toggleFavoriteEmoji("https://a.test", "");
  expect(read("https://a.test")).toEqual(["party"]);
});

it("tolerates corrupted storage and keeps working", () => {
  localStorage.setItem("buzz.emoji.favorites", "{not json");
  expect(read("https://a.test")).toEqual([]);
  toggleFavoriteEmoji("https://a.test", "party");
  expect(read("https://a.test")).toEqual(["party"]);
});

it("rereads storage when the key is removed underneath the cache", () => {
  toggleFavoriteEmoji("https://a.test", "party");
  localStorage.clear();
  expect(read("https://a.test")).toEqual([]);
  toggleFavoriteEmoji("https://a.test", "sparkles");
  expect(read("https://a.test")).toEqual(["sparkles"]);
});

it("notifies subscribers on every change and unsubscribes", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeFavorites(listener);
  toggleFavoriteEmoji("https://a.test", "party");
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  toggleFavoriteEmoji("https://a.test", "party");
  expect(listener).toHaveBeenCalledTimes(1);
});

it("returns a stable snapshot between changes", () => {
  toggleFavoriteEmoji("https://a.test", "party");
  const first = read("https://a.test");
  expect(read("https://a.test")).toBe(first);
  toggleFavoriteEmoji("https://a.test", "sparkles");
  expect(read("https://a.test")).toEqual(["party", "sparkles"]);
});

function read(scope: string): readonly string[] {
  const { result } = renderHook(() => useFavoriteEmoji(scope));
  return result.current;
}
