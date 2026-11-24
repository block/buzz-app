//#region src/react.ts
var host;
var Fragment;
var useHost = (react) => {
	host = react;
	Fragment = host.Fragment;
};
var createElement = (...args) => host.createElement(...args);
var useState = (...args) => host.useState(...args);
var useEffect = (...args) => host.useEffect(...args);
var useMemo = (...args) => host.useMemo(...args);
var useRef = (...args) => host.useRef(...args);
var useSyncExternalStore = (...args) => host.useSyncExternalStore(...args);
//#endregion
//#region src/styles.ts
var styles = {
	actions: "buzz-canvas-actions",
	address: "buzz-canvas-address",
	buttons: "buzz-canvas-buttons",
	canvas: "buzz-canvas-canvas",
	credit: "buzz-canvas-credit",
	empty: "buzz-canvas-empty",
	emptyState: "buzz-canvas-emptyState",
	error: "buzz-canvas-error",
	fill: "buzz-canvas-fill",
	frame: "buzz-canvas-frame",
	hint: "buzz-canvas-hint",
	map: "buzz-canvas-map",
	mapControls: "buzz-canvas-mapControls",
	pin: "buzz-canvas-pin",
	pinDot: "buzz-canvas-pinDot",
	pinLabel: "buzz-canvas-pinLabel",
	plus: "buzz-canvas-plus",
	quiet: "buzz-canvas-quiet",
	tile: "buzz-canvas-tile",
	video: "buzz-canvas-video",
	view: "buzz-canvas-view"
};
var css = "/* Fills its panel whether the host lays that out as a flex column or a grid. */ .buzz-canvas-canvas { display: flex; flex: 1; flex-direction: column; height: 100%; min-height: 0; min-width: 0; position: relative; } /* The buttons sit at the end of the view's top row, which leaves them room. */ .buzz-canvas-buttons { position: absolute; top: var(--space-1); right: var(--space-2); z-index: 1; display: flex; align-items: center; gap: var(--space-1); border-radius: var(--radius-control); background: var(--surface-panel); } .buzz-canvas-plus { z-index: 2; display: flex; } .buzz-canvas-quiet { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; } .buzz-canvas-view { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; overflow: auto; } .buzz-canvas-empty { flex: 1; display: grid; place-items: center; padding: var(--space-4); } .buzz-canvas-actions { display: flex; justify-content: center; gap: var(--space-2); flex-wrap: wrap; } .buzz-canvas-error { padding: var(--space-2) var(--space-3); color: var(--text-danger); } .buzz-canvas-fill { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; } .buzz-canvas-address { display: flex; gap: var(--space-2); padding: var(--space-1) var(--space-2); padding-right: calc(var(--buzz-canvas-room, 0px) + var(--space-3)); border-bottom: 1px solid var(--border-standard); } /* The host's browser view brings its own top row: the canvas's buttons go at its end, in place of the page title the tab already shows. */ .buzz-canvas-fill [role=\"toolbar\"][aria-label=\"Browser controls\"] { padding-right: calc(var(--buzz-canvas-room, 0px) + var(--space-3)); } .buzz-canvas-fill [role=\"toolbar\"][aria-label=\"Browser controls\"] > span { display: none; } .buzz-canvas-address > :first-child { flex: 1; min-width: 0; } .buzz-canvas-hint { margin: auto; padding: var(--space-4); color: var(--text-subtle); text-align: center; } .buzz-canvas-frame, .buzz-canvas-video { flex: 1; min-height: 0; width: 100%; border: 0; } .buzz-canvas-video { background: var(--bg-media-canvas); } .buzz-canvas-map { position: relative; flex: 1; min-height: 12rem; overflow: hidden; touch-action: none; user-select: none; cursor: grab; } .buzz-canvas-map[data-dragging] { cursor: grabbing; } .buzz-canvas-tile { position: absolute; width: 256px; height: 256px; max-width: none; pointer-events: none; } .buzz-canvas-pin { position: absolute; transform: translate(-50%, -100%); display: flex; flex-direction: column; align-items: center; gap: var(--space-1); pointer-events: none; } .buzz-canvas-pinLabel { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 var(--space-1); border: 1px solid var(--border-standard); border-radius: var(--radius-control); background: var(--surface-popover); color: var(--text-standard); font-size: var(--type-xsmall-size); } .buzz-canvas-pinDot { width: 0.75rem; height: 0.75rem; border: 2px solid var(--surface-popover); border-radius: 50%; background: var(--text-danger); } .buzz-canvas-mapControls { position: absolute; top: var(--space-2); left: var(--space-2); display: flex; flex-direction: column; gap: var(--space-1); } .buzz-canvas-credit { position: absolute; right: 0; bottom: 0; padding: 0 var(--space-1); background: var(--surface-popover); color: var(--text-subtle); font-size: var(--type-xsmall-size); } .buzz-canvas-emptyState { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); max-width: 28rem; text-align: center; }";
//#endregion
//#region src/kit.tsx
var ui;
var useHostUi = (next) => {
	ui = next;
};
var Host = (component) => component;
function Button({ variant = "outline", children, ...props }) {
	if (ui?.Button) return /* @__PURE__ */ createElement(Host(ui.Button), {
		...props,
		size: "sm",
		variant: variant === "outline" ? "subtle" : variant
	}, children);
	return /* @__PURE__ */ createElement("button", {
		type: "button",
		...props
	}, children);
}
function Input({ value, onValueChange, invalid, ...props }) {
	if (ui?.Input) return /* @__PURE__ */ createElement(Host(ui.Input), {
		...props,
		value,
		onValueChange
	});
	return /* @__PURE__ */ createElement("input", {
		...props,
		"aria-invalid": invalid || void 0,
		value,
		onChange: (event) => onValueChange(event.currentTarget.value)
	});
}
/** A "+" that offers each choice. */
function AddMenu({ label, items }) {
	const [open, setOpen] = useState(false);
	if (ui?.Menu) return /* @__PURE__ */ createElement(Host(ui.Menu), {
		"aria-label": label,
		icon: /* @__PURE__ */ createElement("span", { "aria-hidden": "true" }, "+"),
		align: "end",
		items
	});
	return /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement(Button, {
		variant: "ghost",
		"aria-label": label,
		onClick: () => setOpen((was) => !was)
	}, "+"), open && /* @__PURE__ */ createElement("div", {
		role: "menu",
		"aria-label": label,
		className: styles.actions
	}, items.map((item) => /* @__PURE__ */ createElement("button", {
		key: item.label,
		type: "button",
		role: "menuitem",
		onClick: () => {
			setOpen(false);
			item.onSelect();
		}
	}, item.label))));
}
function EmptyState({ title, description, action }) {
	return /* @__PURE__ */ createElement("div", { className: styles.emptyState }, /* @__PURE__ */ createElement("h3", null, title), /* @__PURE__ */ createElement("p", { className: styles.hint }, description), action);
}
//#endregion
//#region src/scene.ts
var EMPTY_SCENE = Object.freeze({ items: [] });
var ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var TYPE = /^[a-z][a-z0-9-]{0,31}$/;
var PUBKEY = /^[0-9a-f]{64}$/;
var record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** Reads a saved scene. An item of a type this app knows is kept only if its
* view accepts the state; one of an unknown type is kept as it is, so a viewer
* without that plugin doesn't erase it for everyone else on the next save. */
function parseScene(text, views) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (!record(value) || value.version !== 1 || !Array.isArray(value.items)) return;
	const items = [];
	for (const entry of value.items.slice(0, 12)) {
		if (!record(entry) || typeof entry.id !== "string" || !ID.test(entry.id) || typeof entry.type !== "string" || !TYPE.test(entry.type) || items.some((item) => item.id === entry.id)) continue;
		const view = views.get(entry.type);
		const state = view ? view.parse(entry.state) : entry.state;
		if (state === void 0) continue;
		items.push({
			id: entry.id,
			type: entry.type,
			...typeof entry.title === "string" && entry.title.trim() ? { title: entry.title.trim().slice(0, 80) } : {},
			state
		});
	}
	const active = items.find((item) => item.id === value.active) ?? items[0];
	return {
		items,
		...active ? { active: active.id } : {},
		...typeof value.driver === "string" && PUBKEY.test(value.driver) ? { driver: value.driver } : {}
	};
}
function serializeScene(scene) {
	const text = JSON.stringify({
		version: 1,
		...scene
	});
	if (new TextEncoder().encode(text).length > 48e3) throw new Error("This canvas holds too much to save. Close a view first.");
	return text;
}
/** Adds a view, or replaces the one with that id, and brings it to the front. */
function openItem(scene, views, input) {
	const view = views.get(input.type);
	if (!view) throw new Error(`There is no "${input.type}" canvas view.`);
	const state = view.parse(input.state);
	if (state === void 0) throw new Error(`That is not a valid state for a ${input.type} view.`);
	const id = input.id ?? nextId(scene, input.type);
	if (!ID.test(id)) throw new Error("A view id is lowercase letters, digits, dots, hyphens and underscores.");
	const replaced = scene.items.some((item) => item.id === id);
	if (!replaced && scene.items.length >= 12) throw new Error(`A canvas holds at most 12 views. Close one.`);
	const item = {
		id,
		type: input.type,
		...input.title?.trim() ? { title: input.title.trim().slice(0, 80) } : {},
		state
	};
	return {
		...scene,
		items: replaced ? scene.items.map((other) => other.id === id ? item : other) : [...scene.items, item],
		active: id
	};
}
/** The id a new view of this type would get. */
var nextId = (scene, type) => {
	for (let index = 1;; index++) {
		const id = `${type}-${index}`;
		if (!scene.items.some((item) => item.id === id)) return id;
	}
};
/** Changes what one view shows, without changing which is in front. */
function updateItem(scene, views, id, input) {
	const item = scene.items.find((other) => other.id === id);
	if (!item) throw new Error(`There is no view "${id}" on this canvas.`);
	const view = views.get(item.type);
	const state = view ? view.parse(input) : void 0;
	if (state === void 0) throw new Error(`That is not a valid state for a ${item.type} view.`);
	return {
		...scene,
		items: scene.items.map((other) => other === item ? {
			...item,
			state
		} : other)
	};
}
function closeItem(scene, id) {
	const index = scene.items.findIndex((item) => item.id === id);
	if (index < 0) throw new Error(`There is no view "${id}" on this canvas.`);
	const items = scene.items.filter((item) => item.id !== id);
	const { active: _active, ...rest } = scene;
	const next = scene.active === id ? (items[index] ?? items[index - 1])?.id : scene.active;
	return {
		...rest,
		items,
		...next ? { active: next } : {}
	};
}
function activateItem(scene, id) {
	if (!scene.items.some((item) => item.id === id)) throw new Error(`There is no view "${id}" on this canvas.`);
	return {
		...scene,
		active: id
	};
}
/** Hands the wheel to `driver`, or frees it. */
function setDriver(scene, driver) {
	const { driver: _driver, ...rest } = scene;
	return driver ? {
		...rest,
		driver
	} : rest;
}
/** The canvas as an agent reads it: what each view shows, never pixels. */
function describeScene(scene, views) {
	return {
		driver: scene.driver ?? null,
		active: scene.active ?? null,
		views: scene.items.map((item) => {
			const view = views.get(item.type);
			return {
				id: item.id,
				type: item.type,
				...item.title ? { title: item.title } : {},
				shows: view ? view.describe(item.state) : "A view type this app does not have.",
				state: item.state
			};
		}),
		viewTypes: views.list().map((view) => view.type)
	};
}
//#endregion
//#region src/CanvasPanel.tsx
/** Applies each edit that still makes sense: a view it changed may be gone. */
var replay = (scene, edits) => edits.reduce((current, edit) => {
	try {
		return edit(current);
	} catch {
		return current;
	}
}, scene);
/** Set while this viewer looks around alone instead of following the driver:
* the scene they left, and what they have done to it since. One for all the
* tabs of a canvas, and never saved. */
function createRoaming() {
	let own;
	const listeners = /* @__PURE__ */ new Set();
	return {
		snapshot: () => own,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set(next) {
			own = typeof next === "function" ? next(own) : next;
			for (const listener of [...listeners]) listener();
		}
	};
}
var Wheel = () => /* @__PURE__ */ createElement("svg", {
	width: "16",
	height: "16",
	viewBox: "0 0 16 16",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: "1.5",
	strokeLinecap: "round",
	"aria-hidden": "true"
}, /* @__PURE__ */ createElement("circle", {
	cx: "8",
	cy: "8",
	r: "6.25"
}), /* @__PURE__ */ createElement("circle", {
	cx: "8",
	cy: "8",
	r: "1.5"
}), /* @__PURE__ */ createElement("path", { d: "M1.9 7h4.7M9.4 7h4.7M8 9.5v4.7" }));
var Eye = () => /* @__PURE__ */ createElement("svg", {
	width: "16",
	height: "16",
	viewBox: "0 0 16 16",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: "1.5",
	strokeLinejoin: "round",
	"aria-hidden": "true"
}, /* @__PURE__ */ createElement("path", { d: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" }), /* @__PURE__ */ createElement("circle", {
	cx: "8",
	cy: "8",
	r: "2"
}));
/** One view of a channel's canvas, in a tab of its own. The first view lives
* in the canvas's own tab (no `id`); the host opens a tab for each other one.
* Who drives and what each view shows is the shared scene; following is this
* viewer's own choice. */
function CanvasPanel({ channel, roaming, views, viewer, name, id, open, close, TabTitle }) {
	const shared = useSyncExternalStore(channel.subscribe, channel.snapshot);
	const types = useSyncExternalStore(views.subscribe, views.list);
	const own = useSyncExternalStore(roaming.subscribe, roaming.snapshot);
	const driver = shared.scene.driver;
	const driving = driver === viewer;
	const led = !!driver && !driving;
	useEffect(() => {
		if (own && !led) roaming.set(void 0);
	}, [
		own,
		led,
		roaming
	]);
	const alone = led && !!own;
	const following = led && !own;
	const scene = alone && own ? replay(own.base, own.edits) : shared.scene;
	const first = scene.items[0];
	const item = id ? scene.items.find((other) => other.id === id) : first;
	/** The tab a view is in. */
	const tabOf = (view) => view === first?.id ? void 0 : view;
	const change = async (update) => {
		if (following) return;
		if (alone) roaming.set((current) => current && {
			...current,
			edits: [...current.edits, update]
		});
		else await channel.change((latest) => latest.driver && latest.driver !== viewer ? latest : update(latest)).catch(() => {});
	};
	const root = useRef(null);
	const [shown, setShown] = useState(true);
	useEffect(() => {
		const check = () => setShown(!root.current?.closest("[data-covered]"));
		check();
		const observer = new MutationObserver(check);
		observer.observe(document.body, {
			subtree: true,
			attributes: true,
			attributeFilter: ["data-covered"]
		});
		return () => observer.disconnect();
	}, []);
	const now = {
		change,
		open,
		close,
		tabOf
	};
	const latest = useRef(now);
	latest.current = now;
	const mine = item?.id;
	useEffect(() => {
		if (shown && mine && (driving || alone)) latest.current.change((current) => current.active === mine ? current : activateItem(current, mine));
	}, [
		shown,
		mine,
		driving,
		alone
	]);
	const front = scene.active;
	const went = useRef(following ? void 0 : front);
	useEffect(() => {
		if (went.current === front) return;
		went.current = front;
		if (front && front !== mine && !driving && !alone) latest.current.open(latest.current.tabOf(front));
	}, [
		front,
		mine,
		driving,
		alone
	]);
	const gone = !!id && shared.status === "ready" && !item;
	const moved = !!id && item === first;
	useEffect(() => {
		if (!gone && !moved) return;
		if (moved && shown) latest.current.open();
		latest.current.close();
	}, [
		gone,
		moved,
		shown
	]);
	const buttons = useRef(null);
	useEffect(() => {
		const element = buttons.current;
		const canvas = root.current;
		if (!element || !canvas) return;
		const measure = () => canvas.style.setProperty("--buzz-canvas-room", `${element.offsetWidth}px`);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const plus = useRef(null);
	useEffect(() => {
		const element = plus.current;
		const canvas = root.current;
		if (!element || !canvas || !shown) return;
		let strip = null;
		for (let up = canvas.parentElement; up && !strip; up = up.parentElement) strip = up.querySelector("[role=\"tablist\"]");
		if (!strip) return;
		const place = () => {
			const end = (strip.lastElementChild ?? strip).getBoundingClientRect();
			const row = strip.getBoundingClientRect();
			element.style.position = "fixed";
			element.style.left = `${end.right + 4}px`;
			element.style.top = `${row.top + (row.height - element.offsetHeight) / 2}px`;
		};
		place();
		const resized = new ResizeObserver(place);
		resized.observe(strip);
		resized.observe(document.body);
		const changed = new MutationObserver(place);
		changed.observe(strip, {
			subtree: true,
			childList: true,
			characterData: true
		});
		window.addEventListener("resize", place);
		return () => {
			resized.disconnect();
			changed.disconnect();
			window.removeEventListener("resize", place);
			element.removeAttribute("style");
		};
	}, [shown]);
	const takeControl = () => {
		const edits = [...own?.edits ?? [], ...mine ? [(next) => activateItem(next, mine)] : []];
		channel.change((next) => setDriver(replay(next, edits), viewer)).catch(() => {});
	};
	const add = (type) => {
		const wanted = nextId(scene, type.type);
		change((current) => openItem(current, views, {
			type: type.type,
			state: type.initial,
			...current.items.some((other) => other.id === wanted) ? {} : { id: wanted }
		})).then(() => {
			if (first) latest.current.open(wanted);
		});
	};
	const titleOf = (view) => view.title ?? views.get(view.type)?.title ?? "Unknown view";
	const driverName = driver ? name(driver) : "";
	const status = driving ? "You are driving. Followers see what you see." : following ? `Following ${driverName}.` : alone ? `Looking around on your own. ${driverName} is driving.` : "Nobody is driving. Changes are shared with everyone.";
	const addable = types.filter((view) => view.initial !== void 0);
	const menu = [...scene.items.filter((other) => other !== item).map((other) => ({
		label: `Go to ${titleOf(other)}`,
		onSelect: () => open(tabOf(other.id))
	})), ...following ? [] : [...addable.map((type) => ({
		label: `New ${type.title.toLowerCase()}`,
		onSelect: () => add(type)
	})), ...item ? [{
		label: "Remove this view for everyone",
		onSelect: () => void change((current) => closeItem(current, item.id))
	}] : []]];
	const View = (item && views.get(item.type))?.component;
	return /* @__PURE__ */ createElement("section", {
		ref: root,
		className: styles.canvas,
		"aria-label": "Canvas"
	}, /* @__PURE__ */ createElement("p", {
		className: styles.quiet,
		role: "status"
	}, shared.status === "loading" ? "Loading the canvas…" : status), TabTitle && item && /* @__PURE__ */ createElement(TabTitle, { label: titleOf(item) }), /* @__PURE__ */ createElement("div", {
		ref: buttons,
		className: styles.buttons
	}, shown && menu.length > 0 && /* @__PURE__ */ createElement("span", {
		ref: plus,
		className: styles.plus
	}, /* @__PURE__ */ createElement(AddMenu, {
		label: "Views",
		items: menu
	})), led && /* @__PURE__ */ createElement(Button, {
		variant: following ? "outline" : "ghost",
		"aria-label": following ? "Stop following" : `Follow ${driverName}`,
		title: following ? `Following ${driverName}. Look around on your own` : `Follow ${driverName}`,
		onClick: () => roaming.set(following ? {
			base: shared.scene,
			edits: []
		} : void 0)
	}, /* @__PURE__ */ createElement(Eye, null)), /* @__PURE__ */ createElement(Button, {
		variant: driving ? "prominent" : "ghost",
		"aria-label": driving ? "Stop driving" : "Take control",
		title: driving ? "You are driving. Stop driving" : led ? `${driverName} is driving. Take control` : "Take control: others see what you see",
		disabled: shared.status === "loading",
		onClick: driving ? () => void change((current) => setDriver(current)) : takeControl
	}, /* @__PURE__ */ createElement(Wheel, null))), shared.error && /* @__PURE__ */ createElement("p", {
		className: styles.error,
		role: "alert"
	}, shared.error), item && View ? /* @__PURE__ */ createElement("div", {
		key: item.id,
		className: styles.view
	}, /* @__PURE__ */ createElement(View, {
		state: item.state,
		interactive: !following,
		update: (next) => void change((current) => updateItem(current, views, item.id, next))
	})) : /* @__PURE__ */ createElement("div", { className: styles.empty }, item ? /* @__PURE__ */ createElement(EmptyState, {
		title: "This view needs a plugin",
		description: `Nothing on this device can show a "${item.type}" view.`
	}) : /* @__PURE__ */ createElement(EmptyState, {
		title: "Nothing on the canvas yet",
		description: following ? `${driverName} hasn't opened anything.` : "Add a view, or ask an agent to open one. Everyone in this conversation sees it.",
		action: !following && addable.length ? /* @__PURE__ */ createElement("div", { className: styles.actions }, addable.map((type) => /* @__PURE__ */ createElement(Button, {
			key: type.type,
			onClick: () => add(type)
		}, type.title))) : void 0
	})));
}
//#endregion
//#region src/store.ts
/** A scene is one NIP-AR artifact in its channel, so the relay already owns
* who may read and write it, its revisions and its live delivery. */
var CANVAS_KIND = 45010;
var CANVAS_TYPE = "buzz.canvas";
var tag = (event, name) => event.tags.find((entry) => entry[0] === name)?.[1];
/** True for a revision of `channelId`'s canvas. */
var isSceneEvent = (event, channelId) => event.kind === 45010 && tag(event, "type") === "buzz.canvas" && tag(event, "d") === channelId && tag(event, "h") === channelId;
/** The relay's current revision. Never pick the newest timestamp locally. */
async function readScene(read, channelId, views, signal) {
	const events = await read([{
		kinds: [CANVAS_KIND],
		"#h": [channelId],
		"#d": [channelId],
		limit: 1,
		consistency: "strong"
	}], signal);
	signal?.throwIfAborted();
	const event = events.find((entry) => isSceneEvent(entry, channelId));
	if (!event) return { scene: EMPTY_SCENE };
	return {
		scene: tag(event, "op") === "delete" ? EMPTY_SCENE : parseScene(event.content, views) ?? EMPTY_SCENE,
		revision: event.id
	};
}
var SceneConflict = class extends Error {
	constructor() {
		super("The canvas changed while you were changing it.");
	}
};
async function saveScene(publish, channelId, base, scene, signal) {
	const template = {
		kind: CANVAS_KIND,
		content: serializeScene(scene),
		tags: [
			["ar", "1"],
			["d", channelId],
			["h", channelId],
			["type", CANVAS_TYPE],
			["title", "Canvas"],
			["op", base.revision ? "update" : "create"],
			...base.revision ? [["prev", base.revision]] : []
		]
	};
	try {
		return {
			scene,
			revision: (await publish(template, signal)).id
		};
	} catch (error) {
		if (error instanceof Error && /\bconflict:|duplicate/i.test(error.message)) throw new SceneConflict();
		throw error;
	}
}
function createCanvasChannel(options) {
	const { channelId, views, read, publish } = options;
	const lifetime = new AbortController();
	const listeners = /* @__PURE__ */ new Set();
	let saved = { scene: EMPTY_SCENE };
	let current = {
		status: "loading",
		scene: EMPTY_SCENE
	};
	let work = Promise.resolve();
	const set = (next) => {
		current = next;
		for (const listener of listeners) listener();
	};
	const message = (error) => error instanceof Error ? error.message : "The canvas is unavailable.";
	const refresh = async () => {
		saved = await readScene(read, channelId, views, lifetime.signal);
		set({
			status: "ready",
			scene: saved.scene
		});
	};
	/** Reads and saves run one at a time, so each save names the right `prev`. */
	const enqueue = (task) => {
		const run = work.then(task);
		work = run.catch(() => {});
		return run;
	};
	const reload = () => enqueue(refresh).catch((error) => {
		if (!lifetime.signal.aborted) set({
			...current,
			status: "error",
			error: message(error)
		});
	});
	const stop = options.follow((events) => {
		if (events.some((event) => isSceneEvent(event, channelId) && event.id !== saved.revision)) reload();
	});
	reload();
	return {
		snapshot: () => current,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		change: (update) => enqueue(async () => {
			for (let attempt = 0;; attempt++) {
				const scene = update(saved.scene);
				if (scene === saved.scene) return;
				set({
					status: "ready",
					scene
				});
				try {
					saved = await saveScene(publish, channelId, saved, scene, lifetime.signal);
					return;
				} catch (error) {
					if (lifetime.signal.aborted) throw error;
					await refresh().catch(() => {});
					if (error instanceof SceneConflict && attempt === 0) continue;
					set({
						...current,
						error: message(error)
					});
					throw error;
				}
			}
		}),
		dispose() {
			lifetime.abort();
			stop();
			listeners.clear();
		}
	};
}
//#endregion
//#region src/tools.ts
var string = (args, key) => {
	const value = args[key];
	if (typeof value !== "string" || !value) throw new Error(`${key} is required.`);
	return value;
};
/** The agent reads and saves the scene as itself, on its own connection, so
* the relay applies the agent's access to the channel, not its owner's. */
function canvasTools(views, show) {
	const read = (client) => (filters) => client.query(filters);
	const publish = (client) => (template) => client.publish(template);
	const channel = (context) => {
		if (!context.channel) throw new Error("There is no conversation here to hold a canvas.");
		return context.channel;
	};
	const report = (scene, note) => JSON.stringify({
		...describeScene(scene, views),
		...note && { note }
	});
	/** Applies `update` to the relay's current scene, once more on a conflict. */
	async function change(client, channelId, update, steering = false) {
		for (let attempt = 0;; attempt++) {
			const saved = await readScene(read(client), channelId, views);
			const { driver } = saved.scene;
			if (!steering && driver && driver !== client.pubkey) throw new Error("Someone else is driving this canvas. Call canvas_drive to take the wheel first, and only when asked to.");
			try {
				client.signal?.throwIfAborted();
				return (await saveScene(publish(client), channelId, saved, update(saved.scene))).scene;
			} catch (error) {
				if (!(error instanceof SceneConflict) || attempt) throw error;
			}
		}
	}
	const tool = (name, description, properties, required, call) => ({
		name,
		description,
		inputSchema: {
			type: "object",
			properties,
			required,
			additionalProperties: false
		},
		call
	});
	const str = { type: "string" };
	return [
		tool("canvas_read", "Read this conversation's canvas: the views on it, what each shows, which is in front, who is driving and the view types you can open. You never see pixels, only this description.", {}, [], async (client, context) => report((await readScene(read(client), channel(context), views)).scene)),
		tool("canvas_open", "Open a view on this conversation's canvas and bring it to the front, for everyone following. Reusing an id replaces that view. Shows the canvas beside the conversation when your owner is viewing it.", {
			type: {
				...str,
				description: "A view type from canvas_read's viewTypes."
			},
			state: {
				type: "object",
				description: "What the view shows; its shape belongs to the view type. Copy it from a view of that type in canvas_read."
			},
			title: {
				...str,
				description: "The view's tab name."
			},
			id: {
				...str,
				description: "Omit for a new view."
			}
		}, ["type", "state"], async (client, context, args) => {
			const id = channel(context);
			const scene = await change(client, id, (current) => openItem(current, views, {
				type: string(args, "type"),
				state: args.state,
				...typeof args.title === "string" && { title: args.title },
				...typeof args.id === "string" && { id: args.id }
			}));
			return report(scene, show(id, context.root, scene.active === scene.items[0]?.id ? void 0 : scene.active) ? "Shown beside the conversation." : "Saved. Your owner is not viewing this conversation in the desktop app now.");
		}),
		tool("canvas_update", "Change what one view on the canvas shows, such as its address or position, for everyone following.", {
			id: str,
			state: { type: "object" }
		}, ["id", "state"], async (client, context, args) => report(await change(client, channel(context), (current) => updateItem(current, views, string(args, "id"), args.state)))),
		tool("canvas_close", "Close one view on the canvas.", { id: str }, ["id"], async (client, context, args) => report(await change(client, channel(context), (current) => closeItem(current, string(args, "id"))))),
		tool("canvas_drive", "Take the wheel of the canvas, so people following see what you open, or hand it back. Taking it from a person interrupts them: do it only when asked.", { drive: { type: "boolean" } }, ["drive"], async (client, context, args) => report(await change(client, channel(context), (current) => args.drive === true ? setDriver(current, client.pubkey) : current.driver === client.pubkey ? setDriver(current) : current, true)))
	];
}
//#endregion
//#region src/view.ts
/** The layer under the canvas: any plugin can add a view type to it. */
function createCanvasViews() {
	let views = [];
	const listeners = /* @__PURE__ */ new Set();
	const set = (next) => {
		views = next;
		for (const listener of listeners) listener();
	};
	return {
		register(view) {
			if (!/^[a-z][a-z0-9-]{0,31}$/.test(view.type) || !view.title.trim() || typeof view.parse !== "function" || typeof view.describe !== "function" || typeof view.component !== "function") throw new Error("A canvas view needs a type, title, parse, describe and component");
			if (views.some((other) => other.type === view.type)) throw new Error(`Canvas view "${view.type}" is already registered`);
			const entry = view;
			set([...views, entry]);
			return () => set(views.filter((other) => other !== entry));
		},
		get: (type) => views.find((view) => view.type === type),
		list: () => views,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}
//#endregion
//#region src/views/map.tsx
var TILE = 256;
var MAX_ZOOM = 19;
var MAX_MARKERS = 200;
/** The furthest north and south a Web Mercator map reaches. */
var MAX_LAT = 85.0511;
var point = (input) => Array.isArray(input) && input.length === 2 && input.every((value) => typeof value === "number" && Number.isFinite(value)) && Math.abs(input[0]) <= 180 && Math.abs(input[1]) <= 90 ? [input[0], input[1]] : void 0;
function parse$2(input) {
	const value = input;
	const center = point(value?.center);
	const zoom = value?.zoom;
	if (!center || typeof zoom !== "number" || !(zoom >= 0 && zoom <= MAX_ZOOM) || value?.markers !== void 0 && !Array.isArray(value.markers)) return;
	const markers = [];
	for (const entry of value?.markers ?? []) {
		const marker = entry;
		const coordinates = point(marker?.coordinates);
		if (!coordinates || markers.length >= MAX_MARKERS) return;
		markers.push({
			coordinates,
			...typeof marker?.label === "string" && marker.label.trim() ? { label: marker.label.trim().slice(0, 200) } : {}
		});
	}
	return {
		center,
		zoom: Math.round(zoom),
		markers
	};
}
/** Web Mercator: a place's position in pixels on the whole world at `zoom`. */
var project = ([lng, lat], zoom) => {
	const size = TILE * 2 ** zoom;
	const sin = Math.sin(Math.max(-85.0511, Math.min(MAX_LAT, lat)) * Math.PI / 180);
	return {
		x: (lng + 180) / 360 * size,
		y: (.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size
	};
};
var unproject = (x, y, zoom) => {
	const size = TILE * 2 ** zoom;
	const lng = x / size * 360 - 180;
	const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI;
	return [Math.max(-180, Math.min(180, lng)), Math.max(-85.0511, Math.min(MAX_LAT, lat))];
};
function MapView({ state, interactive, update, tiles }) {
	const frame = useRef(null);
	const [size, setSize] = useState({
		width: 0,
		height: 0
	});
	useEffect(() => {
		const node = frame.current;
		if (!node) return;
		const measure = () => setSize({
			width: node.clientWidth,
			height: node.clientHeight
		});
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	const [drag, setDrag] = useState();
	const { zoom } = state;
	const origin = project(state.center, zoom);
	const centerX = origin.x - (drag ? drag.x - drag.startX : 0);
	const centerY = origin.y - (drag ? drag.y - drag.startY : 0);
	const left = centerX - size.width / 2;
	const top = centerY - size.height / 2;
	const count = 2 ** zoom;
	const images = [];
	if (size.width && size.height) for (let row = Math.max(0, Math.floor(top / TILE)); row <= Math.min(count - 1, Math.floor((top + size.height) / TILE)); row++) for (let column = Math.floor(left / TILE); column <= Math.floor((left + size.width) / TILE); column++) {
		const wrapped = (column % count + count) % count;
		images.push(/* @__PURE__ */ createElement("img", {
			key: `${zoom}/${column}/${row}`,
			className: styles.tile,
			alt: "",
			draggable: false,
			src: tiles.replace("{z}", String(zoom)).replace("{x}", String(wrapped)).replace("{y}", String(row)),
			style: {
				left: column * TILE - left,
				top: row * TILE - top
			}
		}));
	}
	const release = (event) => {
		if (!drag) return;
		setDrag(void 0);
		if (event.type === "pointerup" && (centerX !== origin.x || centerY !== origin.y)) update({
			...state,
			center: unproject(centerX, centerY, zoom)
		});
	};
	const zoomTo = (next) => update({
		...state,
		zoom: Math.max(0, Math.min(MAX_ZOOM, next))
	});
	return /* @__PURE__ */ createElement("div", { className: styles.fill }, /* @__PURE__ */ createElement("div", {
		ref: frame,
		className: styles.map,
		role: "application",
		"aria-label": "Map",
		"data-dragging": drag ? "" : void 0,
		onPointerDown: (event) => {
			if (!interactive || event.button !== 0) return;
			event.currentTarget.setPointerCapture(event.pointerId);
			setDrag({
				startX: event.clientX,
				startY: event.clientY,
				x: event.clientX,
				y: event.clientY
			});
		},
		onPointerMove: (event) => setDrag((current) => current && {
			...current,
			x: event.clientX,
			y: event.clientY
		}),
		onPointerUp: release,
		onPointerCancel: release
	}, images, state.markers.map((marker, index) => {
		const at = project(marker.coordinates, zoom);
		return /* @__PURE__ */ createElement("div", {
			key: index,
			className: styles.pin,
			style: {
				left: at.x - left,
				top: at.y - top
			}
		}, marker.label && /* @__PURE__ */ createElement("span", { className: styles.pinLabel }, marker.label), /* @__PURE__ */ createElement("span", { className: styles.pinDot }));
	}), interactive && /* @__PURE__ */ createElement("div", {
		className: styles.mapControls,
		onPointerDown: (event) => event.stopPropagation()
	}, /* @__PURE__ */ createElement(Button, {
		"aria-label": "Zoom in",
		disabled: zoom >= MAX_ZOOM,
		onClick: () => zoomTo(zoom + 1)
	}, "+"), /* @__PURE__ */ createElement(Button, {
		"aria-label": "Zoom out",
		disabled: zoom <= 0,
		onClick: () => zoomTo(zoom - 1)
	}, "−")), /* @__PURE__ */ createElement("span", { className: styles.credit }, "© OpenStreetMap contributors")));
}
var place = ([lng, lat]) => `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
/** A map drawn from raster tiles, with no map library or API key. `tiles` is a
* `{z}/{x}/{y}` address template. */
var mapView = (tiles = "https://tile.openstreetmap.org/{z}/{x}/{y}.png") => ({
	type: "map",
	title: "Map",
	initial: {
		center: [0, 20],
		zoom: 2,
		markers: []
	},
	parse: parse$2,
	describe: (state) => `A map centred on ${place(state.center)} at zoom ${state.zoom}${state.markers.length ? `, with ${state.markers.length} marker${state.markers.length === 1 ? "" : "s"}: ${state.markers.slice(0, 20).map((marker) => marker.label ?? place(marker.coordinates)).join("; ")}` : ""}.`,
	component: (props) => /* @__PURE__ */ createElement(MapView, {
		...props,
		tiles
	})
});
//#endregion
//#region src/views/page.tsx
/** An http(s) address, or "" for a view nobody has pointed anywhere yet. */
var pageUrl = (input) => {
	if (input === "") return "";
	if (typeof input !== "string" || input.length > 2048) return;
	try {
		const url = new URL(input);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : void 0;
	} catch {
		return;
	}
};
var parse$1 = (input) => {
	const url = pageUrl(input?.url);
	return url === void 0 ? void 0 : { url };
};
/** Where the viewer types the address everyone following is taken to. */
function AddressBar({ url, label, go }) {
	const [draft, setDraft] = useState(url);
	const [shown, setShown] = useState(url);
	if (shown !== url) {
		setShown(url);
		setDraft(url);
	}
	const [invalid, setInvalid] = useState(false);
	const submit = (event) => {
		event.preventDefault();
		const typed = draft.trim();
		const next = pageUrl(/^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`);
		setInvalid(!next);
		if (next) go(next);
	};
	return /* @__PURE__ */ createElement("form", {
		className: styles.address,
		onSubmit: submit
	}, /* @__PURE__ */ createElement(Input, {
		"aria-label": label,
		invalid,
		placeholder: "https://",
		value: draft,
		onValueChange: setDraft
	}));
}
/** How long after a page is opened for this viewer its address changes count
* as the site redirecting, not as the viewer going somewhere. */
var SETTLE = 4e3;
/** The host's own browser view, with its own back, forward and address bar.
* It doesn't say where its page goes, so this reads the address it shows:
* where the viewer goes inside the page is then shared like any other change.
* That reaches into the host's markup and can break with it; the page still
* shows if it does, but only the address it was opened at is shared. */
function HostPage({ View, state, interactive, update }) {
	const frame = useRef(null);
	const [guest, setGuest] = useState({
		url: state.url,
		opened: 0
	});
	const seen = useRef(state.url);
	const quietUntil = useRef(Date.now() + SETTLE);
	const typing = useRef(false);
	const share = useRef({
		interactive,
		update
	});
	share.current = {
		interactive,
		update
	};
	useEffect(() => {
		if (state.url === seen.current) return;
		seen.current = state.url;
		quietUntil.current = Date.now() + SETTLE;
		setGuest((was) => ({
			url: state.url,
			opened: was.opened + 1
		}));
	}, [state.url]);
	useEffect(() => {
		const view = frame.current;
		const typed = () => {
			typing.current = true;
		};
		const left = () => {
			typing.current = false;
		};
		const entered = () => {
			typing.current = false;
			quietUntil.current = 0;
		};
		view?.addEventListener("input", typed);
		view?.addEventListener("focusout", left);
		view?.addEventListener("submit", entered);
		const timer = setInterval(() => {
			const address = frame.current?.querySelector("input[aria-label=\"Address\"]");
			const url = address && !typing.current && pageUrl(address.value);
			if (!url || url === seen.current) return;
			seen.current = url;
			if (share.current.interactive && Date.now() >= quietUntil.current) share.current.update({ url });
		}, 500);
		return () => {
			clearInterval(timer);
			view?.removeEventListener("input", typed);
			view?.removeEventListener("focusout", left);
			view?.removeEventListener("submit", entered);
		};
	}, []);
	return /* @__PURE__ */ createElement("div", {
		ref: frame,
		className: styles.fill
	}, /* @__PURE__ */ createElement(View, {
		key: guest.opened,
		url: guest.url,
		storage: "canvas"
	}));
}
function Page({ state, interactive, update, browser, addressable }) {
	const [Native] = useState(() => browser?.available ? browser.View : void 0);
	if (Native && state.url) return /* @__PURE__ */ createElement(HostPage, {
		View: Native,
		state,
		interactive,
		update
	});
	return /* @__PURE__ */ createElement("div", { className: styles.fill }, addressable && interactive && /* @__PURE__ */ createElement(AddressBar, {
		url: state.url,
		label: "Shared address",
		go: (url) => update({ url })
	}), !state.url ? /* @__PURE__ */ createElement("p", { className: styles.hint }, interactive ? "Enter an address to show a page here." : "No page is open here yet.") : /* @__PURE__ */ createElement("iframe", {
		className: styles.frame,
		title: state.url,
		src: state.url,
		sandbox: "allow-scripts allow-same-origin allow-forms allow-popups",
		referrerPolicy: "no-referrer"
	}));
}
/** A page people can point somewhere else. Uses the host's own browser view
* where the platform has one, and a frame elsewhere. */
var browserView = (browser) => ({
	type: "browser",
	title: "Browser",
	initial: { url: "" },
	parse: parse$1,
	describe: (state) => state.url ? `The web page ${state.url}` : "An empty browser.",
	component: (props) => /* @__PURE__ */ createElement(Page, {
		...props,
		browser,
		addressable: true
	})
});
/** One embedded page with no controls, such as a dashboard or a prototype. */
var webView = {
	type: "web",
	title: "Web view",
	parse: (input) => {
		const state = parse$1(input);
		return state?.url ? state : void 0;
	},
	describe: (state) => `The embedded page ${state.url}`,
	component: (props) => /* @__PURE__ */ createElement(Page, {
		...props,
		addressable: false
	})
};
//#endregion
//#region src/views/video.tsx
/** How far apart, in seconds, two players may drift before one is moved. */
var DRIFT = 1.5;
function parse(input) {
	const value = input;
	const url = pageUrl(value?.url);
	const time = value?.time ?? 0;
	if (url === void 0 || typeof time !== "number" || !(time >= 0 && time <= 86400) || value?.at !== void 0 && !(typeof value.at === "number" && Number.isFinite(value.at))) return;
	return {
		url,
		time,
		playing: value?.playing === true,
		...typeof value?.at === "number" ? { at: value.at } : {}
	};
}
/** Where a video is now: it has kept playing since its state was saved. This
* trusts both people's clocks to agree to within the allowed drift. */
var positionNow = (state, now = Date.now()) => state.playing && state.at !== void 0 ? state.time + Math.max(0, now - state.at) / 1e3 : state.time;
function Video({ state, interactive, update }) {
	const player = useRef(null);
	const applying = useRef(false);
	const { url, time, playing, at } = state;
	useEffect(() => {
		const video = player.current;
		if (!video || !url) return;
		applying.current = true;
		const target = positionNow({
			time,
			playing,
			at
		});
		if (Math.abs(video.currentTime - target) > DRIFT) video.currentTime = target;
		if (playing) video.play().catch(() => {});
		else video.pause();
		const done = setTimeout(() => {
			applying.current = false;
		}, 250);
		return () => clearTimeout(done);
	}, [
		url,
		time,
		playing,
		at
	]);
	const report = () => {
		const video = player.current;
		if (!video || !interactive || applying.current) return;
		const next = {
			url,
			time: video.currentTime,
			playing: !video.paused,
			at: Date.now()
		};
		if (next.playing !== playing || Math.abs(next.time - positionNow(state)) > DRIFT) update(next);
	};
	return /* @__PURE__ */ createElement("div", { className: styles.fill }, interactive && /* @__PURE__ */ createElement(AddressBar, {
		url,
		label: "Video address",
		go: (next) => update({
			url: next,
			time: 0,
			playing: false
		})
	}), url ? /* @__PURE__ */ createElement("video", {
		ref: player,
		className: styles.video,
		src: url,
		controls: interactive,
		playsInline: true,
		onPlay: report,
		onPause: report,
		onSeeked: report
	}) : /* @__PURE__ */ createElement("p", { className: styles.hint }, interactive ? "Enter the address of a video file to watch it together." : "No video is open here yet."));
}
var clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
/** A video file everyone watches together: play, pause and seek are shared. */
var videoView = {
	type: "video",
	title: "Video",
	initial: {
		url: "",
		time: 0,
		playing: false
	},
	parse,
	describe: (state) => state.url ? `The video ${state.url}, ${state.playing ? "playing" : "paused"} at ${clock(positionNow(state))}.` : "An empty video player.",
	component: Video
};
//#endregion
//#region src/index.tsx
/** What a link or an agent opens to show a conversation's canvas, followed by
* a view's id for that view's own tab. */
var CANVAS_TARGET = "buzz-canvas:";
var still = () => () => {};
var inject = [
	"react",
	"panels",
	"relay",
	"agents",
	"browser"
];
function apply(ctx) {
	useHost(ctx.react);
	useHostUi(ctx.reflect.get("ui"));
	ctx.effect(() => {
		const sheet = document.createElement("style");
		sheet.textContent = css;
		document.head.append(sheet);
		return () => sheet.remove();
	});
	const views = createCanvasViews();
	ctx.provide?.("canvasViews", views);
	views.register(browserView(ctx.browser));
	views.register(webView);
	views.register(mapView());
	views.register(videoView);
	const rooms = /* @__PURE__ */ new Map();
	const useTabTitle = ctx.panels.useTabTitle;
	const TabTitle = useTabTitle && (({ label }) => {
		useTabTitle(label);
		return null;
	});
	function Live({ room: key, session, viewer, channelId, view, close }) {
		const room = useMemo(() => {
			const open = rooms.get(key);
			if (open) return open;
			const made = {
				users: 0,
				roaming: createRoaming(),
				channel: createCanvasChannel({
					channelId,
					views,
					read: async (filters, signal) => {
						if (!session.snapshotRead) throw new Error("Connect to your community to use the canvas.");
						return session.snapshotRead(filters, signal ? { signal } : {});
					},
					publish: async (template, signal) => {
						const writer = session.configArtifactWriter;
						if (!writer) throw new Error("This community can't save a canvas yet.");
						const event = await writer.sign({
							...template,
							created_at: Math.floor(Date.now() / 1e3)
						}, signal ?? session.lifetimeSignal);
						await writer.publish(event, signal ?? session.lifetimeSignal);
						return event;
					},
					follow: (listener) => session.artifacts.follow([channelId], listener)
				})
			};
			rooms.set(key, made);
			return made;
		}, [
			key,
			session,
			channelId
		]);
		useEffect(() => {
			room.users += 1;
			return () => {
				room.users -= 1;
				setTimeout(() => {
					if (room.users || rooms.get(key) !== room) return;
					rooms.delete(key);
					room.channel.dispose();
				});
			};
		}, [room, key]);
		useSyncExternalStore(session.names?.subscribe ?? still, () => session.names?.snapshot() ?? 0);
		return /* @__PURE__ */ createElement(CanvasPanel, {
			channel: room.channel,
			roaming: room.roaming,
			views,
			viewer,
			id: view,
			open: (next) => void ctx.panels.requestOpen({
				target: CANVAS_TARGET + (next ?? ""),
				channelId
			}),
			close,
			TabTitle,
			name: (pubkey) => {
				const short = `${pubkey.slice(0, 8)}…`;
				return session.names?.resolve(pubkey, short) ?? short;
			}
		});
	}
	function Panel({ channelContext, context, target, close }) {
		const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
		const channelId = channelContext?.channelId ?? context?.channelId;
		if (!channelId || state.status !== "ready" || !state.viewer || channelContext && state.scope !== channelContext.scope) return /* @__PURE__ */ createElement("p", { role: "status" }, "The canvas is unavailable while the connection recovers.");
		return /* @__PURE__ */ createElement(Live, {
			key: `${state.scope}:${state.generation}:${channelId}`,
			room: `${state.scope}:${state.generation}:${channelId}`,
			session: state.session,
			viewer: state.viewer,
			channelId,
			view: target?.slice(12) || void 0,
			close: close ?? still
		});
	}
	ctx.panels.register({
		id: "canvas",
		title: "Canvas",
		inline: false,
		keepOpen: true,
		channelPlacement: "tab",
		matches: (target) => /^[a-z0-9._-]{0,64}$/.test(target.startsWith(CANVAS_TARGET) ? target.slice(12) : "/"),
		channelMenu: {
			label: "Share a view",
			eligible: (channel, session) => !channel.cached && !channel.archived && !!channel.members?.includes(session.viewer ?? "")
		},
		component: Panel
	});
	for (const tool of canvasTools(views, (channelId, rootId, view) => ctx.panels.requestOpen({
		target: CANVAS_TARGET + (view ?? ""),
		channelId,
		...rootId ? { rootId } : {}
	}))) ctx.agents.addTool(tool);
	ctx.agents.addInstructions({
		id: "canvas",
		text: "To show people a web page, map or video beside the conversation, open it on the canvas with canvas_open; call canvas_read first for the view types and their state."
	});
}
//#endregion
export { apply, inject };
