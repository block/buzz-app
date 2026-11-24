/**
 * The tour's "Tidy it up", performed: the sidebar glides to the card that
 * trims the most, so the change is unmistakable, then every card trims together
 * at a steady pace. A card qualifies while it shows everything only because the tour
 * is unanswered and it holds more than the default.
 */

const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
/** Trim pace: each hidden row adds this much, within the floor and ceiling. */
const PER_ROW = 60;
const FLOOR = 500;
const CEILING = 1500;

type Untidy = { rows: HTMLElement; trims: number };
// Cards that would trim, by key, with their rows and how many rows they hide.
const untidy = new Map<string, Untidy>();
// Cards kept full until the show reaches them, once the tour is answered.
let held: ReadonlySet<string> = new Set();

export const tidyShow = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Whether any card would trim, so the tour asks. */
  pending: () => untidy.size > 0,
  held: (key: string) => held.has(key),
  /** A card that would trim registers its rows, and how many it hides, while it would. */
  register(key: string, rows: HTMLElement, trims: number) {
    const card = { rows, trims };
    untidy.set(key, card);
    emit();
    return () => {
      if (untidy.get(key) !== card) return;
      untidy.delete(key);
      emit();
    };
  },
};

const release = (keys: Iterable<string>) => {
  const next = new Set(held);
  for (const key of keys) next.delete(key);
  held = next;
  emit();
};

/** Wait for the target's own event (not a descendant's), or the fallback. */
const until = (target: EventTarget, event: string, fallback: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener(event, heard);
      resolve();
    };
    const heard = (event: Event) => {
      if (event.target === target || target === window) done();
    };
    const timer = setTimeout(done, fallback);
    target.addEventListener(event, heard);
  });

/**
 * Answer the tour with `answer`, then trim. Cards stay full until the trim,
 * so an answer saved mid-show still trims everything the next time.
 */
export async function runTidyShow(answer: () => void) {
  const cards = [...untidy];
  const keys = cards.map(([key]) => key);
  held = new Set(keys);
  answer();
  emit();
  const still = globalThis.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  if (still || cards.length === 0) return release(keys);
  const star = cards
    .map(([, card]) => card)
    .reduce((most, card) => (card.trims > most.trims ? card : most)).rows;
  const card = star.closest<HTMLElement>("[data-sidebar-section]") ?? star;
  const scroller = scrollParent(card);
  const view = scroller?.getBoundingClientRect();
  const place = card.getBoundingClientRect();
  if (view && (place.top < view.top || place.bottom > view.bottom)) {
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    await until(scroller ?? window, "scrollend", 700);
  }
  // A steady pace, so a long card trims as calmly as a short one.
  for (const [, { rows, trims }] of cards) {
    const pace = Math.min(CEILING, Math.max(FLOOR, trims * PER_ROW));
    rows.style.setProperty("--card-trim-duration", `${pace}ms`);
    rows.setAttribute("data-card-showcase", "");
  }
  release(keys);
  await until(star, "transitionend", CEILING + 200);
  for (const [, { rows }] of cards) {
    rows.removeAttribute("data-card-showcase");
    rows.style.removeProperty("--card-trim-duration");
  }
}

function scrollParent(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      /(auto|scroll)/.test(overflowY) &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return undefined;
}
