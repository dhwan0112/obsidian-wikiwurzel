import {
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import { quadtree, type Quadtree } from "d3-quadtree";
import { ItemView, Keymap, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { T } from "./i18n";
import type Wikiwurzel from "./main";
import { nameOf } from "./store";
import { tagLabel } from "./graph";
import { parseQuery } from "./ui";

export const GLOBAL_GRAPH_VIEW = "wikiwurzel-graph";

/* ---------- Data ---------- */

interface GNode extends SimulationNodeDatum {
	id: string;
	kind: "note" | "file" | "tag";
	/** File path, or the tag itself. */
	target: string;
	label: string;
	degree: number;
	color: string | null;
	r: number;
}

interface GLink extends SimulationLinkDatum<GNode> {
	source: GNode;
	target: GNode;
	kind: "tag" | "link" | "parent";
}

export interface GlobalOptions {
	showTags: boolean;
	showOrphans: boolean;
	showLinks: boolean;
	/** Connect every file to every tag it carries instead of only its nearest ones. */
	denseTags: boolean;
	extensions: Set<string>;
	filter: string;
	/** Tags carried by fewer files than this are left out; they group nothing. */
	minTagFiles: number;
}

interface ColorGroup {
	query: string;
	color: string;
}

/** Colour groups in the core graph's format; "path:" and "tag:" queries are understood. */
function groupMatcher(groups: ColorGroup[]) {
	const rules = groups
		.map((g) => {
			const q = g.query.trim();
			const path = /^path:\s*"?([^"]*)"?$/i.exec(q);
			if (path) {
				const prefix = path[1].replace(/^\/+/, "");
				return { color: g.color, test: (n: GNode) => n.kind !== "tag" && n.target.startsWith(prefix) };
			}
			const tag = /^tag:\s*#?(\S+)$/i.exec(q);
			if (tag) {
				const want = tag[1].toLowerCase();
				return { color: g.color, test: (n: GNode, tags: string[]) => tags.some((t) => t.toLowerCase() === want) };
			}
			return null;
		})
		.filter((r): r is { color: string; test: (n: GNode, tags: string[]) => boolean } => r !== null);
	return (n: GNode, tags: string[]) => rules.find((r) => r.test(n, tags))?.color ?? null;
}

/* ---------- View ---------- */

export class GlobalGraphView extends ItemView {
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;
	private nodes: GNode[] = [];
	private links: GLink[] = [];
	private neighbours = new Map<GNode, Set<GNode>>();
	private sim: Simulation<GNode, GLink> | null = null;
	private tree: Quadtree<GNode> | null = null;
	private frame = 0;
	private zoom = { x: 0, y: 0, k: 0.5 };
	private hover: GNode | null = null;
	private dragging: GNode | null = null;
	private panning: { x: number; y: number; zx: number; zy: number } | null = null;
	private moved = false;
	private resizeObserver: ResizeObserver | null = null;
	private colors = { note: "#888", file: "#d4a72c", tag: "#3fa34d", line: "#555", text: "#ddd", tagText: "#aaa", accent: "#7c5cff", bg: "#1e1e1e" };
	/** Canvas cannot read CSS variables, so the interface font is resolved once. */
	private font = "sans-serif";
	private filterInput!: HTMLInputElement;
	private statusEl!: HTMLElement;
	/** Saved positions from the last session, used for nodes seen for the first time in this one. */
	private saved: Map<string, [number, number]> | null = null;
	private settledOnce = false;

	constructor(leaf: WorkspaceLeaf, private plugin: Wikiwurzel) {
		super(leaf);
	}

	getViewType() {
		return GLOBAL_GRAPH_VIEW;
	}
	getDisplayText() {
		return T.globalTitle();
	}
	getIcon() {
		return "waypoints";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("ww-global");
		this.canvas = root.createEl("canvas", { cls: "ww-global-canvas" });
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		this.ctx = ctx;
		this.buildControls(root);
		this.bindPointer();
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(root);
		this.readColors();
		const layout = await this.plugin.loadLayout();
		if (layout) {
			this.saved = new Map(Object.entries(layout.positions));
			this.zoom = layout.zoom;
		}
		this.rebuild();
	}

