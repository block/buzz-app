import { useContext, useLayoutEffect, useMemo, useState } from "react";
import { BestieNavigationContext } from "../bestie-context";
import {
  Bell,
  Faces,
  Hash,
  Lock,
  Message,
  Plug,
  Row,
  Scene,
  Search,
  Sketch,
  Switch,
} from "./Drawing";
import { TourCard, type TourPage } from "./TourCard";
import styles from "./WelcomeTour.module.css";

type Placement = {
  /** The part of Buzz the card moves beside; without one it rests by the sidebar. */
  target?: () => Element | null | undefined;
  side?: "right" | "bottom";
  align?: "start" | "center";
};

const navigation = () => document.getElementById("shell-navigation");
/** A sidebar section by its key: solo, channels, dms. */
const section = (key: string) => () =>
  navigation()?.querySelector(`[data-sidebar-section="${key}"]`);
/** A row in the sidebar by its name, such as Activity, which may trail a count. */
const row = (name: string) => () =>
  Array.from(navigation()?.querySelectorAll("button, a") ?? []).find(
    (element) => element.textContent?.trim().replace(/\s*\d+.*$/, "") === name,
  );
const shown = (element: Element | null | undefined) => {
  if (!element) return undefined;
  const box = element.getBoundingClientRect();
  return box.width && box.height ? element : undefined;
};

function pages(bestie: string | undefined): (TourPage & Placement)[] {
  return [
    {
      id: "welcome",
      title: "Welcome to Buzz",
      description:
        "Buzz is where people and AI agents work together. Here’s a quick look around.",
      visual: (
        <Scene still>
          {/* People and agents, together. */}
          <Faces of={["person", "agent", "person", "agent", "person"]} />
        </Scene>
      ),
    },
    {
      id: "solo",
      title: "Solo chats",
      description:
        "Your private space to work with your agents. Only you can see them, unless you invite someone.",
      target: section("solo"),
      visual: (
        <Scene wide>
          <Sketch
            header={
              <>
                <Faces of={["agent"]} />
                <Lock />
              </>
            }
          >
            <Message own enter={1} />
            <Message from="agent" enter={2} reply={3} />
          </Sketch>
        </Scene>
      ),
    },
    {
      id: "channels",
      title: "Channels",
      description:
        "Shared rooms where your community talks and works together. Everyone in a channel sees what’s said there.",
      target: section("channels"),
      visual: (
        <Scene wide>
          <Sketch
            header={
              <>
                <Hash />
                <Faces of={["person", "person", "agent"]} at="end" />
              </>
            }
          >
            <Message enter={1} />
            <Message length="short" enter={2} />
            <Message from="agent" enter={3} />
            <Message own length="short" enter={4} />
          </Sketch>
        </Scene>
      ),
    },
    {
      id: "dms",
      title: "Direct messages",
      description: "Private conversations with one person or a small group.",
      target: section("dms"),
      visual: (
        <Scene wide>
          <Sketch header={<Faces of={["person"]} />}>
            <Message enter={1} />
            <Message own length="short" enter={2} />
            <Message length="short" enter={3} />
          </Sketch>
        </Scene>
      ),
    },
    {
      id: "activity",
      title: "Activity",
      description:
        "Mentions, replies and anything else that needs you shows up here.",
      target: row("Activity"),
      visual: (
        <Scene>
          {/* An agent mentions you, then someone replies in your thread;
              the bell rings for each. Newest on top. */}
          <Sketch header={<Bell />}>
            <Row lead="person" kind="reply" enter={2} />
            <Row lead="agent" kind="mention" enter={1} />
            <Row lead="person" />
          </Sketch>
        </Scene>
      ),
    },
    {
      id: "plugins",
      title: "Plugins",
      description:
        "Plugins add features to Buzz, and the ones you turn on show up here. To add more, open your profile menu, then Settings → Plugins.",
      // Where a plugin's page shows up once it's on: the sidebar's Plugins
      // section when the sidebar has one, otherwise the apps dock.
      target: () =>
        document.querySelector('[data-sidebar-section="pages"]') ??
        document.querySelector('[role="tablist"][aria-label="Apps"]'),
      side: "right",
      align: "start",
      visual: (
        <Scene>
          <Sketch header={<Plug />}>
            <Row trail={<Switch state="on" />} />
            <Row trail={<Switch state="flip" />} />
            <Row trail={<Switch />} />
          </Sketch>
        </Scene>
      ),
    },
    {
      id: "search",
      title: "Questions? Ask here anytime",
      description: bestie
        ? `Search finds people, channels and messages. You can also ask ${bestie} anything about Buzz, right here.`
        : "Search finds people, channels and messages. Once you set up your agent, you can ask it anything about Buzz here too.",
      target: () => document.querySelector('[aria-label="Search Buzz"]'),
      side: "bottom",
      align: "center",
      visual: (
        <Scene>
          <Search agent={!!bestie} />
          <Row lead={bestie ? "agent" : "person"} enter={3} />
        </Scene>
      ),
    },
  ];
}

