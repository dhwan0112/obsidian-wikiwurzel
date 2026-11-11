import { ItemView, Keymap, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { T } from "./i18n";
import type Wikiwurzel from "./main";
import { nameOf } from "./store";

export const GRAPH_VIEW = "wikiwurzel-local-graph";

/* ---------- Building the neighbourhood ---------- */

type NodeKind = "center" | "tag" | "note" | "file";

export interface GraphNode {
	id: string; // "f:" + path or "t:" + lowercased tag
	kind: NodeKind;
	label: string;
	/** File path for files, tag for tags. */
	target: string;
	/** For tags: how many files carry it in the whole vault. */
	count?: number;
	isTag: boolean;
	x: number;
	y: number;
	vx: number;
	vy: number;
}

export interface GraphEdge {
	a: string;
	b: string;
	kind: "tag" | "link";
}

export interface GraphOptions {
	perTag: number;
	maxFiles: number;
	showLinks: boolean;
	hidden: Set<string>;
}

interface Source {
	allTagsOf(path: string): string[];
	index(): Map<string, string[]>;
	links(path: string): string[];
	exists(path: string): boolean;
	mtime(path: string): number;
}

const fileId = (path: string) => "f:" + path;
const tagId = (tag: string) => "t:" + tag.toLowerCase();

function fileNode(path: string, kind: NodeKind): GraphNode {
	const name = nameOf(path);
	return {
		id: fileId(path),
		kind,
		label: name.endsWith(".md") ? name.slice(0, -3) : name,
		target: path,
		isTag: false,
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
	};
}

function tagNode(tag: string, count: number, center = false): GraphNode {
	return { id: tagId(tag), kind: center ? "center" : "tag", label: "#" + tag, target: tag, count, isTag: true, x: 0, y: 0, vx: 0, vy: 0 };
}

/**
 * The file in the middle, its tags around it, and for each tag the files that share
 * the most tags with it. Very common tags still show, but only their closest files.
 */
export function buildFileGraph(src: Source, center: string, o: GraphOptions) {
	const nodes = new Map<string, GraphNode>();
	const edges: GraphEdge[] = [];
	const index = src.index();
	const sizeOf = new Map([...index].map(([t, paths]) => [t.toLowerCase(), paths.length]));
	const pathsOf = new Map([...index].map(([t, paths]) => [t.toLowerCase(), paths]));

	nodes.set(fileId(center), fileNode(center, "center"));
	const tags = src.allTagsOf(center).filter((t) => !o.hidden.has(t.toLowerCase()));
	const own = new Set(tags.map((t) => t.toLowerCase()));
	for (const tag of tags) {
		nodes.set(tagId(tag), tagNode(tag, sizeOf.get(tag.toLowerCase()) ?? 0));
		edges.push({ a: fileId(center), b: tagId(tag), kind: "tag" });
	}

	// Score every file that shares a tag: more shared tags first, then rarer tags, then newer.
	const score = new Map<string, number>();
	for (const tag of own) {
		const weight = 1 / Math.log2(2 + (sizeOf.get(tag) ?? 0));
		for (const p of pathsOf.get(tag) ?? []) {
			if (p === center) continue;
			score.set(p, (score.get(p) ?? 0) + 1 + weight);
		}
	}
	const chosen = new Set<string>();
	// Each tag gets its own closest files, so a rare tag is not drowned out by common ones.
	for (const tag of [...own].sort((a, b) => (sizeOf.get(a) ?? 0) - (sizeOf.get(b) ?? 0))) {
		const ranked = (pathsOf.get(tag) ?? [])
			.filter((p) => p !== center)
			.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || src.mtime(b) - src.mtime(a));
		let added = 0;
		for (const p of ranked) {
			if (chosen.size >= o.maxFiles || added >= o.perTag) break;
			if (!chosen.has(p)) chosen.add(p);
			added++;
		}
	}
	// Notes linked to or from the file.
	const linked = o.showLinks ? src.links(center).filter((p) => p !== center && src.exists(p)) : [];
	for (const p of linked.slice(0, 12)) chosen.add(p);

	for (const p of chosen) {
		nodes.set(fileId(p), fileNode(p, p.endsWith(".md") ? "note" : "file"));
		const theirs = new Set(src.allTagsOf(p).map((t) => t.toLowerCase()));
		for (const tag of own) if (theirs.has(tag)) edges.push({ a: fileId(p), b: tagId(tag), kind: "tag" });
	}
	for (const p of linked.slice(0, 12)) edges.push({ a: fileId(center), b: fileId(p), kind: "link" });
	return { nodes: [...nodes.values()], edges };
}