	async onClose() {
		this.savePositions();
		this.stop();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	onResize() {
		this.resize();
	}

	/* ----- Controls ----- */

	private buildControls(root: HTMLElement) {
		const s = this.plugin.settings;
		const panel = root.createDiv({ cls: "ww-global-controls" });
		panel.toggleClass("is-collapsed", s.globalControlsCollapsed);

		// Header: always visible; click it to fold the rest away.
		const head = panel.createDiv({ cls: "ww-global-head" });
		const fold = head.createSpan({
			cls: "ww-graph-button ww-global-fold",
			attr: { role: "button", "aria-label": T.globalFold(), "aria-expanded": String(!s.globalControlsCollapsed) },
		});
		setIcon(fold, s.globalControlsCollapsed ? "chevron-right" : "chevron-down");
		this.statusEl = head.createSpan({ cls: "ww-global-status" });
		const fit = head.createSpan({ cls: "ww-graph-button", attr: { "aria-label": T.graphFit(), role: "button" } });
		setIcon(fit, "maximize");
		fit.addEventListener("click", () => this.fit());
		const again = head.createSpan({ cls: "ww-graph-button", attr: { "aria-label": T.globalRelayout(), role: "button" } });
		setIcon(again, "refresh-cw");
		again.addEventListener("click", () => this.rebuild(true));
		const toggleFold = () => {
			const collapsed = !this.plugin.settings.globalControlsCollapsed;
			this.plugin.settings.globalControlsCollapsed = collapsed;
			void this.plugin.saveSettingsQuietly();
			panel.toggleClass("is-collapsed", collapsed);
			fold.setAttr("aria-expanded", String(!collapsed));
			setIcon(fold, collapsed ? "chevron-right" : "chevron-down");
		};
		fold.addEventListener("click", toggleFold);
		this.statusEl.addEventListener("click", toggleFold);

		const body = panel.createDiv({ cls: "ww-global-body" });
		this.filterInput = body.createEl("input", {
			cls: "ww-global-filter",
			attr: { type: "search", placeholder: T.globalFilter(), value: s.globalFilter },
		});
		const refilter = debounce(() => {
			this.plugin.settings.globalFilter = this.filterInput.value;
			void this.plugin.saveSettingsQuietly();
			this.rebuild();
		}, 300, true);
		this.filterInput.addEventListener("input", refilter);

		const toggles: [keyof typeof s, string, boolean][] = [
			["globalShowTags", T.globalTags(), true],
			["globalShowOrphans", T.globalOrphans(), true],
			["globalShowLinks", T.globalLinks(), true],
			["globalArrows", T.globalArrows(), false],
			["globalDenseTags", T.globalDense(), true],
		];
		for (const [key, label, rebuilds] of toggles) {
			const row = body.createEl("label", { cls: "ww-global-toggle" });
			const box = row.createEl("input", { attr: { type: "checkbox" } });
			box.checked = Boolean(s[key]);
			row.createSpan({ text: label });
			box.addEventListener("change", () => {
				(this.plugin.settings as unknown as Record<string, unknown>)[key] = box.checked;
				void this.plugin.saveSettingsQuietly();
				if (rebuilds) this.rebuild();
				else this.kick();
			});
		}

		// Forces, applied live.
		const forces = body.createDiv({ cls: "ww-global-forces" });
		const sliders: [keyof typeof s, string, number, number][] = [
			["globalRepel", T.forceRepel(), 0.2, 4],
			["globalGravity", T.forceCenter(), 0, 4],
			["globalLinkDistance", T.forceDistance(), 0.3, 4],
		];
		for (const [key, label, min, max] of sliders) {
			const row = forces.createDiv({ cls: "ww-global-slider" });
			row.createSpan({ text: label });
			const input = row.createEl("input", {
				attr: { type: "range", min: String(min), max: String(max), step: "0.1", "aria-label": label },
			});
			input.value = String(s[key]);
			input.addEventListener("input", () => {
				(this.plugin.settings as unknown as Record<string, unknown>)[key] = Number(input.value);
				this.applyForces();
				this.kick(0.5);
			});
			input.addEventListener("change", () => void this.plugin.saveSettingsQuietly());
		}
	}

	/** Pick up the theme's graph colours so the graph matches the core one. */
	private readColors() {
		const style = this.containerEl.win.getComputedStyle(this.containerEl);
		const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
		this.colors = {
			note: v("--graph-node", v("--text-muted", "#888")),
			file: v("--graph-node-attachment", v("--color-yellow", "#d4a72c")),
			tag: v("--graph-node-tag", v("--color-green", "#3fa34d")),
			line: v("--graph-line", v("--background-modifier-border-hover", "#555")),
			text: v("--graph-text", v("--text-normal", "#ddd")),
			tagText: v("--text-muted", "#aaa"),
			accent: v("--graph-node-focused", v("--interactive-accent", "#7c5cff")),
			bg: v("--graph-background", v("--background-primary", "#1e1e1e")),
		};
		// Keep only well-formed family names; one bad entry makes the canvas ignore the whole font.
		const families = (v("--font-interface", "") || style.fontFamily || "")
			.split(",")
			.map((f) => f.replace(/\s+/g, " ").trim())
			.filter((f) => f.length > 0 && /^("[^"?]+"|'[^'?]+'|[\w -]+)$/.test(f));
		this.font = families.length > 0 ? families.join(", ") : "sans-serif";
	}

	/* ----- Building the graph ----- */

	options(): GlobalOptions {
		const s = this.plugin.settings;
		return {
			showTags: s.globalShowTags,
			showOrphans: s.globalShowOrphans,
			showLinks: s.globalShowLinks,
			denseTags: s.globalDenseTags,
			extensions: new Set(
				s.globalExtensions
					.split(",")
					.map((e) => e.trim().replace(/^\./, "").toLowerCase())
					.filter((e) => e.length > 0),
			),
			filter: this.filterInput?.value ?? s.globalFilter,
			minTagFiles: s.globalMinTagFiles,
		};
	}

	/** (Re)build nodes and edges from the vault; keeps positions of nodes that stay. */
	rebuild(fresh = false) {
		const o = this.options();
		const store = this.plugin.store;
		const old = new Map(this.nodes.map((n) => [n.id, n]));
		const nodes = new Map<string, GNode>();
		const links: GLink[] = [];
		const q = parseQuery(o.filter);
		const matcher = groupMatcher(this.plugin.colorGroups());
		const colourGroups = this.plugin.settings.globalColorGroups;

		const fileOk = (f: TFile) => o.extensions.size === 0 || o.extensions.has(f.extension.toLowerCase());
		const files = this.app.vault.getFiles().filter(fileOk);
		const tagsOf = new Map<string, string[]>();
		const shown = new Set<string>();
		for (const f of files) {
			const tags = store.allTagsOf(f.path);
			if (q.include.length || q.exclude.length || q.words.length || q.notWords.length) {
				const has = (want: string) => tags.some((t) => t.toLowerCase() === want || t.toLowerCase().startsWith(want + "/"));
				const path = f.path.toLowerCase();
				if (!q.include.every(has) || q.exclude.some(has)) continue;
				if (!q.words.every((w) => path.includes(w)) || q.notWords.some((w) => path.includes(w))) continue;
			}
			tagsOf.set(f.path, tags);
			shown.add(f.path);
		}

		const nodeOf = (id: string, make: () => GNode) => {
			let n = nodes.get(id);
			if (!n) {
				n = make();
				const prev = fresh ? undefined : old.get(id);
				const stored = fresh ? undefined : this.saved?.get(id);
				if (prev) {
					n.x = prev.x;
					n.y = prev.y;
				} else if (stored) {
					n.x = stored[0];
					n.y = stored[1];
				}
				nodes.set(id, n);
			}
			return n;
		};
		const fileNode = (path: string) =>
			nodeOf("f:" + path, () => {
				const name = nameOf(path);
				return {
					id: "f:" + path,
					kind: path.endsWith(".md") ? "note" : "file",
					target: path,
					label: name.endsWith(".md") ? name.slice(0, -3) : name,
					degree: 0,
					color: null,
					r: 3,
				};
			});
		const tagNode = (tag: string) =>
			nodeOf("t:" + tag.toLowerCase(), () => ({
				id: "t:" + tag.toLowerCase(),
				kind: "tag",
				target: tag,
				label: tagLabel(tag),
				degree: 0,
				color: null,
				r: 4,
			}));
		const seen = new Set<string>();
		const link = (a: GNode, b: GNode, kind: GLink["kind"]) => {
			if (a === b) return;
			const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
			if (seen.has(key)) return;
			seen.add(key);
			links.push({ source: a, target: b, kind });
		};

		for (const path of shown) fileNode(path);

		if (o.showTags) {
			const sizes = new Map([...store.index()].map(([t, paths]) => [t.toLowerCase(), paths.length]));
			const big = (tag: string) => (sizes.get(tag.toLowerCase()) ?? 0) >= o.minTagFiles;
			for (const path of shown) {
				const tags = o.denseTags ? (tagsOf.get(path) ?? []) : store.directTagsOf(path);
				for (const tag of tags) if (big(tag)) link(fileNode(path), tagNode(tag), "tag");
			}
			// Narrower folder tags hang off broader ones: CM2112 -> Chemistry -> NUS.
			if (!o.denseTags) {
				for (const [child, parent] of store.tagParents()) {
					const a = nodes.get("t:" + child.toLowerCase());
					if (!a || !big(parent)) continue;
					link(a, tagNode(parent), "parent");
				}
			}
		}
		if (o.showLinks) {
			const resolved = this.app.metadataCache.resolvedLinks;
			for (const source in resolved) {
				if (!shown.has(source)) continue;
				for (const target in resolved[source]) {
					if (shown.has(target)) link(fileNode(source), fileNode(target), "link");
				}
			}
		}

		for (const l of links) {
			l.source.degree++;
			l.target.degree++;
		}
		let list = [...nodes.values()];
		if (!o.showOrphans) list = list.filter((n) => n.degree > 0);
		const keep = new Set(list);
		this.links = links.filter((l) => keep.has(l.source) && keep.has(l.target));
		for (const n of list) {
			n.r = n.kind === "tag" ? 4 + Math.sqrt(n.degree) * 0.9 : 2.5 + Math.sqrt(n.degree) * 0.6;
			n.color = colourGroups ? matcher(n, n.kind === "tag" ? [n.target] : (tagsOf.get(n.target) ?? [])) : null;
		}
		this.nodes = list;
		this.neighbours = new Map(list.map((n) => [n, new Set<GNode>()]));
		for (const l of this.links) {
			this.neighbours.get(l.source)?.add(l.target);
			this.neighbours.get(l.target)?.add(l.source);
		}
		this.statusEl?.setText(T.globalStatus(list.length, this.links.length));
		// Restored from the last session: only settle gently instead of starting over.
		const restored = !fresh && old.size === 0 && this.saved !== null && list.filter((n) => this.saved?.has(n.id)).length > list.length * 0.8;
		if (fresh) this.saved = null;
		this.startSimulation(fresh || (old.size === 0 && !restored), restored);
	}

	/** Remember positions and zoom for the next time the graph opens. */
	savePositions() {
		if (this.nodes.length === 0) return;
		const positions: Record<string, [number, number]> = {};
		for (const n of this.nodes) positions[n.id] = [Math.round(n.x ?? 0), Math.round(n.y ?? 0)];
		void this.plugin.saveLayout({ positions, zoom: { ...this.zoom } });
	}

	/* ----- Simulation ----- */

	private startSimulation(firstTime: boolean, restored = false) {
		this.stop();
		const sim = forceSimulation<GNode, GLink>(this.nodes)
			.alpha(firstTime ? 1 : restored ? 0.05 : 0.4)
			.alphaDecay(0.03)
			.stop();
		this.sim = sim;
		this.applyForces();
		if (firstTime) this.zoom = { x: 0, y: 0, k: 0.5 };
		this.settledOnce = false;
		this.loop();
	}

	/** (Re)set the forces from the current settings. */
	private applyForces() {
		const sim = this.sim;
		if (!sim) return;
		const s = this.plugin.settings;
		sim.force(
			"link",
			forceLink<GNode, GLink>(this.links)
				.distance((l) => (l.kind === "parent" ? 45 : l.kind === "link" ? 35 : 18) * s.globalLinkDistance)
				.strength((l) => (l.kind === "parent" ? 0.4 : 0.7) / Math.min(l.source.degree, l.target.degree)),
		)
			// Short-range repulsion only: clusters keep their own space without pushing the whole graph apart.
			.force("charge", forceManyBody<GNode>().strength((n) => -(n.kind === "tag" ? 40 : 9) * s.globalRepel).theta(0.9).distanceMax(250))
			// Tags with many connections are pulled to the middle harder, so the big hubs sit
			// at the centre and smaller topics around them.
			.force("x", forceX<GNode>(0).strength((n) => 0.03 * s.globalGravity * this.pull(n)))
			.force("y", forceY<GNode>(0).strength((n) => 0.03 * s.globalGravity * this.pull(n)));
	}

	private pull(n: GNode) {
		return n.kind === "tag" ? 1 + Math.log2(1 + n.degree) : 1;
	}

	private stop() {
		if (this.frame) this.containerEl.win.cancelAnimationFrame(this.frame);
		this.frame = 0;
	}

	/** One animation frame: advance the simulation a little and draw. */
	private loop = () => {
		this.frame = 0;
		const sim = this.sim;
		if (!sim) return;
		const busy = sim.alpha() > sim.alphaMin();
		if (busy) {
			sim.tick(1);
			this.tree = null;
		}
		this.draw();
		if (busy || this.dragging) this.frame = this.containerEl.win.requestAnimationFrame(this.loop);
		else if (!this.settledOnce) {
			// Settled: remember where everything ended up.
			this.settledOnce = true;
			this.savePositions();
		}
	};

	/** Wake the loop after interaction. */
	private kick(reheat = 0) {
		if (reheat && this.sim) this.sim.alpha(Math.max(this.sim.alpha(), reheat));
		if (!this.frame) this.frame = this.containerEl.win.requestAnimationFrame(this.loop);
	}

	/** For testing without animation frames: run ticks now and draw once. */
	debugRun(ticks: number) {
		const t0 = performance.now();
		for (let i = 0; i < ticks; i++) this.sim?.tick(1);
		const t1 = performance.now();
		this.tree = null;
		this.draw();
		const t2 = performance.now();
		return { nodes: this.nodes.length, links: this.links.length, tickMs: (t1 - t0) / Math.max(1, ticks), drawMs: t2 - t1 };
	}

	/* ----- Drawing ----- */

	private resize() {
		const root = this.contentEl;
		const ratio = this.containerEl.win.devicePixelRatio || 1;
		const w = root.clientWidth;
		const h = root.clientHeight;
		if (w === 0 || h === 0) return;
		this.canvas.width = Math.round(w * ratio);
		this.canvas.height = Math.round(h * ratio);
		this.canvas.setCssProps({ width: `${w}px`, height: `${h}px` });
		this.kick();
	}

	private draw() {
		const ctx = this.ctx;
		if (!ctx) return;
		const ratio = this.containerEl.win.devicePixelRatio || 1;
		const w = this.canvas.width / ratio;
		const h = this.canvas.height / ratio;
		const { x: zx, y: zy, k } = this.zoom;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, w, h);
		ctx.setTransform(ratio * k, 0, 0, ratio * k, ratio * (w / 2 + zx), ratio * (h / 2 + zy));

		// Visible area in graph units, to skip what is off-screen.
		const left = (-w / 2 - zx) / k;
		const right = (w / 2 - zx) / k;
		const top = (-h / 2 - zy) / k;
		const bottom = (h / 2 - zy) / k;
		const inView = (n: GNode) => (n.x ?? 0) > left - 50 && (n.x ?? 0) < right + 50 && (n.y ?? 0) > top - 50 && (n.y ?? 0) < bottom + 50;

		const focus = this.hover ?? this.dragging;
		const near = focus ? (this.neighbours.get(focus) ?? new Set<GNode>()) : null;

		// Edges, in one path per style.
		ctx.lineWidth = 1 / k;
		ctx.strokeStyle = this.colors.line;
		ctx.globalAlpha = focus ? 0.15 : 0.6;
		ctx.beginPath();
		for (const l of this.links) {
			if (!inView(l.source) && !inView(l.target)) continue;
			ctx.moveTo(l.source.x ?? 0, l.source.y ?? 0);
			ctx.lineTo(l.target.x ?? 0, l.target.y ?? 0);
		}
		ctx.stroke();
		if (focus) {
			ctx.globalAlpha = 1;
			ctx.strokeStyle = this.colors.accent;
			ctx.lineWidth = 1.5 / k;
			ctx.beginPath();
			for (const l of this.links) {
				if (l.source !== focus && l.target !== focus) continue;
				ctx.moveTo(l.source.x ?? 0, l.source.y ?? 0);
				ctx.lineTo(l.target.x ?? 0, l.target.y ?? 0);
			}
			ctx.stroke();
		}
		if (this.plugin.settings.globalArrows && k >= 0.5) this.drawArrows(ctx, k, focus, inView);

		// Nodes, grouped by colour.
		const groups = new Map<string, GNode[]>();
		for (const n of this.nodes) {
			if (!inView(n)) continue;
			// Without colour groups everything is the plain node colour and tags the accent colour.
			const plain = !this.plugin.settings.globalColorGroups;
			const color =
				n.color ??
				(n.kind === "tag" ? (plain ? this.colors.accent : this.colors.tag) : n.kind === "file" && !plain ? this.colors.file : this.colors.note);
			const list = groups.get(color);
			if (list) list.push(n);
			else groups.set(color, [n]);
		}
		for (const [color, list] of groups) {
			ctx.fillStyle = color;
			for (const faded of [true, false]) {
				ctx.globalAlpha = focus && faded ? 0.25 : 1;
				ctx.beginPath();
				for (const n of list) {
					const dim = focus !== null && n !== focus && !near?.has(n);
					if (dim !== faded) continue;
					const x = n.x ?? 0;
					const y = n.y ?? 0;
					ctx.moveTo(x + n.r, y);
					ctx.arc(x, y, n.r, 0, 2 * Math.PI);
				}
				ctx.fill();
			}
		}
		if (focus) {
			// The hovered node is filled with the accent colour, without an outline.
			ctx.globalAlpha = 1;
			ctx.fillStyle = this.colors.accent;
			ctx.beginPath();
			ctx.arc(focus.x ?? 0, focus.y ?? 0, focus.r * 1.3, 0, 2 * Math.PI);
			ctx.fill();
		}

		this.drawLabels(ctx, ratio, w, h, focus, near, inView);
	}

	/**
	 * Labels, most important first, skipping any that would overlap one already drawn:
	 * the hovered node and its neighbours, then tags by size, then notes, then other files.
	 * Drawn in screen pixels so the text stays sharp and the same size at every zoom.
	 */
	private drawLabels(
		ctx: CanvasRenderingContext2D,
		ratio: number,
		w: number,
		h: number,
		focus: GNode | null,
		near: Set<GNode> | null,
		inView: (n: GNode) => boolean,
	) {
		const { x: zx, y: zy, k } = this.zoom;
		const rank = (n: GNode) => {
			if (n === focus) return 4e9;
			if (near?.has(n)) return 3e9 + n.degree;
			if (n.kind === "tag") return 2e9 + n.degree;
			if (n.kind === "note") return 1e9 + n.degree;
			return n.degree;
		};
		// Far out, only tags (and the hovered neighbourhood) get names; files join in as you zoom in.
		const candidates = this.nodes.filter((n) => {
			if (!inView(n)) return false;
			if (n === focus || near?.has(n)) return true;
			// Names appear only when zoomed in (tags first), or around the node under the pointer.
			if (n.kind === "tag") return k >= 0.8;
			if (n.kind === "note") return k >= 1.6;
			return k >= 2.6;
		});
		candidates.sort((a, b) => rank(b) - rank(a));

		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.font = `12px ${this.font}`;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";

		// A coarse grid of the boxes already taken makes the overlap test cheap.
		const CELL = 40;
		const taken = new Map<number, { x0: number; y0: number; x1: number; y1: number }[]>();
		const cells = (b: { x0: number; y0: number; x1: number; y1: number }) => {
			const out: number[] = [];
			for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++) {
				for (let cy = Math.floor(b.y0 / CELL); cy <= Math.floor(b.y1 / CELL); cy++) out.push(cx * 100003 + cy);
			}
			return out;
		};
		const MAX_LABELS = 400;
		let drawn = 0;
		for (const n of candidates) {
			if (drawn >= MAX_LABELS) break;
			const text = n.label.length > 32 ? n.label.slice(0, 31) + "…" : n.label;
			const sx = w / 2 + zx + (n.x ?? 0) * k;
			const sy = h / 2 + zy + ((n.y ?? 0) + n.r) * k + 3;
			const half = ctx.measureText(text).width / 2 + 3;
			const box = { x0: sx - half, y0: sy - 1, x1: sx + half, y1: sy + 15 };
			if (box.x1 < 0 || box.x0 > w || box.y1 < 0 || box.y0 > h) continue;
			const keys = cells(box);
			const important = n === focus || near?.has(n);
			const clash = keys.some((key) =>
				(taken.get(key) ?? []).some((o) => box.x0 < o.x1 && o.x0 < box.x1 && box.y0 < o.y1 && o.y0 < box.y1),
			);
			// The hovered neighbourhood always shows; everything else only where there is room.
			if (clash && !important) continue;
			for (const key of keys) {
				const list = taken.get(key);
				if (list) list.push(box);
				else taken.set(key, [box]);
			}
			ctx.globalAlpha = focus && !important ? 0.35 : n.kind === "file" && !important ? 0.75 : 1;
			ctx.fillStyle = n.kind === "tag" ? this.colors.tagText : this.colors.text;
			ctx.fillText(text, sx, sy);
			drawn++;
		}
		ctx.globalAlpha = 1;
	}