/**
 * The first-run welcome: a few cards, each with a small drawing, ending at
 * search. After the first, each card moves beside the part of Buzz it is
 * about and outlines it; when that part isn't there, the card rests by the
 * sidebar. It explains only; nothing needs to be clicked. Close or Escape ends
 * it early, and it never takes focus on its own.
 */
export function WelcomeTour({
  open,
  onDone,
  onSetUpAgent,
}: {
  open: boolean;
  onDone: () => void;
  /** Offered on the last card when there is no Bestie yet. */
  onSetUpAgent?: (() => void) | undefined;
}) {
  const mark = useContext(BestieNavigationContext);
  // The last card names the Bestie, once there is one.
  const bestie = mark && !mark.placeholder ? mark.label : undefined;
  const steps = useMemo(() => pages(bestie), [bestie]);
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const [rest, setRest] = useState<Element>();
  const [target, setTarget] = useState<Element>();
  const [box, setBox] = useState<{ rect: DOMRect; radius: string }>();
  // Each time it opens, it starts from the first card beside the sidebar.
  useLayoutEffect(() => {
    if (!open) return;
    setIndex(0);
    setRest(navigation() ?? undefined);
  }, [open]);
  // A moved card follows its part of the app as the window resizes or scrolls.
  useLayoutEffect(() => {
    const element = open ? shown(step?.target?.()) : undefined;
    setTarget(element);
    if (!element) {
      setBox(undefined);
      return;
    }
    // A section below the fold scrolls into the sidebar's view first.
    element.scrollIntoView?.({ block: "nearest" });
    // The ring follows the target's own corners, a pill or a card.
    const measure = () =>
      setBox({
        rect: element.getBoundingClientRect(),
        radius: getComputedStyle(element).borderRadius,
      });
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [open, step]);
  const anchor = target ?? rest;
  if (!open || !step || !anchor) return null;
  const offerSetup = !bestie && !!mark?.placeholder && !!onSetUpAgent;
  return (
    <>
      {box && (
        <div
          className={styles.spotlight}
          data-testid="welcome-tour-spotlight"
          aria-hidden="true"
          style={{
            top: box.rect.top - 4,
            left: box.rect.left - 4,
            width: box.rect.width + 8,
            height: box.rect.height + 8,
            borderRadius: `calc(${box.radius} + 4px)`,
          }}
        />
      )}
      <TourCard
        label="Welcome to Buzz"
        pages={steps}
        index={index}
        onIndexChange={setIndex}
        anchor={anchor}
        side={target ? (step.side ?? "right") : "right"}
        align={target ? (step.align ?? "start") : "center"}
        {...(offerSetup && {
          finishLabel: "Set up your agent",
          declineLabel: "Maybe later",
        })}
        onDismiss={(reason) => {
          onDone();
          if (reason === "finished" && offerSetup) onSetUpAgent?.();
        }}
      />
    </>
  );
}
