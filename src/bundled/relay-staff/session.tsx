import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type DependencyList,
} from "react";
import {
  unresolved,
  type ProbeDto,
  type StaffContext,
  type StaffFailure,
  type StaffOutcome,
  type StaffRequest,
  type StaffResults,
} from "../../features/relay-staff/contract";
import type { Staff } from "./staff";

export type Session = {
  staff: Staff;
  context: StaffContext;
  probe: ProbeDto;
  /** False when the relay runs with admin auth disabled: the console is read-only. */
  canMutate: boolean;
  isOperator: boolean;
  /** Frozen writes by key; outlives the views that started them. */
  frozen: Map<string, StaffRequest>;
  request<R extends StaffRequest>(
    request: R,
  ): Promise<StaffOutcome<StaffResults[R["route"]]>>;
};

const SessionContext = createContext<Session | null>(null);
export const SessionProvider = SessionContext.Provider;

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Relay staff session is missing");
  return session;
}

/** Wraps requests so any authorization loss re-checks the role in the background. */
export function createSession(
  staff: Staff,
  context: StaffContext,
  probe: ProbeDto,
  frozen: Map<string, StaffRequest>,
): Session {
  return {
    staff,
    context,
    probe,
    frozen,
    canMutate: probe.authMode === "nip98",
    isOperator: probe.role === "operator",
    async request(request) {
      const outcome = await staff.backend.request(context, request);
      if (
        !outcome.ok &&
        (outcome.failure.category === "unauthorized" ||
          outcome.failure.category === "forbidden")
      )
        void staff.probe(context, true);
      return outcome;
    },
  };
}

export type Read<T> =
  | { state: "loading" }
  | { state: "ok"; value: T }
  | { state: "failed"; failure: StaffFailure };

/**
 * One read, tied to the session and `deps`. A response that arrives after the
 * session, community or query changed (or after unmount) is dropped.
 */
export function useRead<R extends StaffRequest>(
  request: R | null,
  deps: DependencyList,
) {
  const { request: send } = useSession();
  const [read, setRead] = useState<Read<StaffResults[R["route"]]>>({
    state: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` describe `request`
  useEffect(() => {
    if (!request) return;
    let current = true;
    setRead({ state: "loading" });
    void send(request).then((outcome) => {
      if (!current) return;
      setRead(
        outcome.ok
          ? { state: "ok", value: outcome.value }
          : { state: "failed", failure: outcome.failure },
      );
    });
    return () => {
      current = false;
    };
  }, [send, attempt, ...deps]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return [read, reload] as const;
}

/** Plain-language text for a failed request. */
export function describe(failure: StaffFailure) {
  switch (failure.category) {
    case "unauthorized":
      return "The relay did not accept your signature.";
    case "forbidden":
      return failure.message || "You do not have permission to do that.";
    case "intercepted":
      return "A network gateway (such as VPN or SSO) intercepted the request.";
    case "ambiguous":
      return `The relay did not confirm the result. ${failure.message}`.trim();
    default:
      return failure.message;
  }
}

/**
 * A write whose whole request (including `requestId`) is frozen under `key`
 * on the first attempt. An unresolved outcome keeps it, even across unmount,
 * so a retry resends it unchanged; success, `notSent` or a definite
 * rejection releases it.
 */
export function useFrozenWrite<R extends StaffRequest>(key: string) {
  const { request: send, frozen: store } = useSession();
  const [frozen, setFrozen] = useState(
    () => (store.get(key) as R | undefined) ?? null,
  );
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const run = async (
    fresh: R,
  ): Promise<StaffOutcome<StaffResults[R["route"]]> | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    const request = (store.get(key) as R | undefined) ?? fresh;
    store.set(key, request);
    setFrozen(request);
    setBusy(true);
    try {
      const outcome = await send(request);
      if (!unresolved(outcome)) {
        store.delete(key);
        setFrozen(null);
      }
      return outcome;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { frozen, busy, run };
}

type Paged = Extract<
  StaffRequest,
  { route: "listCommunities" } | { route: "listRestrictions" }
>;
type Pages<R extends Paged> = {
  items: StaffResults[R["route"]]["items"];
  next: string | null;
  loading: boolean;
  failure: StaffFailure | null;
};

/**
 * Cursor pages for `page(cursor)`, restarted whenever `deps` change. A page
 * that arrives after a restart (or unmount) is dropped.
 */
export function usePages<R extends Paged>(
  page: ((cursor?: string) => R) | null,
  deps: DependencyList,
) {
  const { request: send } = useSession();
  const empty = { items: [], next: null, failure: null };
  const [pages, setPages] = useState<Pages<R>>({ ...empty, loading: true });
  const generation = useRef(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const load = async (cursor: string | undefined, at: number) => {
    const make = pageRef.current;
    if (!make) return;
    setPages((current) => ({ ...current, loading: true, failure: null }));
    const outcome = await send(make(cursor));
    if (at !== generation.current) return;
    setPages((current) =>
      outcome.ok
        ? {
            items: [
              ...(cursor ? current.items : []),
              ...outcome.value.items,
            ] as Pages<R>["items"],
            next: outcome.value.nextCursor,
            loading: false,
            failure: null,
          }
        : { ...current, loading: false, failure: outcome.failure },
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` describe `page`
  useEffect(() => {
    const at = ++generation.current;
    setPages({ ...empty, loading: !!pageRef.current });
    void load(undefined, at);
    return () => {
      generation.current++;
    };
  }, [send, ...deps]);
  const more = () => {
    if (pages.next && !pages.loading) void load(pages.next, generation.current);
  };
  const restart = () => {
    const at = ++generation.current;
    void load(undefined, at);
  };
  return { ...pages, more, restart };
}
