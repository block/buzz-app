// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it } from "vitest";
import { backgroundBudgetMs, useBackgroundStore } from "./scheduler";

function store(initial: number) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: number) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function Value({ source }: { source: ReturnType<typeof store> }) {
  const value = useBackgroundStore(source.subscribe, source.get);
  return <output>{value}</output>;
}

afterEach(cleanup);

it("renders a background publish and settles on the latest snapshot", async () => {
  const source = store(1);
  render(<Value source={source} />);
  expect(screen.getByRole("status").textContent).toBe("1");
  await act(async () => {
    source.set(2);
    source.set(3);
  });
  expect(screen.getByRole("status").textContent).toBe("3");
});

it("renders a publish caused by input urgently", () => {
  const source = store(1);
  render(
    <>
      <button type="button" onClick={() => source.set(5)}>
        set
      </button>
      <Value source={source} />
    </>,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("status").textContent).toBe("5");
});

it("reads a new source synchronously instead of the previous snapshot", () => {
  const first = store(1);
  const second = store(2);
  const { rerender } = render(<Value source={first} />);
  rerender(<Value source={second} />);
  expect(screen.getByRole("status").textContent).toBe("2");
});

it("catches a publish between render and subscription", async () => {
  const source = store(1);
  function Publishing() {
    const value = useBackgroundStore(source.subscribe, source.get);
    if (value === 1) queueMicrotask(() => source.set(7));
    return <output>{value}</output>;
  }
  render(<Publishing />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("7");
});

it("renders an overdue background update within the budget", async () => {
  const source = store(1);
  render(<Value source={source} />);
  await act(async () => {
    source.set(2);
    await new Promise((resolve) => setTimeout(resolve, backgroundBudgetMs * 2));
  });
  expect(screen.getByRole("status").textContent).toBe("2");
});

it("commits an urgent change that an awaited effect depends on", async () => {
  const source = store(1);
  let seen: (value: number) => void = () => {};
  function Watching() {
    const value = useBackgroundStore(source.subscribe, source.get, () => false);
    useEffect(() => seen(value), [value]);
    return <output>{value}</output>;
  }
  render(<Watching />);
  await act(async () => {
    const reached = new Promise<void>((resolve) => {
      seen = (value) => value === 2 && resolve();
    });
    source.set(2);
    await reached;
  });
  expect(screen.getByRole("status").textContent).toBe("2");
});

it("renders a return to an earlier snapshot", async () => {
  const source = store(1);
  const { rerender } = render(<Value source={source} />);
  await act(async () => source.set(2));
  rerender(<></>);
  source.set(1);
  rerender(<Value source={source} />);
  await act(async () => source.set(2));
  expect(screen.getByRole("status").textContent).toBe("2");
});
