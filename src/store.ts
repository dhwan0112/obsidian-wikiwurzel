import { App, TAbstractFile, TFile, TFolder, getAllTags, parseYaml, stringifyYaml } from "obsidian";

export const TAG_FILE = ".tag";

/**
 * One ".tag" file per folder, written as YAML:
 *
 *   folder: [paper, ReaxFF]          # applies to everything in this folder and below
 *   files:
 *     "some paper.pdf": [CM4288]     # applies to that file only
 *
 * Obsidian does not index dot files, so these never show up as notes,
 * and they work for any file type (PDF, images, ...).
 */
export interface FolderTags {
	folder: string[];
	files: Record<string, string[]>;
}

export function cleanTag(raw: string): string {
	return raw.trim().replace(/^#+/, "").replace(/\s+/g, "-");
}

function toTagList(value: unknown): string[] {
	const items: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const out: string[] = [];
	for (const item of items) {
		if (typeof item !== "string" && typeof item !== "number") continue;
		const tag = cleanTag(String(item));
		if (tag && !out.includes(tag)) out.push(tag);
	}
	return out;
}

export function parseTagFile(text: string): FolderTags {
	const out: FolderTags = { folder: [], files: {} };
	let data: unknown;
	try {
		data = parseYaml(text);
	} catch {
		return out;
	}
	if (!data || typeof data !== "object") return out;
	const record = data as Record<string, unknown>;
	out.folder = toTagList(record.folder);
	if (record.files && typeof record.files === "object") {
		for (const [name, tags] of Object.entries(record.files as Record<string, unknown>)) {
			const list = toTagList(tags);
			if (list.length > 0) out.files[name] = list;
		}
	}
	return out;
}

export function folderOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

export function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** `folder` and every folder above it, nearest first, ending with "" (the vault root). */
function folderChain(folder: string): string[] {
	const out = [folder];
	let f = folder;
	while (f) {
		f = folderOf(f);
		out.push(f);
	}
	return out;
}

/** Add tags to a list, skipping ones already there in any letter case. */
function addUnique(list: string[], tags: string[]) {
	const seen = new Set(list.map((t) => t.toLowerCase()));
	for (const tag of tags) {
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		list.push(tag);
	}
}

export class FileTagStore {
	/** Folder path ("" = vault root) -> contents of its .tag file. */
	private folders = new Map<string, FolderTags>();
	private byTag: Map<string, string[]> | null = null;
	private queue: Promise<void> = Promise.resolve();
	loaded = false;

	constructor(private app: App, private onChange: () => void) {}

	private tagPath(folder: string) {
		return folder ? `${folder}/${TAG_FILE}` : TAG_FILE;
	}

	private async readFolder(folder: string) {
		const adapter = this.app.vault.adapter;
		const path = this.tagPath(folder);
		try {
			if (await adapter.exists(path)) this.folders.set(folder, parseTagFile(await adapter.read(path)));
			else this.folders.delete(folder);
		} catch {
			this.folders.delete(folder);
		}
	}

	/** Read every .tag file. Nothing is announced until all of them are in. */
	async loadAll() {
		const paths = this.app.vault.getAllFolders(true).map((f) => (f.isRoot() ? "" : f.path));
		await Promise.all(paths.map((p) => this.readFolder(p)));
		const live = new Set(paths);
		for (const key of [...this.folders.keys()]) if (!live.has(key)) this.folders.delete(key);
		this.loaded = true;
		this.invalidate();
	}

	/** Re-read the .tag files that apply to `folder`, in case they were edited outside Obsidian. */
	async loadChain(folder: string) {
		await Promise.all(folderChain(folder).map((f) => this.readFolder(f)));
		this.invalidate();
	}

	/** Forget the tag index and tell listeners. */
	invalidate() {
		this.byTag = null;
		this.onChange();
	}

	ownTags(path: string): string[] {
		return [...(this.folders.get(folderOf(path))?.files[nameOf(path)] ?? [])];
	}

	folderTags(folder: string): string[] {
		return [...(this.folders.get(folder)?.folder ?? [])];
	}

	inheritedTags(folder: string): { tag: string; from: string }[] {
		const out: { tag: string; from: string }[] = [];
		if (!folder) return out;
		const seen = new Set(this.folderTags(folder).map((t) => t.toLowerCase()));
		for (const f of folderChain(folderOf(folder))) {
			for (const tag of this.folderTags(f)) {
				const key = tag.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ tag, from: f });
			}
		}
		return out;
	}

	/** Tags from .tag files: the file's own plus those of all folders above it. */
	fileTagsOf(path: string): string[] {
		const out = this.ownTags(path);
		for (const f of folderChain(folderOf(path))) addUnique(out, this.folderTags(f));
		return out;
	}

	/** For notes, also the #tags Obsidian found in them (without "#"). */
	noteTagsOf(file: TFile): string[] {
		if (file.extension !== "md") return [];
		const cache = this.app.metadataCache.getFileCache(file);
		return cache ? (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "")) : [];
	}

	allTagsOf(path: string): string[] {
		const out = this.fileTagsOf(path);
		const file = this.app.vault.getFileByPath(path);
		if (file) addUnique(out, this.noteTagsOf(file));
		return out;
	}

	/**
	 * Tag -> paths, for notes and other files together. Tags that differ only in letter case
	 * are one tag, as in Obsidian; the spelling used most often is shown.
	 */
	index(): Map<string, string[]> {
		if (this.byTag) return this.byTag;
		const paths = new Map<string, string[]>();
		const spellings = new Map<string, Map<string, number>>();
		for (const file of this.app.vault.getFiles()) {
			for (const tag of this.allTagsOf(file.path)) {
				const key = tag.toLowerCase();
				const list = paths.get(key);
				if (list) list.push(file.path);
				else paths.set(key, [file.path]);
				let counts = spellings.get(key);
				if (!counts) spellings.set(key, (counts = new Map<string, number>()));
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		const map = new Map<string, string[]>();
		for (const [key, list] of paths) {
			const counts = [...(spellings.get(key) ?? new Map<string, number>())];
			counts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
			map.set(counts[0]?.[0] ?? key, list);
		}
		this.byTag = map;
		return map;
	}

	private entry(folder: string): FolderTags {
		let e = this.folders.get(folder);
		if (!e) {
			e = { folder: [], files: {} };
			this.folders.set(folder, e);
		}
		return e;
	}

	private async writeFolder(folder: string) {
		const adapter = this.app.vault.adapter;
		const path = this.tagPath(folder);
		const data = this.folders.get(folder);
		if (!data || (data.folder.length === 0 && Object.keys(data.files).length === 0)) {
			this.folders.delete(folder);
			if (await adapter.exists(path)) await adapter.remove(path);
			return;
		}
		await adapter.write(path, stringifyYaml({ folder: data.folder, files: data.files }));
	}

	/** Writes are queued so two quick edits never race on the same file. */
	private commit(folder: string): Promise<void> {
		this.queue = this.queue
			.then(() => this.writeFolder(folder))
			.catch((err: unknown) => console.error(`Wikiwurzel: could not save ${this.tagPath(folder)}`, err));
		this.invalidate();
		return this.queue;
	}

	private setFileEntry(folder: string, name: string, tags: string[]) {
		const e = this.entry(folder);
		const rest = Object.entries(e.files).filter(([key]) => key !== name);
		if (tags.length > 0) rest.push([name, tags]);
		e.files = Object.fromEntries(rest);
	}

	private static clean(tags: string[]): string[] {
		const out: string[] = [];
		addUnique(out, tags.map(cleanTag).filter((t) => t.length > 0));
		return out;
	}

	setOwn(path: string, tags: string[]): Promise<void> {
		this.setFileEntry(folderOf(path), nameOf(path), FileTagStore.clean(tags));
		return this.commit(folderOf(path));
	}

	setFolder(folder: string, tags: string[]): Promise<void> {
		this.entry(folder).folder = FileTagStore.clean(tags);
		return this.commit(folder);
	}

	/** Wait for pending writes (used by tests and before unloading). */
	flush(): Promise<void> {
		return this.queue;
	}

	private remapFolders(oldPath: string, newPath: string | null) {
		for (const [key, value] of [...this.folders]) {
			if (key !== oldPath && !key.startsWith(oldPath + "/")) continue;
			this.folders.delete(key);
			if (newPath !== null) this.folders.set(newPath + key.slice(oldPath.length), value);
		}
		this.invalidate();
	}

	/** Keep a file's tags attached to it when it is renamed or moved inside Obsidian. */
	handleRename(file: TAbstractFile, oldPath: string) {
		if (file instanceof TFolder) {
			// The folder's own .tag file travelled with it; only the cache keys change.
			this.remapFolders(oldPath, file.path);
			return;
		}
		const oldFolder = folderOf(oldPath);
		const tags = this.folders.get(oldFolder)?.files[nameOf(oldPath)];
		if (!tags) {
			this.invalidate();
			return;
		}
		// Part of a folder move: handled by the folder's own rename event.
		if (oldFolder && !this.app.vault.getAbstractFileByPath(oldFolder)) return;
		this.setFileEntry(oldFolder, nameOf(oldPath), []);
		void this.commit(oldFolder);
		void this.setOwn(file.path, tags);
	}

	handleDelete(file: TAbstractFile) {
		if (file instanceof TFolder) {
			this.remapFolders(file.path, null);
			return;
		}
		if (this.ownTags(file.path).length > 0) void this.setOwn(file.path, []);
		else this.invalidate();
	}
}
