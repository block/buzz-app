import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type { ContributionReader, TargetOpener } from "./contracts";

const closed: TargetOpener = Object.freeze({
  canOpen: () => false,
  open: () => false,
});
const OpenerContext = createContext<TargetOpener>(closed);

/**
 * The conversation host that decides where a plugin target opens, such as a
 * channel's side-pane tabs. Outside a provider, nothing opens.
 */
export function TargetOpenerProvider({
  canOpen,
  open,
  children,
}: {
  canOpen?: ((target: string) => boolean) | undefined;
  open?: ((target: string) => boolean) | undefined;
  children: ReactNode;
}) {
  const latest = useRef({ canOpen, open });
  useLayoutEffect(() => {
    latest.current = { canOpen, open };
  });
  const value = useMemo<TargetOpener>(
    () => ({
      canOpen: (target) => latest.current.canOpen?.(target) ?? false,
      open: (target) => latest.current.open?.(target) ?? false,
    }),
    [],
  );
  return (
    <OpenerContext.Provider value={value}>{children}</OpenerContext.Provider>
  );
}

/** Revoked when this mount retires or its exact contribution is removed. */
export function useTargetOpener<T>(
  registry: ContributionReader<T>,
  entry: Contribution<T>,
): TargetOpener {
  const host = useContext(OpenerContext);
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return useMemo(() => {
    const installed = () => registry.snapshot().includes(entry);
    return {
      // Presentation can ask during render, before the mount is live.
      canOpen: (target) => installed() && host.canOpen(target),
      open: (target) => live.current && installed() && host.open(target),
    };
  }, [host, registry, entry]);
}

/** Renders a contribution with the host's opener added to its props. */
export function WithTargetOpener<P extends object, T>({
  component: Component,
  props,
  registry,
  entry,
}: {
  component: ComponentType<P & TargetOpener>;
  props: P;
  registry: ContributionReader<T>;
  entry: Contribution<T>;
}) {
  const opener = useTargetOpener(registry, entry);
  return <Component {...props} {...opener} />;
}
