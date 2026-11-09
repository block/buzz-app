// Match the app entry: establish reset and layer order before component CSS.
import "../../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import {
  StrictMode,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { ConversationRow } from "../../../src/features/messages/ConversationRow";
import { Avatar } from "../../../src/shared/design-system/ui/Avatar";
import { ShimmerText } from "../../../src/shared/design-system/ui/ShimmerText";
import { SidebarNavigation } from "../../../src/shared/design-system/ui/SidebarNavigation";
import {
  LockIcon,
  MessageReplyIcon,
} from "../../../src/shared/design-system/icons/index";
import {
  channels,
  dms,
  mentions,
  solo,
  threads,
  type Row,
  type Who,
} from "./data";
import "./styles.css";

// Generated stand-ins for profile pictures: a two-hue gradient with a soft
// shape, so rows read like real faces rather than monograms.
function artwork(who: Who) {
  if (!who.hues) return undefined;
  const [a, b] = who.hues;
  const shape = who.agent
    ? `<rect x="22" y="22" width="20" height="20" rx="5" fill="white" fill-opacity=".85" transform="rotate(45 32 32)"/>`
    : `<circle cx="32" cy="25" r="11" fill="white" fill-opacity=".8"/><ellipse cx="32" cy="58" rx="20" ry="16" fill="white" fill-opacity=".8"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a} 70% 62%)"/><stop offset="1" stop-color="hsl(${b} 65% 42%)"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/>${shape}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function preview(row: Row): ReactNode {
  if (row.state === "working") return <ShimmerText>{row.preview}</ShimmerText>;
  return row.preview.split(/(@[\w-]+)/).map((part, index) =>
    part.startsWith("@") ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static text segments
      <span key={index} className="gallery-mention">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function placeIcon(row: Row) {
  if (row.kind === "thread")
    return <MessageReplyIcon size={14} aria-label="Thread" />;
  if (row.kind === "private")
    return <LockIcon size={14} aria-label="Private channel" />;
  return undefined;
}

function SpecimenRow({
  row,
  selected,
  highlighted,
  onMarkRead,
}: {
  onMarkRead?: (() => void) | undefined;
  row: Row;
  selected?: boolean | undefined;
  highlighted?: boolean | undefined;
}) {
  return (
    <ConversationRow
      selected={selected ?? false}
      highlighted={highlighted ?? false}
      avatar={
        <Avatar
          src={artwork(row.who)}
          alt=""
          fallback={row.who.name}
          size="fill"
          fallbackSurface="panel"
          shape={row.who.agent ? "squircle" : "circle"}
        />
      }
      placeIcon={placeIcon(row)}
      place={row.place}
      time={row.time}
      sender={row.sender}
      preview={preview(row)}
      state={row.state}
      onMarkRead={onMarkRead ?? (() => {})}
    />
  );
}

function Stack({
  title,
  rows,
  selected,
}: {
  title: string;
  rows: Row[];
  selected?: string;
}) {
  // Mark as read works here: hover an unread row and press the checkmark.
  const [read, setRead] = useState<ReadonlySet<string>>(new Set());
  return (
    <figure className="gallery-column">
      <figcaption>{title}</figcaption>
      <div className="gallery-sidebar">
        <SidebarNavigation>
          <ul className="gallery-rows">
            {rows.map((row) => (
              <li key={row.id}>
                <SpecimenRow
                  row={
                    read.has(row.id) ? { ...row, state: "read" as const } : row
                  }
                  selected={row.id === selected}
                  onMarkRead={() => setRead(new Set(read).add(row.id))}
                />
              </li>
            ))}
          </ul>
        </SidebarNavigation>
      </div>
    </figure>
  );
}

const knobs = [
  { key: "avatar", label: "Avatar", min: 20, max: 40, step: 2, initial: 36 },
  {
    key: "pad-block",
    label: "Row padding",
    min: 0,
    max: 14,
    step: 1,
    initial: 6,
  },
  {
    key: "column-gap",
    label: "Avatar gap",
    min: 4,
    max: 16,
    step: 1,
    initial: 10,
  },
  { key: "line-gap", label: "Line gap", min: 0, max: 8, step: 1, initial: 4 },
  { key: "stack-gap", label: "Row gap", min: 0, max: 8, step: 1, initial: 2 },
] as const;
type Knob = (typeof knobs)[number]["key"];

// Three densities to compare against; the sliders fine-tune from any of them.
const presets: Record<string, Record<Knob, number>> = {
  comfortable: {
    avatar: 36,
    "pad-block": 9,
    "column-gap": 12,
    "line-gap": 4,
    "stack-gap": 2,
  },
  proposed: {
    avatar: 32,
    "pad-block": 6,
    "column-gap": 10,
    "line-gap": 2,
    "stack-gap": 2,
  },
  compact: {
    avatar: 28,
    "pad-block": 4,
    "column-gap": 8,
    "line-gap": 0,
    "stack-gap": 0,
  },
};

const states: {
  label: string;
  row: Row;
  selected?: boolean;
  highlighted?: boolean;
}[] = [
  { label: "Read", row: channels[2] as Row },
  { label: "Unread", row: channels[0] as Row },
  { label: "Hover", row: channels[0] as Row, highlighted: true },
  { label: "Selected", row: channels[2] as Row, selected: true },
  { label: "Selected + unread", row: channels[0] as Row, selected: true },
  { label: "Agent working", row: solo[1] as Row },
  { label: "Thread", row: threads[0] as Row },
  { label: "Long place", row: solo[5] as Row },
  { label: "Emoji only", row: channels[5] as Row },
  { label: "No picture", row: dms[5] as Row },
];

function Gallery() {
  const params = new URLSearchParams(location.search);
  const [theme, setTheme] = useState(params.get("theme") ?? "light");
  const [width, setWidth] = useState(Number(params.get("width") ?? 264));
  const [lines, setLines] = useState(params.get("lines") ?? "1");
  const [previewSize, setPreviewSize] = useState(
    params.get("preview") ?? "body",
  );
  const [align, setAlign] = useState(params.get("align") ?? "center");
  const [spacing, setSpacing] = useState(params.has("spacing"));
  const [values, setValues] = useState<Record<Knob, number>>(
    () =>
      Object.fromEntries(
        knobs.map((knob) => [
          knob.key,
          Number(params.get(knob.key) ?? knob.initial),
        ]),
      ) as Record<Knob, number>,
  );
  const [height, setHeight] = useState(0);
  const measured = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.colorMode = theme;
  }, [theme]);
  useEffect(() => {
    const row = measured.current?.querySelector("[data-conversation-row]");
    if (!row) return;
    const observer = new ResizeObserver(() =>
      setHeight(Math.round(row.getBoundingClientRect().height)),
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const style = {
    "--gallery-width": `${width}px`,
    "--gallery-stack-gap": `${values["stack-gap"]}px`,
    "--conversation-row-avatar": `${values.avatar}px`,
    "--conversation-row-pad-block": `${values["pad-block"]}px`,
    "--conversation-row-column-gap": `${values["column-gap"]}px`,
    "--conversation-row-line-gap": `${values["line-gap"]}px`,
    "--conversation-row-preview-lines": lines,
  } as CSSProperties;

  const segmented = (
    label: string,
    value: string,
    set: (value: string) => void,
    options: [string, string][],
  ) => (
    <fieldset className="gallery-segmented">
      <legend>{label}</legend>
      {options.map(([option, text]) => (
        <label key={option} data-checked={value === option || undefined}>
          <input
            type="radio"
            checked={value === option}
            onChange={() => set(option)}
          />
          {text}
        </label>
      ))}
    </fieldset>
  );

  return (
    <main
      className="gallery"
      data-buzz-ui=""
      data-show-spacing={spacing || undefined}
      data-avatar-align={align}
      data-preview-size={previewSize === "small" ? "small" : undefined}
      style={style}
    >
      <header className="gallery-header">
        <p className="gallery-eyebrow">BUZZ / COMPONENTS / 01</p>
        <h1>Conversation row</h1>
        <p className="gallery-intro">
          One row for every list. The <strong>place</strong> always leads, the{" "}
          <strong>avatar</strong> is who you’d be talking to, the second line is{" "}
          <strong>who said what</strong>, and the right column holds{" "}
          <strong>when</strong> and <strong>state</strong>.
        </p>
      </header>

      <section className="gallery-controls" aria-label="Controls">
        {segmented(
          "Density",
          Object.keys(presets).find(
            (name) => JSON.stringify(presets[name]) === JSON.stringify(values),
          ) ?? "custom",
          (name) => setValues({ ...(presets[name] as Record<Knob, number>) }),
          [
            ["comfortable", "Comfortable"],
            ["proposed", "Medium"],
            ["compact", "Compact"],
          ],
        )}
        {segmented("Theme", theme, setTheme, [
          ["light", "Light"],
          ["dark", "Dark"],
        ])}
        {segmented("Sidebar width", String(width), (v) => setWidth(Number(v)), [
          ["240", "240"],
          ["264", "264"],
          ["300", "300"],
        ])}
        {segmented("Preview", lines, setLines, [
          ["1", "1 line"],
          ["2", "2 lines"],
        ])}
        {segmented("Preview type", previewSize, setPreviewSize, [
          ["body", "14"],
          ["small", "12"],
        ])}
        {segmented("Avatar", align, setAlign, [
          ["center", "Centered"],
          ["top", "Top"],
        ])}
        {knobs.map((knob) => (
          <label key={knob.key} className="gallery-knob">
            <span>
              {knob.label} <output>{values[knob.key]}px</output>
            </span>
            <input
              type="range"
              min={knob.min}
              max={knob.max}
              step={knob.step}
              value={values[knob.key]}
              onChange={(event) =>
                setValues({ ...values, [knob.key]: Number(event.target.value) })
              }
            />
          </label>
        ))}
        <label className="gallery-toggle">
          <input
            type="checkbox"
            checked={spacing}
            onChange={(event) => setSpacing(event.target.checked)}
          />
          Show spacing
        </label>
        <p className="gallery-readout">
          Row <strong>{height}px</strong> ·{" "}
          {height ? Math.floor(720 / (height + values["stack-gap"])) : "–"} rows
          in a 720px sidebar
        </p>
      </section>

      <section className="gallery-section">
        <h2>Anatomy</h2>
        <div className="gallery-anatomy">
          <div className="gallery-zoom" data-show-spacing="">
            <div className="gallery-sidebar">
              <SidebarNavigation>
                <SpecimenRow row={threads[0] as Row} />
              </SidebarNavigation>
            </div>
          </div>
          <ol className="gallery-legend">
            <li>
              <b>Spacing</b> pink is row padding ({values["pad-block"]}px top
              and bottom, 8px sides). Blue boxes are slots: avatar{" "}
              {values.avatar}px, {values["column-gap"]}px to the text,{" "}
              {values["line-gap"]}px between the lines.
            </li>
            <li>
              <b>Avatar</b> who you’d be talking to: the latest poster who isn’t
              you (Team), the agent (Solo), the other person (DMs). Agents are
              squircles, people are circles.
            </li>
            <li>
              <b>Place</b> the title, always: #channel, chat title, person. A
              thread is a thread icon and “in #channel”.
            </li>
            <li>
              <b>Preview</b> the latest message. The avatar says who, so there
              is no sender, except “You:” for your own message.
            </li>
            <li>
              <b>Time</b> sits on the title’s baseline; on an unread row, hover
              turns it into a checkmark that marks the row read. <b>State</b>{" "}
              sits under it: the unread dot, typing dots while an agent works,
              nothing when read.
            </li>
          </ol>
        </div>
      </section>

      <section className="gallery-section">
        <h2>States</h2>
        <div className="gallery-states">
          {states.map((state) => (
            <figure key={state.label} className="gallery-state">
              <figcaption>{state.label}</figcaption>
              <div className="gallery-sidebar">
                <SidebarNavigation>
                  <SpecimenRow
                    row={state.row}
                    selected={state.selected}
                    highlighted={state.highlighted}
                  />
                </SidebarNavigation>
              </div>
            </figure>
          ))}
        </div>
      </section>

      <section className="gallery-section">
        <h2>In a stack</h2>
        <div className="gallery-stacks" ref={measured}>
          <Stack title="Solo" rows={solo} selected="s3" />
          <Stack title="Team · Channels" rows={channels} />
          <Stack title="Team · Threads" rows={threads} />
          <Stack title="Team · Mentions" rows={mentions} />
          <Stack title="DMs" rows={dms} />
        </div>
      </section>

      <section className="gallery-section">
        <h2>Wide (Activity page width)</h2>
        <div className="gallery-wide">
          <Stack title="Team · Threads at 560px" rows={threads} />
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
