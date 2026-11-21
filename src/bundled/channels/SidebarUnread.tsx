import { Avatar } from "../../shared/design-system/ui/Avatar";
import { SidebarList } from "../../features/channel-navigation/SidebarList";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ArrowDownIcon,
  ArrowUpIcon,
} from "../../shared/design-system/icons/index";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { CONVERSATION_LIST_LABEL, NEEDS_YOU } from "./conversation-rows";
import { sidebarScrollAnchor } from "./sidebar-scroll-anchor";
import styles from "./Channels.module.css";
import { avatarMedia } from "../../shared/avatar-source";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";

export type UnreadDmPreview = {
  name: string;
  src?: string | undefined;
  isAgent?: boolean | undefined;
};

type PreviewProfile = Pick<Profile, "name" | "picture" | "isAgent">;

/** The face unread cues show for each 1:1 DM: its person, matching the row
 * you're looking for. Other conversations still count, without a face. */
export function unreadPreviews(
  channels: readonly ChannelSummary[],
  dmProfiles: ReadonlyMap<string, PreviewProfile>,
  media: Parameters<typeof avatarMedia>[1],
) {
  const previews = new Map<string, UnreadDmPreview>();
  for (const channel of channels) {
    if (channel.channelType !== "dm" || channel.participants?.length !== 1)
      continue;
    const profile = dmProfiles.get(channel.participants[0] ?? "");
    previews.set(channel.id, {
      name: channel.name,
      src: avatarMedia(profile?.picture, media),
      isAgent: profile?.isAgent,
    });
  }
  return previews;
}

type EdgeTarget = {
  /** The row to reveal, or the card's badge when the row is past its edge. */
  row: HTMLButtonElement;
  channelId: string;
};
type Edges = { above: EdgeTarget[]; below: EdgeTarget[] };

/** Geometry over rendered unread destinations, not another unread store. */
function unreadEdges(list: HTMLElement): Edges {
  const edges: Edges = { above: [], below: [] };
  const visible = new Set<string>();
  const viewport = list.getBoundingClientRect();
  if (!list.clientHeight || !viewport.width) return edges;
  const rows = new Set<HTMLButtonElement>();
  // Only conversations that need you earn a cue; ordinary backlog stays bold.
  for (const marker of list.querySelectorAll(NEEDS_YOU)) {
    const row = marker.closest("button");
    if (row) rows.add(row);
  }
  for (const row of rows) {
    const channelId = row.getAttribute("data-channel-id");
    if (!channelId) continue;
    // A collapsed section represents its hidden rows at the summary.
    const closed = row
      .closest("[data-sidebar-section]")
      ?.querySelector("details:not([open])");
    // A row past a resized card's edge can't be scrolled to; the card's badge
    // stands in for it, so the cue leads there.
    const clipped = !closed && row.closest("[data-card-clipped]") !== null;
    const badge = clipped
      ? row
          .closest("[data-card-body]")
          ?.querySelector<HTMLButtonElement>("[data-card-waiting] button")
      : undefined;
    if (clipped && !badge) continue;
    const anchor = closed?.querySelector("summary") ?? badge ?? row;
    const rect = anchor.getBoundingClientRect();
    if (!rect.height || !rect.width) continue;
    const target = { row: badge ?? row, channelId };
    if (rect.bottom <= viewport.top) edges.above.push(target);
    else if (rect.top >= viewport.top + list.clientHeight)
      edges.below.push(target);
    else visible.add(channelId);
  }
  // Count destinations, not repeated rows. Any visible copy wins; otherwise
  // keep the nearest copy for reveal and for the avatar ordering.
  for (const edge of ["above", "below"] as const) {
    const seen = new Set(visible);
    const targets = edge === "above" ? edges[edge].reverse() : edges[edge];
    edges[edge] = targets.filter(({ channelId }) => {
      if (seen.has(channelId)) return false;
      seen.add(channelId);
      return true;
    });
    if (edge === "above") edges[edge].reverse();
  }
  return edges;
}