/** A tag in the middle, recent files carrying it, and the tags those files share most. */
export function buildTagGraph(src: Source, tag: string, o: GraphOptions) {
	const nodes = new Map<string, GraphNode>();
	const edges: GraphEdge[] = [];
	const index = src.index();
	const entry = [...index].find(([t]) => t.toLowerCase() === tag.toLowerCase());
	const paths = entry?.[1] ?? [];
	const display = entry?.[0] ?? tag;
	nodes.set(tagId(display), tagNode(display, paths.length, true));

	const files = [...paths].sort((a, b) => src.mtime(b) - src.mtime(a)).slice(0, o.maxFiles);
	const together = new Map<string, { tag: string; n: number }>();
	const tagsOf = new Map<string, string[]>();
	for (const p of files) {
		const tags = src.allTagsOf(p).filter((t) => t.toLowerCase() !== display.toLowerCase() && !o.hidden.has(t.toLowerCase()));
		tagsOf.set(p, tags);
		for (const t of tags) {
			const k = t.toLowerCase();
			const e = together.get(k);
			if (e) e.n++;
			else together.set(k, { tag: t, n: 1 });
		}
	}
	const sizeOf = new Map([...index].map(([t, ps]) => [t.toLowerCase(), ps.length]));
	const related = [...together.values()]
		.filter((e) => e.n > 1)
		.sort((a, b) => b.n - a.n)
		.slice(0, 8);
	const relatedKeys = new Set(related.map((e) => e.tag.toLowerCase()));
	for (const e of related) nodes.set(tagId(e.tag), tagNode(e.tag, sizeOf.get(e.tag.toLowerCase()) ?? 0));

	for (const p of files) {
		nodes.set(fileId(p), fileNode(p, p.endsWith(".md") ? "note" : "file"));
		edges.push({ a: fileId(p), b: tagId(display), kind: "tag" });
		for (const t of tagsOf.get(p) ?? []) {
			if (relatedKeys.has(t.toLowerCase())) edges.push({ a: fileId(p), b: tagId(t), kind: "tag" });
		}
	}
	return { nodes: [...nodes.values()], edges };
}

/* ---------- Layout: a small force simulation, enough for a hundred nodes ---------- */

const LABEL_MAX = 18;
/** Width of one label character at the 11px label size. */
const CHAR_W = 6.6;
const LABEL_GAP = 16;

export const short = (s: string) => (s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + "…" : s);

export function labelOf(n: GraphNode): string {
	return n.isTag && n.kind !== "center" ? `${n.label} (${n.count ?? 0})` : n.label;
}

export function radiusOf(n: GraphNode): number {
	if (n.kind === "center") return 9;
	return n.isTag ? 6 + Math.min(6, Math.log2(1 + (n.count ?? 0)) / 2) : 5;
}

/** The space a node and its label take up. */
function boxOf(n: GraphNode) {
	const r = radiusOf(n);
	const w = Math.max(2 * r, short(labelOf(n)).length * CHAR_W) + 6;
	return { w, top: n.y - r, bottom: n.y + r + LABEL_GAP };
}

