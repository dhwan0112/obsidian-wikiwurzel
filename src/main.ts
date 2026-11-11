import { App, Events, Plugin, PluginSettingTab, SettingDefinitionItem, TFolder, debounce } from "obsidian";
import { API_VERSION, EVENT_CHANGED, EVENT_READY, EVENT_REQUEST, EVENT_UNLOAD, WurzelApi } from "./api";
import { GLOBAL_GRAPH_VIEW, GlobalGraphView } from "./globalgraph";
import { GRAPH_VIEW, LocalGraphView } from "./graph";
import { T } from "./i18n";
import { FileTagStore, folderOf } from "./store";
import { TagEditModal, TagSearchModal, isFolderPath } from "./ui";

export interface WurzelSettings {
	/** Files shown per tag in the tag graph. */
	graphPerTag: number;
	/** Most files in the tag graph at once. */
	graphMaxFiles: number;
	/** Also show notes linked to or from the file. */
	graphShowLinks: boolean;
	/** Comma-separated tags left out of the graph, e.g. very broad ones. */
	graphHiddenTags: string;
	globalShowTags: boolean;
	globalShowOrphans: boolean;
	globalShowLinks: boolean;
	globalDenseTags: boolean;
	/** Comma-separated file extensions shown in the wiki graph; empty shows every file. */
	globalExtensions: string;
	globalFilter: string;
	globalRepel: number;
	globalGravity: number;
	globalLinkDistance: number;
}

const DEFAULT_SETTINGS: WurzelSettings = {
	graphPerTag: 6,
	graphMaxFiles: 40,
	graphShowLinks: true,
	graphHiddenTags: "",
	globalShowTags: true,
	globalShowOrphans: true,
	globalShowLinks: true,
	globalDenseTags: false,
	globalExtensions: "md, canvas, pdf, docx, doc, pptx, ppt, xlsx, xls, epub, png, jpg, jpeg, gif, svg, webp",
	globalFilter: "",
	globalRepel: 1,
	globalGravity: 1,
	globalLinkDistance: 1,
};

export default class Wikiwurzel extends Plugin {
	settings: WurzelSettings = DEFAULT_SETTINGS;
	store!: FileTagStore;
	api!: WurzelApi;
	private announced = false;
	/** Custom events go through the workspace's plain event interface. */
	private get bus(): Events {
		return this.app.workspace;
	}

	private announceChange = debounce(() => {
		this.bus.trigger(EVENT_CHANGED);
		this.graphViews().forEach((v) => v.render());
		this.refreshGlobal();
	}, 50, true);
	private refreshGlobal = debounce(() => this.globalViews().forEach((v) => v.rebuild()), 1000, true);
	private groups: { query: string; color: string }[] = [];

