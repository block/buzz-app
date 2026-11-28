import {
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { writeClipboardText } from "../../shared/clipboard";
import {
  ArrowUpRightIcon,
  BrowserIcon,
  CopyIcon,
} from "../../shared/design-system/icons";
import {
  ContextMenuRoot,
  MenuGroup,
  MenuGroupLabel,
  MenuIcon,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { ContributionBoundary } from "../conversation/ContributionBoundary";
import { isBuzzLink } from "../navigation/buzz-links";
import type { Panels, RegisteredPanel } from "../panels/service";
import { safeLinkUrl } from "../relay/message-content";
import { messageLinkParts } from "./message-link-parts";

const noSubscription = () => () => {};

/** Preview chips store their Markdown source, while formatted link labels are
 * editable marks. Read either destination without using the rendered label. */
function linkDestination(link: Element) {
  const source = link.getAttribute("data-source");
  if (!source) return link.getAttribute("href") ?? undefined;
  let destination: string | undefined;
  messageLinkParts(source, undefined, (start, end, url) => {
    if (start === 0 && end === source.length) destination = url;
  });
  return destination;
}

export function ComposerLinkMenu({
  active,
  editor,
  className,
  panels,
  canOpenLink,
  onOpenLink,
  children,
}: {
  active: boolean;
  editor: RefObject<HTMLElement | null>;
  className?: string | undefined;
  panels?: Pick<Panels, "resolve" | "subscribe"> | undefined;
  canOpenLink?: ((url: string) => boolean) | undefined;
  onOpenLink?: ((url: string) => boolean) | undefined;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<{
    link: Element;
    url: string;
    anchor: { getBoundingClientRect(): DOMRect };
  }>();
  const [open, setOpen] = useState(false);
  const opening = useRef<"link" | RegisteredPanel>(undefined);
  const notify = useToastNotification();
  if (!active && target) {
    setTarget(undefined);
    setOpen(false);
  }
  const web = target && safeLinkUrl(target.url);
  const resolvePanel = () =>
    active && target ? panels?.resolve(target.url) : undefined;
  const panel = useSyncExternalStore(
    (active && target && panels?.subscribe) || noSubscription,
    resolvePanel,
    resolvePanel,
  );
  const action =
    target && web && onOpenLink && canOpenLink?.(target.url)
      ? panel?.composerLinkMenu
      : undefined;
  const PanelIcon = action?.icon;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Delegates events from the editor's link and portal nodes without adding a focus stop.
    <div
      className={className}
      onContextMenu={(event) => {
        // The editor and the React portals that paint its chips meet here.
        if (
          !active ||
          event.defaultPrevented ||
          !(event.target instanceof Element)
        )
          return;
        const link = event.target.closest("a[href], span[data-source]");
        if (!link || !editor.current?.contains(link)) return;
        const url = linkDestination(link);
        if (!url || (!safeLinkUrl(url) && !isBuzzLink(url))) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = new DOMRect(event.clientX, event.clientY, 0, 0);
        opening.current = undefined;
        setTarget({ link, url, anchor: { getBoundingClientRect: () => rect } });
        setOpen(true);
      }}
    >
      {children}
      {active && target && (
        <ContextMenuRoot
          open={open}
          onOpenChange={setOpen}
          onOpenChangeComplete={(next) => {
            if (next) return;
            setTarget(undefined);
            const requested = opening.current;
            opening.current = undefined;
            if (
              !requested ||
              (requested !== "link" &&
                panels?.resolve(target.url) !== requested)
            )
              return;
            const input = editor.current;
            if (!input?.contains(target.link)) return;
            // The destination records the editor as its return-focus target.
            input.focus({ preventScroll: true });
            if (!onOpenLink?.(target.url))
              notify("Couldn’t open the link in Buzz.", "error");
          }}
        >
          <MenuPopup
            size="compact"
            anchor={target.anchor}
            finalFocus={() =>
              opening.current ? false : (editor.current ?? false)
            }
          >
            {!web && onOpenLink && (
              <MenuItem
                onClick={() => {
                  opening.current = "link";
                }}
              >
                <MenuIcon>
                  <ArrowUpRightIcon size={16} />
                </MenuIcon>
                Open link
              </MenuItem>
            )}
            {web && (
              <MenuLinkItem
                href={web}
                target="_blank"
                rel="noopener noreferrer"
                closeOnClick
              >
                <MenuIcon>
                  <BrowserIcon size={16} />
                </MenuIcon>
                Open in browser
              </MenuLinkItem>
            )}
            <MenuItem
              onClick={async () => {
                try {
                  await writeClipboardText(target.url);
                  notify("Link copied", "success");
                } catch {
                  notify("Couldn’t copy the link. Try again.", "error");
                }
              }}
            >
              <MenuIcon>
                <CopyIcon size={16} />
              </MenuIcon>
              Copy link
            </MenuItem>
            {action && panel && (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Plugins</MenuGroupLabel>
                  <MenuItem
                    onClick={() => {
                      opening.current = panel;
                    }}
                  >
                    <MenuIcon>
                      {PanelIcon ? (
                        <ContributionBoundary
                          fallback={<ArrowUpRightIcon size={16} />}
                          resetIdentity={PanelIcon}
                        >
                          <PanelIcon />
                        </ContributionBoundary>
                      ) : (
                        <ArrowUpRightIcon size={16} />
                      )}
                    </MenuIcon>
                    {action.label}
                  </MenuItem>
                </MenuGroup>
              </>
            )}
          </MenuPopup>
        </ContextMenuRoot>
      )}
    </div>
  );
}
