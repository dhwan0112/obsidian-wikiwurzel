import { Events, Plugin, TFolder, debounce } from "obsidian";
import { API_VERSION, EVENT_CHANGED, EVENT_READY, EVENT_REQUEST, EVENT_UNLOAD, WurzelApi } from "./api";
import { T } from "./i18n";
import { FileTagStore, folderOf } from "./store";
import { TagEditModal, TagSearchModal, isFolderPath } from "./ui";

export default class Wikiwurzel extends Plugin {
	store!: FileTagStore;
	api!: WurzelApi;
	private announced = false;
	/** Custom events go through the workspace's plain event interface. */
	private get bus(): Events {
		return this.app.workspace;
	}

	private announceChange = debounce(() => this.bus.trigger(EVENT_CHANGED), 50, true);

	async onload() {
		this.store = new FileTagStore(this.app, () => {
			if (this.announced) this.announceChange();
		});
		this.api = this.createApi();

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
