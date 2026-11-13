import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { DialRoot } from "dialkit";
import "dialkit/styles.css";
import "./playground.css";

type View = "gallery" | "stage" | "compare" | "flow";
export type Appearance = { theme: "light" | "dark"; textScale: number };
export type TunerProps = {
  children: (
    render: (variant: string) => ReactNode,
    flow?: ReactNode,
  ) => ReactNode;
};
export type Entry = {
  id: string;
  title: string;
  kind: "component" | "experience";
  purpose: string;
  mechanics: string[];
  sources: string[];
  parts?: string[];
  variants: { id: string; label: string }[];
  Tuner: ComponentType<TunerProps>;
};
type PreviewProps = Appearance & { children: ReactNode };
const views: View[] = ["gallery", "stage", "compare", "flow"];

function readLocation() {
  const [id = "", view] = location.hash.slice(1).split("/");
  return {
    id,
    view: views.includes(view as View) ? (view as View) : ("gallery" as View),
  };
}
function DefaultPreview({ children }: PreviewProps) {
  return <>{children}</>;
}

export function Playground({
  title,
  entries,
  Preview = DefaultPreview,
  onAppearanceChange,
}: {
  title: string;
  entries: Entry[];
  Preview?: ComponentType<PreviewProps>;
  onAppearanceChange?: (appearance: Appearance) => void;
}) {
  const [route, setRoute] = useState(readLocation);
  const [theme, setTheme] = useState<Appearance["theme"]>("light");
  const [textScale, setTextScale] = useState(1);
  const [width, setWidth] = useState("640");
  useEffect(() => {
    const sync = () => setRoute(readLocation());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    onAppearanceChange?.({ theme, textScale });
  }, [theme, textScale, onAppearanceChange]);
  const entry = entries.find((item) => item.id === route.id) ?? entries[0];
  if (!entry) return <p>Add a component to start this playground.</p>;
  return (
    <div className="pg-shell" data-theme={theme}>
      <header className="pg-top">
        <a className="pg-brand" href={`#${entry.id}/gallery`}>
          {title}
        </a>
        <span className="pg-caption">Design workspace</span>
        <div className="pg-toolbar">
          <label>
            Theme
            <select
              value={theme}
              onChange={(event) =>
                setTheme(event.target.value as Appearance["theme"])
              }
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Width
            <select
              value={width}
              onChange={(event) => setWidth(event.target.value)}
            >
              {["360", "480", "640", "960"].map((value) => (
                <option key={value} value={value}>
                  {value}px
                </option>
              ))}
            </select>
          </label>
          <label>
            Text
            <select
              value={textScale}
              onChange={(event) => setTextScale(Number(event.target.value))}
            >
              {[1, 1.5, 2].map((value) => (
                <option key={value} value={value}>
                  {value * 100}%
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <div className="pg-layout">
        <nav className="pg-nav" aria-label="Playground inventory">
          {(["component", "experience"] as const).map((kind) => (
            <section key={kind}>
              <h2>{kind === "component" ? "Components" : "Experiences"}</h2>
              {entries
                .filter((item) => item.kind === kind)
                .map((item) => (
                  <a
                    key={item.id}
                    href={`#${item.id}/${route.view}`}
                    aria-current={item.id === entry.id ? "page" : undefined}
                  >
                    {item.title}
                  </a>
                ))}
            </section>
          ))}
        </nav>
        <Selection
          key={entry.id}
          {...{
            entry,
            entries,
            view: route.view,
            width,
            theme,
            textScale,
            Preview,
          }}
        />
      </div>
    </div>
  );
}

function Selection({
  entry,
  entries,
  view,
  width,
  theme,
  textScale,
  Preview,
}: {
  entry: Entry;
  entries: Entry[];
  view: View;
  width: string;
  Preview: ComponentType<PreviewProps>;
} & Appearance) {
  const [variant, setVariant] = useState(entry.variants[0]?.id ?? "");
  const [right, setRight] = useState(entry.variants[1]?.id ?? variant);
  const [revision, setRevision] = useState(0);
  const Tuner = entry.Tuner;
  const picker = (
    label: string,
    value: string,
    change: (value: string) => void,
  ) => (
    <label>
      {label}
      <select value={value} onChange={(event) => change(event.target.value)}>
        {entry.variants.map((state) => (
          <option key={state.id} value={state.id}>
            {state.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Tuner>
      {(render, flow) => {
        const specimen = (id: string, slot: string) => (
          <div
            key={`${slot}-${id}-${revision}`}
            className="pg-preview"
            style={{ width: `${width}px`, fontSize: "1rem" }}
          >
            <Preview {...{ theme, textScale }}>{render(id)}</Preview>
          </div>
        );
        return (
          <>
            <main className="pg-main" id="pg-workspace">
              <header className="pg-heading">
                <p className="pg-caption">{entry.kind}</p>
                <h1>{entry.title}</h1>
                <p>{entry.purpose}</p>
                <nav className="pg-views" aria-label="Workspace views">
                  {views.map((mode) => (
                    <a
                      key={mode}
                      href={`#${entry.id}/${mode}`}
                      aria-current={view === mode ? "page" : undefined}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </a>
                  ))}
                </nav>
              </header>
              <div className="pg-options">
                {view === "stage" && picker("State", variant, setVariant)}
                {view === "compare" && (
                  <>
                    {picker("Left state", variant, setVariant)}
                    {picker("Right state", right, setRight)}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  Reset fixtures
                </button>
                <span className="pg-caption">
                  Local fixtures · {width}px preview
                </span>
              </div>
              <div className="pg-canvas">
                {view === "gallery" && (
                  <div className="pg-gallery">
                    {entry.variants.map((state) => (
                      <section key={state.id} aria-label={state.label}>
                        <h2 className="pg-state-label">{state.label}</h2>
                        {specimen(state.id, state.id)}
                      </section>
                    ))}
                  </div>
                )}
                {view === "stage" && specimen(variant, "stage")}
                {view === "compare" && (
                  <div className="pg-compare">
                    {[
                      { side: "Left", id: variant },
                      { side: "Right", id: right },
                    ].map(({ id, side }) => (
                      <section key={side} aria-label={`${side} comparison`}>
                        <h2 className="pg-state-label">
                          {side} ·{" "}
                          {
                            entry.variants.find((state) => state.id === id)
                              ?.label
                          }
                        </h2>
                        {specimen(id, `compare-${side}`)}
                      </section>
                    ))}
                  </div>
                )}
                {view === "flow" &&
                  (flow !== undefined ? (
                    <div
                      key={revision}
                      className="pg-preview pg-flow"
                      style={{ width: `${width}px`, fontSize: "1rem" }}
                    >
                      <Preview {...{ theme, textScale }}>{flow}</Preview>
                    </div>
                  ) : (
                    <div className="pg-message">
                      <h2>Explore this in context</h2>
                      <p>
                        This component is a building block. Open a composed
                        experience to try its flow.
                      </p>
                      {entries
                        .filter(
                          (item) =>
                            item.kind === "experience" &&
                            item.parts?.includes(entry.id),
                        )
                        .map((item) => (
                          <a key={item.id} href={`#${item.id}/flow`}>
                            {item.title} →
                          </a>
                        ))}
                    </div>
                  ))}
              </div>
            </main>
            <aside className="pg-inspector" aria-label="Component inspector">
              <section>
                <details className="pg-explainer">
                  <summary>How it works</summary>
                  {entry.mechanics.map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                  <h2>Source</h2>
                  {entry.sources.map((source) => (
                    <code className="pg-source" key={source}>
                      {source}
                    </code>
                  ))}
                </details>
              </section>
              {!!entry.parts?.length && (
                <section>
                  <h2>Built from</h2>
                  <div className="pg-parts">
                    {entry.parts.map((id) => (
                      <a key={id} href={`#${id}/stage`}>
                        {entries.find((item) => item.id === id)?.title ?? id} →
                      </a>
                    ))}
                  </div>
                </section>
              )}
              <section>
                <h2>
                  Tune {entry.kind === "component" ? "component" : "experience"}
                </h2>
                <p className="pg-caption">
                  Dials share values across states. Reset fixtures leaves tuning
                  intact.
                </p>
                <DialRoot mode="inline" theme={theme} />
              </section>
            </aside>
          </>
        );
      }}
    </Tuner>
  );
}