	/** Small arrowheads where note links arrive. */
	private drawArrows(ctx: CanvasRenderingContext2D, k: number, focus: GNode | null, inView: (n: GNode) => boolean) {
		const size = 6 / k;
		ctx.fillStyle = this.colors.line;
		ctx.globalAlpha = focus ? 0.3 : 0.8;
		ctx.beginPath();
		for (const l of this.links) {
			if (l.kind !== "link" || !inView(l.target)) continue;
			const sx = l.source.x ?? 0;
			const sy = l.source.y ?? 0;
			const tx = l.target.x ?? 0;
			const ty = l.target.y ?? 0;
			const d = Math.hypot(tx - sx, ty - sy);
			if (d < l.target.r + size * 2) continue;
			const ux = (tx - sx) / d;
			const uy = (ty - sy) / d;
			const ax = tx - ux * (l.target.r + 1 / k);
			const ay = ty - uy * (l.target.r + 1 / k);
			ctx.moveTo(ax, ay);
			ctx.lineTo(ax - ux * size - uy * size * 0.5, ay - uy * size + ux * size * 0.5);
			ctx.lineTo(ax - ux * size + uy * size * 0.5, ay - uy * size - ux * size * 0.5);
			ctx.closePath();
		}
		ctx.fill();
		ctx.globalAlpha = 1;
	}