/**
 * Spread the nodes out; `aspect` is the panel's height / width, so a tall sidebar
 * gets a tall picture. Afterwards, nodes whose labels overlap are pushed apart.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[], aspect: number) {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const sx = 1 / Math.sqrt(aspect);
	const sy = Math.sqrt(aspect);
	// Start on rings: centre, tags, files; deterministic so the picture does not jump.
	const tags = nodes.filter((n) => n.isTag && n.kind !== "center");
	const files = nodes.filter((n) => !n.isTag && n.kind !== "center");
	tags.forEach((n, i) => {
		const a = (2 * Math.PI * i) / Math.max(1, tags.length);
		n.x = 120 * Math.cos(a) * sx;
		n.y = 120 * Math.sin(a) * sy;
	});
	files.forEach((n, i) => {
		const a = (2 * Math.PI * (i + 0.5)) / Math.max(1, files.length);
		n.x = 280 * Math.cos(a) * sx;
		n.y = 280 * Math.sin(a) * sy;
	});
	const links: [GraphNode, GraphNode, number][] = [];
	for (const e of edges) {
		const a = byId.get(e.a);
		const b = byId.get(e.b);
		if (!a || !b) continue;
		const rest = e.kind === "link" ? 160 : a.kind === "center" || b.kind === "center" ? 100 : 130;
		links.push([a, b, rest]);
	}
	const gx = 0.012 / sx;
	const gy = 0.012 / sy;

	for (let step = 0; step < 320; step++) {
		const cool = 1 - step / 320;
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i];
				const b = nodes[j];
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				let d2 = dx * dx + dy * dy;
				if (d2 < 0.01) {
					dx = (i - j) * 0.1;
					dy = 0.1;
					d2 = dx * dx + dy * dy;
				}
				// Tags push each other harder so their labels keep apart.
				const f = ((a.isTag && b.isTag ? 2 : 1) * 6000) / d2;
				const d = Math.sqrt(d2);
				a.vx += (dx / d) * f;
				a.vy += (dy / d) * f;
				b.vx -= (dx / d) * f;
				b.vy -= (dy / d) * f;
			}
		}
		for (const [a, b, rest] of links) {
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
			const f = (d - rest) * 0.04;
			a.vx += (dx / d) * f;
			a.vy += (dy / d) * f;
			b.vx -= (dx / d) * f;
			b.vy -= (dy / d) * f;
		}
		for (const n of nodes) {
			if (n.kind === "center") {
				n.x = n.y = n.vx = n.vy = 0;
				continue;
			}
			n.vx -= n.x * gx;
			n.vy -= n.y * gy;
			const v = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
			const max = 30 * cool + 1;
			if (v > max) {
				n.vx *= max / v;
				n.vy *= max / v;
			}
			n.x += n.vx;
			n.y += n.vy;
			n.vx *= 0.6;
			n.vy *= 0.6;
		}
	}

	// Push apart nodes whose label boxes overlap, along the shorter way out.
	for (let pass = 0; pass < 120; pass++) {
		let moved = false;
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i];
				const b = nodes[j];
				const ba = boxOf(a);
				const bb = boxOf(b);
				const ox = (ba.w + bb.w) / 2 - Math.abs(a.x - b.x);
				const oy = Math.min(ba.bottom, bb.bottom) - Math.max(ba.top, bb.top);
				if (ox <= 0 || oy <= 0) continue;
				moved = true;
				const horizontal = ox < oy;
				const amount = (horizontal ? ox : oy) / 2 + 0.5;
				const sign = horizontal ? (a.x < b.x ? -1 : 1) : a.y < b.y ? -1 : 1;
				const shareA = a.kind === "center" ? 0 : b.kind === "center" ? 2 : 1;
				const shareB = 2 - shareA;
				if (horizontal) {
					a.x += sign * amount * shareA;
					b.x -= sign * amount * shareB;
				} else {
					a.y += sign * amount * shareA;
					b.y -= sign * amount * shareB;
				}
			}
		}
		if (!moved) break;
	}
}

/* ---------- View ---------- */

/** Labels are drawn at 1:1; when the graph is larger than the panel it may shrink this far before parts go off-screen. */
const MAX_SHRINK = 1.35;

