// An installed plugin cannot import React: the host hands it over in `apply`.
// The build points every `react` import here, so the rest of the source reads
// like ordinary React code. `useHost` must run before anything renders.
// biome-ignore-all lint/suspicious/noExplicitAny: forwards to the host's React.
let host: any;
export let Fragment: any;
export const useHost = (react: unknown) => {
  host = react;
  Fragment = host.Fragment;
};
export const createElement = (...args: any[]) => host.createElement(...args);
export const useState = (...args: any[]) => host.useState(...args);
export const useEffect = (...args: any[]) => host.useEffect(...args);
export const useMemo = (...args: any[]) => host.useMemo(...args);
export const useRef = (...args: any[]) => host.useRef(...args);
export const useSyncExternalStore = (...args: any[]) =>
  host.useSyncExternalStore(...args);
