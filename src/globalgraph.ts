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

const LABEL_ZOOM = 0.9;

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
	private colors = { note: "#888", file: "#d4a72c", tag: "#3fa34d", line: "#555", text: "#ddd", accent: "#7c5cff", bg: "#1e1e1e" };
	private filterInput!: HTMLInputElement;
	private statusEl!: HTMLElement;

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
		this.rebuild();
	}

	async onClose() {
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
		this.filterInput = panel.createEl("input", {
			cls: "ww-global-filter",
			attr: { type: "search", placeholder: T.globalFilter(), value: s.globalFilter },
		});
		const refilter = debounce(() => {
			this.plugin.settings.globalFilter = this.filterInput.value;
			void this.plugin.saveSettingsQuietly();
			this.rebuild();
		}, 300, true);
		this.filterInput.addEventListener("input", refilter);

		const toggles: [keyof typeof s, string][] = [
			["globalShowTags", T.globalTags()],
			["globalShowOrphans", T.globalOrphans()],
			["globalShowLinks", T.globalLinks()],
			["globalDenseTags", T.globalDense()],
		];
		for (const [key, label] of toggles) {
			const row = panel.createEl("label", { cls: "ww-global-toggle" });
			const box = row.createEl("input", { attr: { type: "checkbox" } });
			box.checked = Boolean(s[key]);
			row.createSpan({ text: label });
			box.addEventListener("change", () => {
				(this.plugin.settings as unknown as Record<string, unknown>)[key] = box.checked;
				void this.plugin.saveSettingsQuietly();
				this.rebuild();
			});
		}
		const bar = panel.createDiv({ cls: "ww-global-bar" });
		this.statusEl = bar.createSpan({ cls: "ww-global-status" });
		const fit = bar.createSpan({ cls: "ww-graph-button", attr: { "aria-label": T.graphFit(), role: "button" } });
		setIcon(fit, "maximize");
		fit.addEventListener("click", () => this.fit());
		const again = bar.createSpan({ cls: "ww-graph-button", attr: { "aria-label": T.globalRelayout(), role: "button" } });
		setIcon(again, "refresh-cw");
		again.addEventListener("click", () => this.rebuild(true));
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
			accent: v("--graph-node-focused", v("--interactive-accent", "#7c5cff")),
			bg: v("--graph-background", v("--background-primary", "#1e1e1e")),
		};
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
				if (prev) {
					n.x = prev.x;
					n.y = prev.y;
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
				label: "#" + tag,
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
			for (const path of shown) {
				const tags = o.denseTags ? (tagsOf.get(path) ?? []) : store.directTagsOf(path);
				for (const tag of tags) link(fileNode(path), tagNode(tag), "tag");
			}
			// Narrower folder tags hang off broader ones: CM2112 -> Chemistry -> NUS.
			if (!o.denseTags) {
				for (const [child, parent] of store.tagParents()) {
					const a = nodes.get("t:" + child.toLowerCase());
					if (!a) continue;
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
			n.color = matcher(n, n.kind === "tag" ? [n.target] : (tagsOf.get(n.target) ?? []));
		}
		this.nodes = list;
		this.neighbours = new Map(list.map((n) => [n, new Set<GNode>()]));
		for (const l of this.links) {
			this.neighbours.get(l.source)?.add(l.target);
			this.neighbours.get(l.target)?.add(l.source);
		}
		this.statusEl?.setText(T.globalStatus(list.length, this.links.length));
		this.startSimulation(fresh || old.size === 0);
	}

	/* ----- Simulation ----- */

	private startSimulation(firstTime: boolean) {
		this.stop();
		const s = this.plugin.settings;
		const sim = forceSimulation<GNode, GLink>(this.nodes)
			.force(
				"link",
				forceLink<GNode, GLink>(this.links)
					.distance((l) => (l.kind === "parent" ? 60 : l.kind === "link" ? 50 : 30) * s.globalLinkDistance)
					.strength((l) => (l.kind === "parent" ? 0.4 : 0.7) / Math.min(l.source.degree, l.target.degree)),
			)
			.force("charge", forceManyBody<GNode>().strength((n) => -(n.kind === "tag" ? 60 : 18) * s.globalRepel).theta(0.9).distanceMax(900))
			.force("x", forceX<GNode>(0).strength(0.03 * s.globalGravity))
			.force("y", forceY<GNode>(0).strength(0.03 * s.globalGravity))
			.alpha(firstTime ? 1 : 0.4)
			.alphaDecay(0.03)
			.stop();
		this.sim = sim;
		if (firstTime) this.zoom = { x: 0, y: 0, k: 0.5 };
		this.loop();
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

		// Nodes, grouped by colour.
		const groups = new Map<string, GNode[]>();
		for (const n of this.nodes) {
			if (!inView(n)) continue;
			const color = n.color ?? (n.kind === "tag" ? this.colors.tag : n.kind === "file" ? this.colors.file : this.colors.note);
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
					if (n.kind === "tag") ctx.rect(x - n.r, y - n.r, 2 * n.r, 2 * n.r);
					else {
						ctx.moveTo(x + n.r, y);
						ctx.arc(x, y, n.r, 0, 2 * Math.PI);
					}
				}
				ctx.fill();
			}
		}
		if (focus) {
			ctx.globalAlpha = 1;
			ctx.strokeStyle = this.colors.accent;
			ctx.lineWidth = 2 / k;
			ctx.beginPath();
			ctx.arc(focus.x ?? 0, focus.y ?? 0, focus.r + 2 / k, 0, 2 * Math.PI);
			ctx.stroke();
		}

		// Labels: all of them when zoomed in; otherwise tags with many files, and the hovered node's neighbourhood.
		ctx.globalAlpha = 1;
		ctx.fillStyle = this.colors.text;
		ctx.strokeStyle = this.colors.bg;
		ctx.lineWidth = 3 / k;
		ctx.lineJoin = "round";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		ctx.font = `${12 / k}px var(--font-interface, sans-serif)`;
		const big = this.nodes.filter((n) => n.kind === "tag").sort((a, b) => b.degree - a.degree).slice(0, Math.round(12 * k));
		const labelled = new Set<GNode>(k >= LABEL_ZOOM ? this.nodes.filter(inView) : big);
		if (focus) {
			labelled.add(focus);
			near?.forEach((n) => labelled.add(n));
		}
		for (const n of labelled) {
			if (!inView(n)) continue;
			const text = n.label.length > 28 ? n.label.slice(0, 27) + "…" : n.label;
			const y = (n.y ?? 0) + n.r + 2 / k;
			ctx.strokeText(text, n.x ?? 0, y);
			ctx.fillText(text, n.x ?? 0, y);
		}
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
