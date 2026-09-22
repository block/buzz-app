import { GitHubError } from "./github";
import type { TokenStore } from "./tokenStore";
import type { SearchResult } from "./types";

export type QueueSnapshot<Item> = {
  result: SearchResult<Item> | null;
  isFetching: boolean;
  error: string | null;
  lastFetchedAt: number | null;
};

export function createQueueCache<Item>(
  tokenStore: TokenStore,
  fetcher: (token: string, signal: AbortSignal) => Promise<SearchResult<Item>>,
  fallbackErrorMessage: string,
) {
  const listeners = new Set<() => void>();
  let state: QueueSnapshot<Item> = {
    result: null,
    isFetching: false,
    error: null,
    lastFetchedAt: null,
  };
  let currentToken = tokenStore.getToken();
  let requestGeneration = 0;
  let activeRequest: {
    controller: AbortController;
    promise: Promise<void>;
  } | null = null;
  let disposed = false;

  const publish = (nextState: QueueSnapshot<Item>) => {
    state = nextState;
    for (const listener of listeners) listener();
  };

  const unsubscribeTokenStore = tokenStore.subscribe(() => {
    const nextToken = tokenStore.getToken();
    if (nextToken === currentToken) return;

    currentToken = nextToken;
    requestGeneration += 1;
    activeRequest?.controller.abort();
    activeRequest = null;
    publish({
      result: null,
      isFetching: false,
      error: null,
      lastFetchedAt: null,
    });
  });

  const startRequest = (): Promise<void> => {
    if (disposed || !currentToken) return Promise.resolve();
    if (activeRequest) return activeRequest.promise;

    const controller = new AbortController();
    const generation = requestGeneration;
    publish({ ...state, isFetching: true, error: null });

    const promise = fetcher(currentToken, controller.signal)
      .then((result) => {
        if (disposed || generation !== requestGeneration) return;
        publish({
          result,
          isFetching: false,
          error: null,
          lastFetchedAt: Date.now(),
        });
      })
      .catch((error: unknown) => {
        if (disposed || generation !== requestGeneration) return;
        publish({
          ...state,
          isFetching: false,
          error:
            error instanceof GitHubError ? error.message : fallbackErrorMessage,
        });
      })
      .finally(() => {
        if (
          generation === requestGeneration &&
          activeRequest?.promise === promise
        )
          activeRequest = null;
      });

    activeRequest = { controller, promise };
    return promise;
  };

  const load = (): Promise<void> => {
    if (activeRequest) return activeRequest.promise;
    if (state.result || state.error) return Promise.resolve();
    return startRequest();
  };

  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    refresh: startRequest,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      currentToken = null;
      requestGeneration += 1;
      activeRequest?.controller.abort();
      activeRequest = null;
      unsubscribeTokenStore();
      listeners.clear();
      state = {
        result: null,
        isFetching: false,
        error: null,
        lastFetchedAt: null,
      };
    },
  };
}

export type QueueCache<Item> = ReturnType<typeof createQueueCache<Item>>;
