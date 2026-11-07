import { bookmark, readBookmarks, writeBookmarks } from "./model";

export const inject = ["react", "panels", "relay"];

export function apply(ctx) {
  const React = ctx.react;
  let enabled = true;
  ctx.effect(() => () => {
    enabled = false;
  });
  const gap = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  };
  const row = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "var(--space-1)",
  };
  // External plugins use the host's exposed control roles and layout tokens.
  function Button({ children, primary = false, disabled = false, ...props }) {
    return (
      <button
        type="button"
        data-buzz-ui=""
        className="buzz-button"
        data-size="sm"
        data-variant={primary ? "prominent" : "subtle"}
        data-button-shape="capsule"
        {...props}
        disabled={disabled}
        data-disabled={disabled ? "" : undefined}
      >
        <span className="buzz-button-label">{children}</span>
      </button>
    );
  }
  function useHint(trigger, text, disabled = false, available) {
    const tooltipId = React.useId();
    React.useEffect(() => {
      const button = trigger.current;
      if (!button || disabled) return;
      let timer;
      let popup;
      let dismissed = false;
      const hide = () => {
        clearTimeout(timer);
        popup?.remove();
        popup = undefined;
        button.removeAttribute("aria-describedby");
      };
      const show = () => {
        if (!enabled || (available && !available()) || dismissed || popup)
          return;
        popup = document.createElement("div");
        popup.className = "buzz-tooltip-positioner";
        Object.assign(popup.style, {
          position: "fixed",
          pointerEvents: "none",
        });
        const bubble = document.createElement("div");
        bubble.id = tooltipId;
        bubble.className = "buzz-tooltip";
        bubble.setAttribute("role", "tooltip");
        bubble.setAttribute("data-buzz-ui", "");
        bubble.textContent = text;
        popup.append(bubble);
        document.body.append(popup);
        const anchor = button.getBoundingClientRect();
        const bounds = popup.getBoundingClientRect();
        // Match the host tooltip's 4px offset and 8px collision padding.
        const left = Math.max(
          8,
          Math.min(
            anchor.left + (anchor.width - bounds.width) / 2,
            window.innerWidth - bounds.width - 8,
          ),
        );
        const below = anchor.bottom + 4;
        const top =
          below + bounds.height <= window.innerHeight - 8
            ? below
            : Math.max(8, anchor.top - bounds.height - 4);
        Object.assign(popup.style, { left: `${left}px`, top: `${top}px` });
        button.setAttribute("aria-describedby", tooltipId);
      };
      const rest = () => {
        if (!popup && !dismissed) {
          clearTimeout(timer);
          timer = setTimeout(show, 250);
        }
      };
      const enter = () => {
        dismissed = false;
        rest();
      };
      const leave = () => {
        dismissed = false;
        hide();
      };
      const focus = () => {
        if (!dismissed) show();
      };
      const dismiss = () => {
        dismissed = true;
        hide();
      };
      const key = (event) => {
        if (event.key === "Tab") dismissed = false;
        if (event.key === "Escape") dismiss();
      };
      const events = {
        pointerenter: enter,
        pointermove: rest,
        pointerleave: leave,
        focus,
        blur: hide,
        pointerdown: dismiss,
        click: dismiss,
      };
      for (const [name, listener] of Object.entries(events))
        button.addEventListener(name, listener);
      window.addEventListener("keydown", key);
      window.addEventListener("scroll", hide, true);
      window.addEventListener("resize", hide);
      return () => {
        hide();
        for (const [name, listener] of Object.entries(events))
          button.removeEventListener(name, listener);
        window.removeEventListener("keydown", key);
        window.removeEventListener("scroll", hide, true);
        window.removeEventListener("resize", hide);
      };
    }, [trigger, text, disabled, available, tooltipId]);
  }
  const iconProps = {
    type: "button",
    className: "buzz-button",
    "data-buzz-ui": "",
    "data-size": "sm",
    "data-icon-variant": "ghost",
    "data-icon-size": "sm",
    "data-icon-shape": "control",
    "data-variant": "ghost",
  };
  function QuietHandle({ children, ...props }) {
    const trigger = React.useRef(null);
    useHint(trigger, "Drag to reorder · Arrow Up/Down", props["aria-disabled"]);
    return (
      <button
        {...iconProps}
        {...props}
        ref={trigger}
        data-disabled={
          props.disabled || props["aria-disabled"] ? "" : undefined
        }
      >
        {children}
      </button>
    );
  }
  function Actions({ item, disabled, edit, remove }) {
    const [open, setOpen] = React.useState(false);
    const [highlighted, setHighlighted] = React.useState(0);
    const trigger = React.useRef(null);
    const popup = React.useRef(null);
    const id = React.useId();
    const close = () => {
      setOpen(false);
      trigger.current?.focus();
    };
    React.useLayoutEffect(() => {
      if (!open) return;
      const menu = popup.current;
      menu.showPopover?.();
      const anchor = trigger.current.getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      Object.assign(menu.style, {
        left: `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`,
        top: `${anchor.bottom + 4 + bounds.height <= window.innerHeight - 8 ? anchor.bottom + 4 : Math.max(8, anchor.top - bounds.height - 4)}px`,
      });
      menu.querySelector("button")?.focus();
      const dismiss = () => setOpen(false);
      window.addEventListener("resize", dismiss);
      window.addEventListener("scroll", dismiss, true);
      return () => {
        window.removeEventListener("resize", dismiss);
        window.removeEventListener("scroll", dismiss, true);
      };
    }, [open]);
    React.useEffect(() => {
      if (disabled) setOpen(false);
    }, [disabled]);
    return (
      <>
        <button
          {...iconProps}
          ref={trigger}
          aria-label={`Actions for ${item.label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          disabled={disabled}
          data-disabled={disabled ? "" : undefined}
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            {[5, 12, 19].map((x) => (
              <circle key={x} cx={x} cy="12" r="1" />
            ))}
          </svg>
        </button>
        {open && (
          <div
            id={id}
            ref={popup}
            popover="auto"
            role="menu"
            aria-label={`Actions for ${item.label}`}
            className="buzz-menu-popup text-body-sm"
            data-buzz-ui=""
            data-size="compact"
            style={{
              position: "fixed",
              margin: 0,
              inset: "auto",
              "--available-width": "calc(100vw - 16px)",
              "--available-height": "calc(100vh - 16px)",
            }}
            onToggle={(event) => {
              if (event.newState === "closed") setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              } else if (event.key === "Tab") close();
              else if (
                ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const items = [
                  ...event.currentTarget.querySelectorAll("button"),
                ];
                const i = items.indexOf(document.activeElement);
                items[
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (i +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          items.length) %
                        items.length
                ]?.focus();
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="buzz-menu-item"
              data-buzz-ui=""
              style={{ width: "100%" }}
              data-highlighted={highlighted === 0 ? "" : undefined}
              onFocus={() => setHighlighted(0)}
              onPointerEnter={() => setHighlighted(0)}
              onClick={() => {
                close();
                edit();
              }}
            >
              Edit
            </button>
            <button
              type="button"
              role="menuitem"
              className="buzz-menu-item"
              data-buzz-ui=""
              data-tone="danger"
              style={{ width: "100%" }}
              data-highlighted={highlighted === 1 ? "" : undefined}
              onFocus={() => setHighlighted(1)}
              onPointerEnter={() => setHighlighted(1)}
              onClick={() => {
                close();
                remove();
              }}
            >
              Remove
            </button>
          </div>
        )}
      </>
    );
  }
  function Launcher({ context, toggle, pressed, available }) {
    const trigger = React.useRef(null);
    useHint(trigger, "Bookmarks", pressed, available);
    return (
      <button
        ref={trigger}
        tabIndex={0}
        type="button"
        className="buzz-button"
        data-buzz-ui=""
        data-size="sm"
        data-icon-variant="ghost"
        data-icon-size="sm"
        data-icon-shape="control"
        data-variant="ghost"
        aria-label="Toggle channel bookmarks"
        aria-expanded={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          if (enabled && available()) toggle(context.channelId);
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4" />
        </svg>
      </button>
    );
  }
  function Editor({ session, channelId, active }) {
    const channels = React.useSyncExternalStore(
      session.channels.subscribeList,
      session.channels.list,
    );
    const channel = channels.channels.find((item) => item.id === channelId);
    const canRead =
      !!channel &&
      !channel.cached &&
      !!channel.members?.includes(session.viewer ?? "");
    const canWrite =
      canRead &&
      !channel.archived &&
      !channel.readOnly &&
      session.canvas.available;
    const [saved, setSaved] = React.useState();
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [editing, setEditing] = React.useState();
    const [formOpen, setFormOpen] = React.useState(false);
    const [label, setLabel] = React.useState("");
    const [url, setUrl] = React.useState("");
    const dragging = React.useRef(null);
    const [dropTarget, setDropTarget] = React.useState(null);
    const [announcement, setAnnouncement] = React.useState("");
    const nameId = React.useId();
    const urlId = React.useId();
    const operation = React.useRef(0);
    const working = React.useRef(false);
    const current = React.useRef({ active, canRead, canWrite });
    current.current = { active, canRead, canWrite };
    const nameInput = React.useRef(null);
    const addButton = React.useRef(null);
    React.useLayoutEffect(() => {
      if (formOpen) nameInput.current?.focus();
    }, [formOpen, editing]);
    const origin = React.useRef(null);
    React.useLayoutEffect(() => {
      if (
        origin.current &&
        !origin.current.isConnected &&
        document.activeElement === document.body
      )
        (nameInput.current ?? addButton.current)?.focus();
      origin.current = null;
    });
    const valid = React.useCallback(
      (generation) =>
        operation.current === generation &&
        current.current.active() &&
        current.current.canRead,
      [],
    );
    const load = React.useCallback(async () => {
      if (
        working.current ||
        !current.current.active() ||
        !current.current.canRead
      )
        return;
      const generation = ++operation.current;
      working.current = true;
      setBusy(true);
      setError("");
      try {
        const head = await session.canvas.read(channelId);
        const items = readBookmarks(head?.content ?? "").items;
        if (!valid(generation)) return;
        setSaved({ content: head?.content ?? "", id: head?.id, items });
        return items;
      } catch (reason) {
        if (valid(generation)) {
          setSaved(undefined);
          setError(String(reason));
        }
      } finally {
        if (generation === operation.current) {
          working.current = false;
          setBusy(false);
        }
      }
    }, [session, channelId, valid]);
    React.useEffect(() => {
      if (canRead) void load();
      return () => {
        operation.current++;
        working.current = false;
      };
    }, [load, canRead]);
    async function save(items, clear = false) {
      if (
        !saved ||
        working.current ||
        !current.current.active() ||
        !current.current.canWrite
      )
        return;
      const trigger = document.activeElement;
      const generation = ++operation.current;
      working.current = true;
      setBusy(true);
      setError("");
      try {
        const content = writeBookmarks(saved.content, items);
        const head = await session.canvas.save(channelId, content, saved.id, {
          preserveApproval: true,
        });
        if (!valid(generation)) return;
        origin.current = trigger;
        setSaved({
          content: head.content,
          id: head.id,
          items: readBookmarks(head.content).items,
        });
        setEditing(undefined);
        setAnnouncement("Bookmarks saved.");
        if (clear) {
          setLabel("");
          setUrl("");
          setFormOpen(false);
        }
      } catch (reason) {
        if (valid(generation)) {
          setAnnouncement("");
          if (reason?.name === "CanvasConflictError") {
            working.current = false;
            const loaded = await load();
            if (current.current.active() && current.current.canRead)
              setError(
                loaded
                  ? editing !== undefined &&
                    !loaded.some((item) => item.url === editing)
                    ? "The bookmark you were editing no longer exists at its original URL. Your input is kept. Cancel this edit to add a new bookmark."
                    : "Bookmarks changed elsewhere. The latest links are loaded and your input is kept. Review them before trying again."
                  : "Couldn’t load the latest bookmarks. Retry before saving. Your input is kept.",
              );
          } else
            setError(`Couldn’t save. ${reason?.message ?? String(reason)}`);
        }
      } finally {
        if (generation === operation.current) {
          working.current = false;
          setBusy(false);
        }
      }
    }
    function reorder(from, to) {
      if (
        from === to ||
        to < 0 ||
        to >= saved.items.length ||
        editing !== undefined
      )
        return;
      const items = [...saved.items];
      const [item] = items.splice(from, 1);
      items.splice(to, 0, item);
      setAnnouncement(
        `Moving ${item.label} to position ${to + 1} of ${items.length}.`,
      );
      void save(items);
    }
    function cancelDrag() {
      dragging.current = null;
      setDropTarget(null);
    }
    if (!canRead)
      return (
        <p role="status">
          Bookmarks are unavailable until channel access is confirmed.
        </p>
      );
    const disabled = busy || !saved || !canWrite;
    return (
      <section
        aria-label="Channel bookmarks"
        aria-busy={busy}
        style={{ ...gap, padding: "var(--space-panel-inset)", minWidth: 0 }}
      >
        {busy && <p role="status">Loading or saving bookmarks…</p>}
        {error && <p role="alert">{error}</p>}
        {!busy && !saved && error && (
          <Button onClick={() => void load()}>Retry loading bookmarks</Button>
        )}
        {saved && !saved.items.length && <p>No bookmarks yet.</p>}
        <span role="status" className="sr-only">
          {announcement}
        </span>
        {saved?.items.map((item, index) => (
          <div
            key={item.url}
            data-bookmark-index={index}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              paddingBlock: "var(--space-2)",
              borderBottom: "1px solid var(--border-standard)",
              background:
                dropTarget === index ? "var(--surface-inset)" : undefined,
            }}
          >
            {canWrite && saved.items.length > 1 && (
              <QuietHandle
                aria-label={`Reorder ${item.label}`}
                aria-description="Drag to reorder, or use Arrow Up and Arrow Down."
                aria-disabled={disabled || editing !== undefined}
                style={{
                  touchAction: "none",
                  cursor:
                    disabled || editing !== undefined ? "default" : "grab",
                  userSelect: "none",
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && dragging.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelDrag();
                    return;
                  }
                  if (
                    disabled ||
                    editing !== undefined ||
                    dragging.current ||
                    !["ArrowUp", "ArrowDown"].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  reorder(index, index + (event.key === "ArrowUp" ? -1 : 1));
                }}
                onPointerDown={(event) => {
                  if (
                    disabled ||
                    editing !== undefined ||
                    event.button !== 0 ||
                    !event.isPrimary
                  )
                    return;
                  event.currentTarget.focus();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragging.current = {
                    from: index,
                    to: index,
                    head: saved,
                    pointerId: event.pointerId,
                  };
                }}
                onPointerMove={(event) => {
                  const drag = dragging.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  const target = document
                    .elementFromPoint(event.clientX, event.clientY)
                    ?.closest("[data-bookmark-index]");
                  const section = event.currentTarget.closest("section");
                  const next =
                    target && section?.contains(target)
                      ? Number(target.dataset.bookmarkIndex)
                      : null;
                  drag.to = next;
                  setDropTarget(next);
                }}
                onPointerUp={(event) => {
                  const drag = dragging.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  cancelDrag();
                  if (drag.head === saved && drag.to !== null && !disabled)
                    reorder(drag.from, drag.to);
                }}
                onPointerCancel={cancelDrag}
                onLostPointerCapture={cancelDrag}
                onBlur={cancelDrag}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  {[5, 12, 19].flatMap((y) =>
                    [9, 15].map((x) => (
                      <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />
                    )),
                  )}
                </svg>
              </QuietHandle>
            )}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
                minWidth: 0,
                flex: 1,
              }}
            >
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  overflowWrap: "anywhere",
                  color: "var(--text-link)",
                  textDecoration: "underline",
                  fontSize: "var(--text-label)",
                  lineHeight: "var(--text-label--line-height)",
                  letterSpacing: "var(--text-label--letter-spacing)",
                  fontWeight: "var(--text-label--font-weight)",
                }}
              >
                {item.label}
              </a>
              <span
                title={item.url}
                style={{
                  overflowWrap: "anywhere",
                  color: "var(--text-metadata)",
                  fontSize: "var(--text-caption)",
                  lineHeight: "var(--text-caption--line-height)",
                  letterSpacing: "var(--text-caption--letter-spacing)",
                  fontWeight: "var(--text-caption--font-weight)",
                }}
              >
                {new URL(item.url).host}
              </span>
            </div>
            {canWrite && (
              <Actions
                item={item}
                disabled={disabled || editing !== undefined}
                edit={() => {
                  setEditing(item.url);
                  setLabel(item.label);
                  setUrl(item.url);
                  setFormOpen(true);
                }}
                remove={() =>
                  void save(saved.items.filter((_, i) => i !== index))
                }
              />
            )}
          </div>
        ))}
        {canWrite && !formOpen && (
          <Button
            ref={addButton}
            primary
            disabled={disabled}
            onClick={() => {
              setEditing(undefined);
              setLabel("");
              setUrl("");
              setFormOpen(true);
            }}
          >
            Add bookmark
          </Button>
        )}
        {canWrite && formOpen && (
          <form
            style={gap}
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !saved) return;
              try {
                const item = bookmark(label, url);
                const items = [...saved.items];
                if (editing === undefined) items.push(item);
                else {
                  const index = items.findIndex(
                    (savedItem) => savedItem.url === editing,
                  );
                  if (index < 0)
                    throw new Error(
                      "The bookmark you were editing no longer exists. Cancel this edit to add a new bookmark.",
                    );
                  items[index] = item;
                }
                void save(items, true);
              } catch (reason) {
                setError(String(reason));
              }
            }}
          >
            <div className="buzz-field" data-buzz-ui="" style={gap}>
              <label htmlFor={nameId} className="buzz-field-label">
                Bookmark name
              </label>
              <input
                ref={nameInput}
                id={nameId}
                className="buzz-input"
                data-buzz-ui=""
                data-size="md"
                value={label}
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="buzz-field" data-buzz-ui="" style={gap}>
              <label htmlFor={urlId} className="buzz-field-label">
                Bookmark URL
              </label>
              <input
                id={urlId}
                className="buzz-input"
                data-buzz-ui=""
                data-size="md"
                value={url}
                disabled={busy}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div style={row}>
              <Button
                disabled={busy}
                onClick={(event) => {
                  origin.current = event.currentTarget;
                  setFormOpen(false);
                  setEditing(undefined);
                  setLabel("");
                  setUrl("");
                  setError("");
                  addButton.current?.focus();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" primary disabled={disabled}>
                {editing === undefined ? "Add bookmark" : "Save bookmark"}
              </Button>
            </div>
          </form>
        )}
      </section>
    );
  }
  function Panel({ channelContext, close }) {
    const closeTrigger = React.useRef(null);
    useHint(closeTrigger, "Close bookmarks");
    const state = React.useSyncExternalStore(
      ctx.relay.subscribe,
      ctx.relay.snapshot,
    );
    const active = React.useCallback(
      () => enabled && ctx.relay.snapshot() === state,
      [state],
    );
    const connected =
      channelContext &&
      state.status === "ready" &&
      state.scope === channelContext.scope;
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <header data-buzz-ui="" className="panel-header">
          <div className="panel-header-title">
            <div className="panel-header-label">
              <h2>Bookmarks</h2>
            </div>
          </div>
          <div className="panel-header-actions">
            <button
              {...iconProps}
              ref={closeTrigger}
              aria-label="Close bookmarks"
              onClick={close}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M18 6l-12 12M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>
        <div
          data-bookmarks-scroll=""
          style={{ flex: 1, minHeight: 0, overflow: "auto" }}
        >
          {connected ? (
            <Editor
              key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
              session={state.session}
              channelId={channelContext.channelId}
              active={active}
            />
          ) : (
            <p role="status">Connect to this channel to view bookmarks.</p>
          )}
        </div>
      </div>
    );
  }

  ctx.panels.register({
    id: "bookmarks",
    title: "Bookmarks",
    matches: () => false,
    channelLauncher: Launcher,
    channelPlacement: "side",
    component: Panel,
  });
}