	/* ----- Pointer ----- */

	private toGraph(evt: { clientX: number; clientY: number }) {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: (evt.clientX - rect.left - rect.width / 2 - this.zoom.x) / this.zoom.k,
			y: (evt.clientY - rect.top - rect.height / 2 - this.zoom.y) / this.zoom.k,
		};
	}

	private nodeAt(evt: { clientX: number; clientY: number }): GNode | null {
		if (!this.tree) {
			this.tree = quadtree<GNode>()
				.x((n) => n.x ?? 0)
				.y((n) => n.y ?? 0)
				.addAll(this.nodes);
		}
		const p = this.toGraph(evt);
		const n = this.tree.find(p.x, p.y, 12 / this.zoom.k + 6);
		return n ?? null;
	}

	private bindPointer() {
		const c = this.canvas;
		c.addEventListener(
			"wheel",
			(evt) => {
				evt.preventDefault();
				const rect = c.getBoundingClientRect();
				const k = Math.min(8, Math.max(0.05, this.zoom.k * Math.exp(-evt.deltaY * 0.0015)));
				// Zoom around the pointer.
				const px = evt.clientX - rect.left - rect.width / 2;
				const py = evt.clientY - rect.top - rect.height / 2;
				this.zoom.x = px - ((px - this.zoom.x) * k) / this.zoom.k;
				this.zoom.y = py - ((py - this.zoom.y) * k) / this.zoom.k;
				this.zoom.k = k;
				this.kick();
			},
			{ passive: false },
		);
		c.addEventListener("pointerdown", (evt) => {
			c.setPointerCapture(evt.pointerId);
			this.moved = false;
			const n = this.nodeAt(evt);
			if (n) {
				this.dragging = n;
				const p = this.toGraph(evt);
				n.fx = p.x;
				n.fy = p.y;
				this.kick(0.3);
			} else {
				this.panning = { x: evt.clientX, y: evt.clientY, zx: this.zoom.x, zy: this.zoom.y };
			}
		});
		c.addEventListener("pointermove", (evt) => {
			if (this.dragging) {
				const p = this.toGraph(evt);
				this.dragging.fx = p.x;
				this.dragging.fy = p.y;
				this.moved = true;
				this.kick(0.1);
				return;
			}
			if (this.panning) {
				const dx = evt.clientX - this.panning.x;
				const dy = evt.clientY - this.panning.y;
				if (Math.abs(dx) + Math.abs(dy) > 3) this.moved = true;
				this.zoom.x = this.panning.zx + dx;
				this.zoom.y = this.panning.zy + dy;
				this.kick();
				return;
			}
			const n = this.nodeAt(evt);
			if (n !== this.hover) {
				this.hover = n;
				c.toggleClass("is-pointing", n !== null);
				this.kick();
			}
		});
		c.addEventListener("pointerup", (evt) => {
			const n = this.dragging;
			if (n) {
				n.fx = null;
				n.fy = null;
			}
			this.dragging = null;
			this.panning = null;
			if (!this.moved && n) this.activate(n, evt);
			if (this.moved) this.settledOnce = false;
			this.kick();
		});
		c.addEventListener("pointerleave", () => {
			if (this.hover) {
				this.hover = null;
				this.kick();
			}
		});
	}

	/** Click: open a file, or show only the clicked tag's part of the graph. */
	private activate(n: GNode, evt: MouseEvent) {
		if (n.kind === "tag") {
			if (Keymap.isModEvent(evt)) {
				this.plugin.openSearch(`#${n.target} `);
				return;
			}
			this.filterInput.value = `#${n.target}`;
			this.filterInput.dispatchEvent(new Event("input"));
			return;
		}
		const f = this.app.vault.getFileByPath(n.target);
		if (f instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(evt) ? "tab" : false).openFile(f);
	}

	/** Zoom and pan so that every node is in view. */
	fit() {
		if (this.nodes.length === 0) return;
		const xs = this.nodes.map((n) => n.x ?? 0);
		const ys = this.nodes.map((n) => n.y ?? 0);
		const minX = Math.min(...xs);
		const maxX = Math.max(...xs);
		const minY = Math.min(...ys);
		const maxY = Math.max(...ys);
		const w = this.contentEl.clientWidth || 600;
		const h = this.contentEl.clientHeight || 600;
		const k = Math.min(4, 0.9 * Math.min(w / Math.max(1, maxX - minX), h / Math.max(1, maxY - minY)));
		this.zoom = { k, x: (-(minX + maxX) / 2) * k, y: (-(minY + maxY) / 2) * k };
		this.kick();
	}
}