export class LocalGraphView extends ItemView {
	/** A tag chosen by clicking it; null follows the active file. */
	private focusTag: string | null = null;
	private shownFile: string | null = null;
	private svg: SVGSVGElement | null = null;
	/** Pan offset in graph units and zoom factor, on top of the fitted view. */
	private view = { x: 0, y: 0, scale: 1 };
	private bounds = { x: -300, y: -300, w: 600, h: 600 };
	/** The viewBox last applied, in graph units. */
	private box = { x: 0, y: 0, w: 1, h: 1 };
	private resizeObserver: ResizeObserver | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: Wikiwurzel) {
		super(leaf);
	}

	getViewType() {
		return GRAPH_VIEW;
	}
	getDisplayText() {
		return T.graphTitle();
	}
	getIcon() {
		return "git-fork";
	}

	async onOpen() {
		this.contentEl.addClass("ww-graph");
		this.resizeObserver = new ResizeObserver(() => this.applyView());
		this.resizeObserver.observe(this.contentEl);
		this.render();
	}

	/** Obsidian calls this when the panel is shown or resized. */
	onResize() {
		this.applyView();
	}

	async onClose() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	/** Called when another file comes into view. */
	followFile(path: string | null) {
		if (path === this.shownFile && this.focusTag === null) return;
		this.shownFile = path;
		this.focusTag = null;
		this.render();
	}

	render() {
		const root = this.contentEl;
		root.empty();
		const store = this.plugin.store;
		const s = this.plugin.settings;

		const bar = root.createDiv({ cls: "ww-graph-bar" });
		if (this.focusTag !== null) {
			const back = bar.createSpan({ cls: "ww-graph-button", attr: { "aria-label": T.graphBack(), role: "button" } });
			setIcon(back, "arrow-left");
			back.addEventListener("click", () => {
				this.focusTag = null;
				this.render();
			});
		}
		const title = bar.createSpan({ cls: "ww-graph-title" });
		const fit = bar.createSpan({ cls: "ww-graph-button", attr: { "aria-label": T.graphFit(), role: "button" } });
		setIcon(fit, "maximize");
		fit.addEventListener("click", () => {
			this.view = { x: 0, y: 0, scale: 1 };
			this.applyView();
		});

		if (!store.loaded) return;
		const file = this.focusTag === null ? this.shownFile : null;
		if (this.focusTag === null && !file) {
			root.createDiv({ cls: "ww-graph-empty", text: T.graphNoFile() });
			return;
		}
		const options: GraphOptions = {
			perTag: s.graphPerTag,
			maxFiles: s.graphMaxFiles,
			showLinks: s.graphShowLinks,
			hidden: new Set(
				s.graphHiddenTags
					.split(",")
					.map((t) => t.trim().replace(/^#/, "").toLowerCase())
					.filter((t) => t.length > 0),
			),
		};
		const source: Source = {
			allTagsOf: (p) => store.allTagsOf(p),
			index: () => store.index(),
			links: (p) => this.links(p),
			exists: (p) => this.app.vault.getFileByPath(p) !== null,
			mtime: (p) => this.app.vault.getFileByPath(p)?.stat.mtime ?? 0,
		};
		const graph =
			this.focusTag !== null ? buildTagGraph(source, this.focusTag, options) : buildFileGraph(source, file ?? "", options);
		title.setText(this.focusTag !== null ? `#${this.focusTag}` : nameOf(file ?? ""));
		if (graph.nodes.length <= 1) {
			root.createDiv({ cls: "ww-graph-empty", text: T.graphNoTags() });
			return;
		}
		const rect = root.getBoundingClientRect();
		const aspect = rect.width > 0 && rect.height > 80 ? Math.min(4, Math.max(0.5, (rect.height - 40) / rect.width)) : 1;
		layout(graph.nodes, graph.edges, aspect);
		this.draw(root, graph.nodes, graph.edges);
	}

	/** Notes this file links to, and notes that link to it. */
	private links(path: string): string[] {
		const out = new Set<string>();
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const target of Object.keys(resolved[path] ?? {})) out.add(target);
		for (const source in resolved) if (resolved[source][path]) out.add(source);
		return [...out];
	}

	private draw(root: HTMLElement, nodes: GraphNode[], edges: GraphEdge[]) {
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const pad = 16;
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const n of nodes) {
			const half = short(labelOf(n)).length * 3.4 + 8;
			minX = Math.min(minX, n.x - half);
			maxX = Math.max(maxX, n.x + half);
			minY = Math.min(minY, n.y - radiusOf(n));
			maxY = Math.max(maxY, n.y + radiusOf(n) + 16);
		}
		this.bounds = { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
		this.view = { x: 0, y: 0, scale: 1 };

		const svg = root.createSvg("svg", { cls: "ww-graph-svg" });
		this.svg = svg;
		const edgeLayer = svg.createSvg("g", { cls: "ww-graph-edges" });
		const nodeLayer = svg.createSvg("g", { cls: "ww-graph-nodes" });

		const edgeEls = new Map<string, SVGLineElement[]>();
		for (const e of edges) {
			const a = byId.get(e.a);
			const b = byId.get(e.b);
			if (!a || !b) continue;
			const line = edgeLayer.createSvg("line", {
				cls: e.kind === "link" ? ["ww-edge", "is-link"] : ["ww-edge"],
				attr: { x1: a.x, y1: a.y, x2: b.x, y2: b.y },
			});
			for (const id of [e.a, e.b]) {
				const list = edgeEls.get(id);
				if (list) list.push(line);
				else edgeEls.set(id, [line]);
			}
		}

		for (const n of nodes) {
			const g = nodeLayer.createSvg("g", {
				cls: n.isTag ? ["ww-node", `is-${n.kind}`, "is-tag"] : ["ww-node", `is-${n.kind}`],
				attr: { transform: `translate(${n.x},${n.y})` },
			});
			const r = radiusOf(n);
			if (n.isTag) {
				g.createSvg("rect", { attr: { x: -r, y: -r, width: 2 * r, height: 2 * r, rx: 3 } });
			} else {
				g.createSvg("circle", { attr: { r } });
			}
			const label = labelOf(n);
			g.createSvg("text", { attr: { y: r + 12 } }).textContent = short(label);
			g.createSvg("title").textContent = n.isTag ? `${n.label} — ${T.tagCount(n.count ?? 0)}` : n.target;

			g.addEventListener("mouseenter", () => {
				svg.addClass("is-hovering");
				g.addClass("is-hover");
				edgeEls.get(n.id)?.forEach((l) => l.addClass("is-hover"));
			});
			g.addEventListener("mouseleave", () => {
				svg.removeClass("is-hovering");
				g.removeClass("is-hover");
				edgeEls.get(n.id)?.forEach((l) => l.removeClass("is-hover"));
			});
			g.addEventListener("click", (evt) => {
				if (this.dragged) return;
				if (n.isTag) {
					if (Keymap.isModEvent(evt)) {
						this.plugin.openSearch(`#${n.target} `);
						return;
					}
					this.focusTag = n.target;
					this.render();
					return;
				}
				const f = this.app.vault.getFileByPath(n.target);
				if (f instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(f);
			});
		}
		this.enablePanZoom(svg);
		// The panel's size is only known once the SVG is laid out; observing it applies the view then.
		this.resizeObserver?.observe(svg);
		this.applyView();
	}

	private dragged = false;

	/** Wheel to zoom around the pointer, drag the background to pan. */
	private enablePanZoom(svg: SVGSVGElement) {
		svg.addEventListener(
			"wheel",
			(evt: WheelEvent) => {
				evt.preventDefault();
				const rect = svg.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return;
				const scale = Math.min(6, Math.max(0.3, this.view.scale * Math.exp(-evt.deltaY * 0.0015)));
				// Keep the point under the pointer where it is.
				const px = (evt.clientX - rect.left) / rect.width;
				const py = (evt.clientY - rect.top) / rect.height;
				const wx = this.box.x + px * this.box.w;
				const wy = this.box.y + py * this.box.h;
				const ratio = this.view.scale / scale;
				const w = this.box.w * ratio;
				const h = this.box.h * ratio;
				this.view.x = wx - px * w + w / 2 - (this.bounds.x + this.bounds.w / 2);
				this.view.y = wy - py * h + h / 2 - (this.bounds.y + this.bounds.h / 2);
				this.view.scale = scale;
				this.applyView();
			},
			{ passive: false },
		);
		let start: { x: number; y: number; vx: number; vy: number } | null = null;
		svg.addEventListener("pointerdown", (evt) => {
			start = { x: evt.clientX, y: evt.clientY, vx: this.view.x, vy: this.view.y };
			this.dragged = false;
		});
		svg.addEventListener("pointermove", (evt) => {
			if (!start) return;
			const rect = svg.getBoundingClientRect();
			const dx = evt.clientX - start.x;
			const dy = evt.clientY - start.y;
			if (Math.abs(dx) + Math.abs(dy) > 4) {
				this.dragged = true;
				svg.addClass("is-panning");
			}
			if (!this.dragged || rect.width === 0) return;
			const unit = this.box.w / rect.width;
			this.view.x = start.vx - dx * unit;
			this.view.y = start.vy - dy * unit;
			this.applyView();
		});
		const end = () => {
			start = null;
			svg.removeClass("is-panning");
			// Let the click that ends a drag pass without opening anything.
			window.setTimeout(() => (this.dragged = false), 0);
		};
		svg.addEventListener("pointerup", end);
		svg.addEventListener("pointerleave", end);
	}

	/**
	 * Show the graph at 1:1 so labels keep their size, centred; shrink a little
	 * (up to MAX_SHRINK) when it is larger than the panel, then apply pan and zoom.
	 */
	private applyView() {
		if (!this.svg) return;
		const rect = this.svg.getBoundingClientRect();
		const cw = rect.width || 300;
		const ch = rect.height || 300;
		const fit = Math.min(MAX_SHRINK, Math.max(1, this.bounds.w / cw, this.bounds.h / ch));
		const unit = fit / this.view.scale;
		const w = cw * unit;
		const h = ch * unit;
		const cx = this.bounds.x + this.bounds.w / 2 + this.view.x;
		const cy = this.bounds.y + this.bounds.h / 2 + this.view.y;
		this.box = { x: cx - w / 2, y: cy - h / 2, w, h };
		this.svg.setAttr("viewBox", `${this.box.x} ${this.box.y} ${w} ${h}`);
	}
}