	async onload() {
		const data = (await this.loadData()) as Partial<WurzelSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
		this.store = new FileTagStore(this.app, () => {
			if (this.announced) this.announceChange();
		});
		this.api = this.createApi();

		this.registerView(GRAPH_VIEW, (leaf) => new LocalGraphView(leaf, this));
		this.registerView(GLOBAL_GRAPH_VIEW, (leaf) => new GlobalGraphView(leaf, this));
		this.addCommand({ id: "open-wiki-graph", name: T.cmdGlobal(), callback: () => void this.openGlobal() });
		this.addRibbonIcon("waypoints", T.cmdGlobal(), () => void this.openGlobal());
		await this.loadColorGroups();
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.refreshGlobal()));
		this.addCommand({ id: "open-graph", name: T.cmdGraph(), callback: () => void this.openGraph() });
		this.addSettingTab(new WurzelSettingTab(this.app, this));
		const follow = () => {
			const path = this.app.workspace.getActiveFile()?.path ?? null;
			this.graphViews().forEach((v) => v.followFile(path));
		};
		this.registerEvent(this.app.workspace.on("file-open", follow));
		this.registerEvent(this.app.workspace.on("active-leaf-change", follow));

		this.addCommand({ id: "search", name: T.cmdSearch(), callback: () => this.openSearch() });
		this.addCommand({
			id: "edit-current",
			name: T.cmdEdit(),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.openEditor(file.path);
				return true;
			},
		});
		this.addCommand({ id: "reload", name: T.cmdReload(), callback: () => void this.store.loadAll() });
		this.addRibbonIcon("tags", T.cmdSearch(), () => this.openSearch());

		// "Edit tags" in the right-click menu of files and folders, including PDFs.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addItem((item) =>
					item
						.setTitle(T.editTitle())
						.setIcon("tags")
						.setSection("action")
						.onClick(() => this.openEditor(file.path)),
				);
			}),
		);

		// Tags follow files that are renamed, moved or deleted inside Obsidian.
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.store.handleRename(file, oldPath)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.store.handleDelete(file)));
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFolder) return;
				this.store.invalidate();
			}),
		);
		// A note's own #tags changed.
		const noteTagKeys = new Map<string, string>();
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				const key = this.store.noteTagsOf(file).join("\n");
				if (noteTagKeys.get(file.path) === key) return;
				noteTagKeys.set(file.path, key);
				this.store.invalidate();
			}),
		);
		// Pick up .tag files edited outside Obsidian when their folder comes into view.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file && this.announced) void this.store.loadChain(folderOf(file.path));
			}),
		);

		// Hand the API to any plugin that asks for it.
		this.registerEvent(this.bus.on(EVENT_REQUEST, () => this.announceReady()));

		this.app.workspace.onLayoutReady(() => {
			void this.store.loadAll().then(() => {
				this.announced = true;
				this.announceReady();
				follow();
				this.graphViews().forEach((v) => v.render());
			});
		});
	}

	onunload() {
		this.announced = false;
		this.bus.trigger(EVENT_UNLOAD);
	}

	/** Only once every .tag file is read, so nobody draws from a half-loaded index. */
	private announceReady() {
		if (this.announced) this.bus.trigger(EVENT_READY, this.api);
	}

	graphViews(): LocalGraphView[] {
		return this.app.workspace
			.getLeavesOfType(GRAPH_VIEW)
			.map((l) => l.view)
			.filter((v): v is LocalGraphView => v instanceof LocalGraphView);
	}

	async openGraph() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(GRAPH_VIEW)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: GRAPH_VIEW, active: true });
			leaf = right;
		}
		await workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof LocalGraphView) view.followFile(workspace.getActiveFile()?.path ?? null);
	}

	globalViews(): GlobalGraphView[] {
		return this.app.workspace
			.getLeavesOfType(GLOBAL_GRAPH_VIEW)
			.map((l) => l.view)
			.filter((v): v is GlobalGraphView => v instanceof GlobalGraphView);
	}

	async openGlobal() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(GLOBAL_GRAPH_VIEW)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}
		await this.loadColorGroups();
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: GLOBAL_GRAPH_VIEW, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** Colour groups are taken from the core graph's settings (read only). */
	private async loadColorGroups() {
		try {
			const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/graph.json`);
			const data = JSON.parse(raw) as { colorGroups?: { query?: unknown; color?: { rgb?: unknown } }[] };
			const out: { query: string; color: string }[] = [];
			for (const g of data.colorGroups ?? []) {
				const rgb = g.color?.rgb;
				if (typeof g.query === "string" && typeof rgb === "number") {
					out.push({ query: g.query, color: "#" + rgb.toString(16).padStart(6, "0") });
				}
			}
			this.groups = out;
		} catch {
			this.groups = [];
		}
	}

	colorGroups() {
		return this.groups;
	}

	/** Save without redrawing (the graph redraws itself). */
	async saveSettingsQuietly() {
		await this.saveData(this.settings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.graphViews().forEach((v) => v.render());
		this.globalViews().forEach((v) => v.rebuild());
	}

	openSearch(query = "") {
		new TagSearchModal(this.app, this.store, query).open();
	}

	openEditor(path: string) {
		new TagEditModal(this.app, this.store, path, isFolderPath(this.app, path)).open();
	}

	private createApi(): WurzelApi {
		const store = this.store;
		return {
			version: API_VERSION,
			ownTags: (path) => store.ownTags(path),
			folderTags: (folder) => store.folderTags(folder),
			inheritedTags: (folder) => store.inheritedTags(folder),
			allTagsOf: (path) => store.allTagsOf(path),
			index: () => store.index(),
			setOwn: (path, tags) => store.setOwn(path, tags),
			setFolder: (folder, tags) => store.setFolder(folder, tags),
			openSearch: (query) => this.openSearch(query),
			openEditor: (path) => this.openEditor(path),
		};
	}
}

/* ---------- Settings ---------- */

type SettingKey = keyof WurzelSettings;

class WurzelSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: Wikiwurzel) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				type: "group",
				heading: "Wiki graph",
				items: [
					{
						name: "File types",
						desc: "Comma-separated extensions shown in the wiki graph. Leave empty to show every file, including program inputs and outputs.",
						control: { type: "text", key: "globalExtensions", placeholder: "md, pdf, png" },
					},
					{
						name: "Repel force",
						desc: "How strongly nodes push each other apart.",
						control: { type: "slider", key: "globalRepel", min: 0.2, max: 4, step: 0.1 },
					},
					{
						name: "Center force",
						desc: "How strongly the graph is pulled together.",
						control: { type: "slider", key: "globalGravity", min: 0, max: 4, step: 0.1 },
					},
					{
						name: "Link distance",
						control: { type: "slider", key: "globalLinkDistance", min: 0.3, max: 4, step: 0.1 },
					},
				],
			},
			{
				type: "group",
				heading: "Tag graph",
				items: [
					{
						name: "Files per tag",
						desc: "How many files each tag brings into the graph. Files sharing the most tags come first.",
						control: { type: "slider", key: "graphPerTag", min: 2, max: 20, step: 1 },
					},
					{
						name: "Most files",
						desc: "Upper limit on files in the graph.",
						control: { type: "slider", key: "graphMaxFiles", min: 10, max: 100, step: 5 },
					},
					{
						name: "Show linked notes",
						desc: "Also show notes that link to or from the file, as dashed lines.",
						control: { type: "toggle", key: "graphShowLinks" },
					},
					{
						name: "Hidden tags",
						desc: "Comma-separated tags to leave out of the graph, such as very broad ones (e.g. NUS, paper).",
						control: { type: "text", key: "graphHiddenTags", placeholder: "NUS, paper" },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as SettingKey];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		this.plugin.settings = { ...this.plugin.settings, [key]: value };
		await this.plugin.saveSettings();
	}
}