export function SidebarUnread({
  children,
  listRef,
  adjustScrollAnchor,
  captureScrollAnchor,
  dmPreviews,
  floatingAction,
}: {
  children: ReactNode;
  listRef?: RefObject<HTMLElement | null>;
  adjustScrollAnchor?: (top: number) => void;
  captureScrollAnchor?: RefObject<(() => void) | undefined>;
  dmPreviews?: ReadonlyMap<string, UnreadDmPreview>;
  floatingAction?: RefObject<HTMLDivElement | null> | undefined;
}) {
  const ownList = useRef<HTMLElement>(null);
  const list = listRef ?? ownList;
  const content = useRef<HTMLDivElement>(null);
  const upperCue = useRef<HTMLDivElement>(null);
  const lowerCue = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ above: [], below: [] });
  useEffect(() => {
    const viewport = list.current;
    const rows = content.current;
    if (!viewport || !rows) return;
    const anchor = adjustScrollAnchor
      ? sidebarScrollAnchor(viewport, adjustScrollAnchor)
      : undefined;
    if (anchor) {
      viewport.style.overflowAnchor = "none";
      anchor.capture();
      if (captureScrollAnchor) captureScrollAnchor.current = anchor.capture;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = unreadEdges(viewport);
      setEdges((previous) =>
        (["above", "below"] as const).every(
          (edge) =>
            previous[edge].length === next[edge].length &&
            previous[edge].every(
              (target, i) =>
                target.row === next[edge][i]?.row &&
                target.channelId === next[edge][i]?.channelId,
            ),
        )
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const cue = lowerCue.current;
    const upper = upperCue.current;
    const action = floatingAction?.current;
    let positionFrame = 0;
    const schedulePosition = () => {
      if (!cue || !upper || !action || positionFrame) return;
      // The adjustments below change an observed width. Do them outside the
      // ResizeObserver delivery so each pass settles before another runs.
      positionFrame = requestAnimationFrame(() => {
        positionFrame = 0;
        upper.removeAttribute("data-beside-action");
        upper.removeAttribute("data-share-action-row");
        cue.removeAttribute("data-beside-action");
        cue.removeAttribute("data-share-action-row");
        const cueRect = cue.getBoundingClientRect();
        const actionRect = action.getBoundingClientRect();
        const center = cueRect.left + cueRect.width / 2;
        // The floating row uses the same gap around New as below it.
        const gap =
          Number.parseFloat(getComputedStyle(action).insetBlockEnd) || 0;
        const available =
          2 * Math.max(center - actionRect.right, actionRect.left - center) -
          2 * gap;
        cue.removeAttribute("data-preview-limit");
        upper.removeAttribute("data-preview-limit");
        if (actionRect.width > 0 && cue.offsetWidth > available) {
          // Try the widest option first and drop the farthest avatars first.
          const previews = cue.querySelectorAll("[data-unread-dm]").length;
          for (
            let limit = previews - 1;
            limit >= 0 && cue.offsetWidth > available;
            limit--
          ) {
            cue.dataset.previewLimit = String(limit);
          }
        }
        const lifted = actionRect.width > 0 && cue.offsetWidth > available;
        cue.toggleAttribute("data-lifted", lifted);

        // Measure in the list frame so the entrance animation cannot change fit.
        const upperVisible = upper.dataset.visible === "true";
        const lowerVisible = cue.dataset.visible === "true";
        const upperEnd = upperVisible
          ? upper.offsetTop + upper.offsetHeight + gap
          : 0;
        if (lifted && cue.offsetTop < upperEnd) {
          cue.dataset.besideAction = "";
        }
        const actionTop = actionRect.top - viewport.getBoundingClientRect().top;
        if (
          upperVisible &&
          actionRect.width > 0 &&
          (upperEnd > actionTop || (lowerVisible && upperEnd > cue.offsetTop))
        ) {
          upper.dataset.besideAction = "";
          if (lowerVisible) {
            cue.dataset.besideAction = "";
            cue.dataset.shareActionRow = "split";
            upper.dataset.shareActionRow = "split";
            const clippedCount = [cue, upper].some((edge) => {
              const label = edge.querySelector(`.${styles.unreadEdgeLabel}`);
              return label && label.scrollWidth > label.clientWidth;
            });
            if (clippedCount) {
              cue.dataset.shareActionRow = "stacked";
              upper.dataset.shareActionRow = "stacked";
            }
          }
        }
        // The count outranks faces: drop the farthest faces before it clips.
        for (const edge of [upper, cue]) {
          const label = edge.querySelector(`.${styles.unreadEdgeLabel}`);
          if (!label) continue;
          const shown =
            Number(edge.dataset.previewLimit) ||
            edge.querySelectorAll("[data-unread-dm]").length;
          for (
            let limit = shown - 1;
            limit >= 0 && label.scrollWidth > label.clientWidth;
            limit--
          ) {
            edge.dataset.previewLimit = String(limit);
          }
        }
      });
    };
    const resize = new ResizeObserver(() => {
      anchor?.refresh();
      schedulePosition();
      schedule();
    });
    resize.observe(viewport);
    resize.observe(rows);
    if (cue && upper && action) {
      resize.observe(cue);
      resize.observe(upper);
      resize.observe(action);
      schedulePosition();
    }
    const mutations = new MutationObserver((records) => {
      if (
        records.some(
          ({ target }) => cue?.contains(target) || upper?.contains(target),
        )
      )
        schedulePosition();
      if (records.some(({ target }) => rows.contains(target))) {
        anchor?.refresh(
          records.some(
            ({ attributeName, target }) =>
              attributeName === "data-moving" &&
              target instanceof Element &&
              !target.hasAttribute("data-moving"),
          ),
        );
        schedule();
      }
    });
    mutations.observe(rows, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "open",
        "hidden",
        "inert",
        "style",
        "class",
        "data-channel-needs-you",
        "data-channel-type",
        "data-channel-id",
        "data-moving",
        "data-card-clipped",
      ],
    });
    if (cue && upper && action) {
      for (const edge of [cue, upper]) {
        mutations.observe(edge, {
          subtree: true,
          childList: true,
          characterData: true,
          attributeFilter: ["data-visible"],
        });
      }
    }
    const scrolled = () => {
      anchor?.scrolled();
      schedule();
    };
    viewport.addEventListener("scroll", scrolled, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(positionFrame);
      resize.disconnect();
      mutations.disconnect();
      viewport.removeEventListener("scroll", scrolled);
      if (anchor) {
        anchor.dispose();
        if (captureScrollAnchor) captureScrollAnchor.current = undefined;
        viewport.style.removeProperty("overflow-anchor");
      }
      for (const edge of [cue, upper]) {
        edge?.removeAttribute("data-beside-action");
        edge?.removeAttribute("data-share-action-row");
      }
      cue?.removeAttribute("data-lifted");
      cue?.removeAttribute("data-preview-limit");
      upper?.removeAttribute("data-preview-limit");
    };
  }, [list, floatingAction, adjustScrollAnchor, captureScrollAnchor]);
  const reveal = (edge: keyof Edges) => {
    const viewport = list.current;
    if (!viewport) return;
    // Recheck at activation: unread/roster changes may precede the queued frame.
    const targets = unreadEdges(viewport)[edge];
    const target = edge === "above" ? targets.at(-1) : targets[0];
    if (!target) return;
    let row: HTMLElement = target.row;
    const section = row.closest("[data-sidebar-section]");
    const disclosure = section?.querySelector("details");
    if (disclosure && !disclosure.open) {
      const heading = disclosure.querySelector<HTMLElement>("summary");
      if (heading && row.hasAttribute("data-solo-destination-id"))
        row = heading;
      else heading?.click();
    }
    requestAnimationFrame(() => {
      const rect = row.getBoundingClientRect();
      viewport.scrollTop +=
        rect.top -
        viewport.getBoundingClientRect().top -
        (viewport.clientHeight - rect.height) / 2;
      captureScrollAnchor?.current?.();
      // Continue keyboard navigation at the revealed row, not the start of the
      // roster. Its existing focus preparation still applies; focus is not selection.
      row.focus({ preventScroll: true });
    });
  };
  const edgeCues = (["above", "below"] as const).map((edge) => {
    const count = edges[edge].length;
    const nearestFirst =
      edge === "above" ? [...edges[edge]].reverse() : edges[edge];
    const previews = nearestFirst
      .flatMap(({ channelId }) => {
        const preview = dmPreviews?.get(channelId);
        return preview ? [{ channelId, ...preview }] : [];
      })
      .slice(0, 3);
    const Icon = edge === "above" ? ArrowUpIcon : ArrowDownIcon;
    return (
      <div
        ref={edge === "below" ? lowerCue : upperCue}
        className={styles.unreadEdge}
        data-edge={edge}
        key={edge}
        data-visible={count > 0}
        inert={count === 0}
        aria-hidden={count === 0}
      >
        <Button
          variant="prominent"
          aria-label={`${count} unread ${count === 1 ? "conversation" : "conversations"} ${edge}`}
          data-edge={edge}
          size="xs"
          shape="capsule"
          type="button"
          onClick={() => reveal(edge)}
        >
          <Icon size={15} aria-hidden="true" />
          {previews.length > 0 && (
            <span className={styles.unreadDmPreviews} aria-hidden="true">
              <span className={styles.unreadDmStack}>
                {previews.map((preview, index) => (
                  <span
                    key={preview.channelId}
                    className={styles.unreadDmAvatar}
                    data-unread-dm={preview.channelId}
                    style={{ zIndex: previews.length - index }}
                  >
                    <Avatar
                      src={preview.src}
                      alt=""
                      fallback={preview.name}
                      size="fill"
                      shape={preview.isAgent ? "squircle" : "circle"}
                    />
                  </span>
                ))}
              </span>
              <span>·</span>
            </span>
          )}
          <span className={styles.unreadEdgeLabel}>
            {count}
            <span className={styles.unreadEdgeSuffix}> unread</span>
          </span>
        </Button>
      </div>
    );
  });
  return (
    <SidebarList
      navigation={{ label: CONVERSATION_LIST_LABEL, ref: list }}
      contentRef={content}
      overlay={edgeCues}
    >
      {children}
    </SidebarList>
  );
}
