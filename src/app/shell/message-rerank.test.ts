// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  DecisionResult,
  Decisions,
} from "../../features/decisions/service";
import { rerankOrder, useMessageRerank } from "./message-rerank";
import type { SearchMessage } from "./useSearchMessages";

const message = (id: string) =>
  ({
    id,
    channelId: "c",
    authorId: "a",
    createdAt: 0,
    preview: id,
    text: id,
  }) as SearchMessage;

it("orders by the provider's probability, keeping relay order on ties and gaps", () => {
  const messages = ["a", "b", "c", "d"].map(message);
  expect(
    rerankOrder(messages, {
      m1: { type: "yes_no", probability: 0.2 },
      m2: { type: "yes_no", probability: 0.9 },
      m3: { type: "yes_no", probability: 0.2 },
    }),
  ).toEqual(["b", "a", "c", "d"]);
});

afterEach(() => {
  vi.useRealTimers();
});

it("drops an answer that lands after the person moved, keeping the relay order", async () => {
  vi.useFakeTimers();
  let answer: (result: DecisionResult) => void = () => {};
  const decide = vi.fn(
    () =>
      new Promise<DecisionResult>((resolve) => {
        answer = resolve;
      }),
  );
  const decisions = { decide, status: () => "ready" } as unknown as Decisions;
  const messages = ["a", "b"].map(message);
  const facts = () => ({ where: "#c", author: "A", mine: false });
  const { result, rerender } = renderHook(
    ({ held }) =>
      useMessageRerank(decisions, undefined, "q", messages, true, facts, held),
    { initialProps: { held: false } },
  );
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(decide).toHaveBeenCalledOnce();
  rerender({ held: true });
  await act(async () => {
    answer({
      outcome: "answered",
      backend: "test",
      model: "test",
      answers: {
        m1: { type: "yes_no", probability: 0.1 },
        m2: { type: "yes_no", probability: 0.9 },
      },
    } as DecisionResult);
  });
  expect(result.current.reranked).toBe(false);
  expect(result.current.messages.map(({ id }) => id)).toEqual(["a", "b"]);
});

it("keeps an applied order while a later page extends the hits", async () => {
  vi.useFakeTimers();
  const decide = vi.fn(async () => ({
    outcome: "answered",
    backend: "test",
    model: "test",
    answers: {
      m1: { type: "yes_no", probability: 0.1 },
      m2: { type: "yes_no", probability: 0.9 },
    },
  }));
  const decisions = { decide, status: () => "ready" } as unknown as Decisions;
  const facts = () => ({ where: "#c", author: "A", mine: false });
  const { result, rerender } = renderHook(
    ({ messages, held }) =>
      useMessageRerank(decisions, undefined, "q", messages, true, facts, held),
    { initialProps: { messages: ["a", "b"].map(message), held: false } },
  );
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(result.current.messages.map(({ id }) => id)).toEqual(["b", "a"]);
  // The person moves, then loads the next page.
  rerender({ messages: ["a", "b", "c"].map(message), held: true });
  expect(result.current.reranked).toBe(true);
  expect(result.current.messages.map(({ id }) => id)).toEqual(["b", "a", "c"]);
});
