import { App, Keymap, Modal, SuggestModal, TFile, TFolder, setIcon } from "obsidian";
import { T } from "./i18n";
import { FileTagStore, cleanTag, folderOf, nameOf } from "./store";

const RESULT_LIMIT = 200;
const DATALIST_ID = "ww-tag-options";

/** Fill a <datalist> with every known tag so tag inputs can suggest them. */
export function tagOptions(parent: HTMLElement, store: FileTagStore) {
	const list = parent.createEl("datalist", { attr: { id: DATALIST_ID } });
	for (const tag of [...store.index().keys()].sort((a, b) => a.localeCompare(b))) {
		list.createEl("option", { attr: { value: tag } });
	}
}

export function chip(parent: HTMLElement, tag: string, onClick?: () => void) {
	const el = parent.createSpan({ cls: "ww-chip" });
	const name = el.createSpan({ cls: "ww-chip-name", text: tag });
	if (onClick) {
		name.addClass("is-clickable");
		name.addEventListener("click", onClick);
	}
	return el;
}

/** A labelled row of removable tags with an input for adding one. */
export function tagRow(
	parent: HTMLElement,
	label: string,
	tags: string[],
	save: (tags: string[]) => Promise<void>,
	focus = false,
) {
	const row = parent.createDiv({ cls: "ww-row" });
	row.createDiv({ cls: "ww-row-label", text: label });
	const chips = row.createDiv({ cls: "ww-chips" });
	for (const tag of tags) {
		const c = chip(chips, tag);
		const remove = c.createSpan({ cls: "ww-chip-remove", attr: { "aria-label": T.removeTag(tag), role: "button" } });
		setIcon(remove, "x");
		remove.addEventListener("click", () => void save(tags.filter((t) => t !== tag)));
	}
	const input = chips.createEl("input", {
		cls: "ww-input",
		attr: { type: "text", placeholder: T.addTag(), list: DATALIST_ID, "aria-label": T.addTag() },
	});
	const add = () => {
		const tag = cleanTag(input.value);
		input.value = "";
		if (!tag || tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
		void save([...tags, tag]);
	};
	input.addEventListener("keydown", (evt) => {
		if (evt.key === "Enter" && !evt.isComposing) {
			evt.preventDefault();
			add();
		}
	});
	// Picking a suggestion with the mouse fires "change" without Enter.
	input.addEventListener("change", add);
	if (focus) window.setTimeout(() => input.focus(), 0);
	return input;
}

/* ---------- Tag editor ---------- */

export class TagEditModal extends Modal {
	private focusRow: "own" | "folder" | null = "own";

	constructor(app: App, private store: FileTagStore, private path: string, private isFolder: boolean) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("ww-modal");
		this.setTitle(T.editTitle());
		this.render();
	}

	/** Redraw after every change; the row that was being typed in gets the focus back. */
	private render() {
		const { contentEl, store, path } = this;
		contentEl.empty();
		tagOptions(contentEl, store);
		contentEl.createDiv({ cls: "ww-target", text: path || T.vaultRoot() });

		const folder = this.isFolder ? path : folderOf(path);
		if (!this.isFolder) {
			tagRow(contentEl, T.thisFile(), store.ownTags(path), (tags) => this.save(() => store.setOwn(path, tags), "own"), this.focusRow === "own");
		}
		tagRow(
			contentEl,
			this.isFolder ? T.thisFolder() : T.folder(folder ? nameOf(folder) : T.vaultRoot()),
			store.folderTags(folder),
			(tags) => this.save(() => store.setFolder(folder, tags), "folder"),
			this.isFolder ? this.focusRow !== null : this.focusRow === "folder",
		);
		const inherited = store.inheritedTags(folder);
		if (inherited.length > 0) {
			const row = contentEl.createDiv({ cls: "ww-row" });
			row.createDiv({ cls: "ww-row-label", text: T.inherited() });
			const chips = row.createDiv({ cls: "ww-chips" });
			for (const { tag, from } of inherited) chip(chips, tag).setAttr("aria-label", from || T.vaultRoot());
		}
		const file = this.isFolder ? null : this.app.vault.getFileByPath(path);
		const noteTags = file ? store.noteTagsOf(file) : [];
		if (noteTags.length > 0) {
			const row = contentEl.createDiv({ cls: "ww-row" });
			row.createDiv({ cls: "ww-row-label", text: T.noteTags() });
			const chips = row.createDiv({ cls: "ww-chips" });
			for (const tag of noteTags) chip(chips, tag);
		}
		contentEl.createDiv({ cls: "ww-hint", text: T.folderNote() });
		this.focusRow = null;
	}

	private async save(write: () => Promise<void>, row: "own" | "folder") {
		await write();
		this.focusRow = row;
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ---------- Tag search ---------- */

interface Query {
	include: string[];
	exclude: string[];
	words: string[];
	notWords: string[];
	/** The tag being typed at the end of the query, for suggestions. */
	partialTag: string | null;
}

export function parseQuery(text: string): Query {
	const q: Query = { include: [], exclude: [], words: [], notWords: [], partialTag: null };
	const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
	tokens.forEach((token, i) => {
		const negative = token.startsWith("-") && token.length > 1;
		const body = negative ? token.slice(1) : token;
		if (body.startsWith("#")) {
			const tag = body.slice(1).toLowerCase();
			if (i === tokens.length - 1 && !/\s$/.test(text)) q.partialTag = tag;
			if (tag) (negative ? q.exclude : q.include).push(tag);
		} else {
			(negative ? q.notWords : q.words).push(body.toLowerCase());
		}
	});
	return q;
}

/** "chemistry" matches the tag "Chemistry" and nested tags such as "Chemistry/organic". */
function hasTag(tags: string[], wanted: string): boolean {
	return tags.some((t) => {
		const lower = t.toLowerCase();
		return lower === wanted || lower.startsWith(wanted + "/");
	});
}

type SearchItem =
	| { kind: "tag"; tag: string; count: number }
	| { kind: "file"; file: TFile; tags: string[] }
	| { kind: "more"; count: number };

export class TagSearchModal extends SuggestModal<SearchItem> {
	constructor(app: App, private store: FileTagStore, private initial = "") {
		super(app);
		this.setPlaceholder(T.searchPlaceholder());
		this.emptyStateText = T.searchEmpty();
		this.limit = RESULT_LIMIT + 50;
		this.modalEl.addClass("ww-search");
	}

	async onOpen() {
		await super.onOpen();
		if (this.initial) {
			this.inputEl.value = this.initial;
			this.inputEl.dispatchEvent(new Event("input"));
		}
	}

	getSuggestions(text: string): SearchItem[] {
		const q = parseQuery(text);
		const index = this.store.index();
		const out: SearchItem[] = [];

		// While a tag is being typed, offer the tags that start with it.
		if (q.partialTag !== null) {
			const typed = q.partialTag;
			const tags = [...index]
				.filter(([tag]) => tag.toLowerCase().startsWith(typed) && tag.toLowerCase() !== typed)
				.sort((a, b) => b[1].length - a[1].length)
				.slice(0, 8);
			for (const [tag, paths] of tags) out.push({ kind: "tag", tag, count: paths.length });
		}
		if (q.include.length === 0 && q.words.length === 0) return out;

		// Start from the smallest required tag's files, or from every file.
		let candidates: TFile[];
		if (q.include.length > 0) {
			const sets = q.include.map((wanted) => {
				const paths = new Set<string>();
				for (const [tag, list] of index) {
					const lower = tag.toLowerCase();
					if (lower === wanted || lower.startsWith(wanted + "/")) list.forEach((p) => paths.add(p));
				}
				return paths;
			});
			sets.sort((a, b) => a.size - b.size);
			candidates = [...sets[0]]
				.map((p) => this.app.vault.getFileByPath(p))
				.filter((f): f is TFile => f !== null);
		} else {
			candidates = this.app.vault.getFiles();
		}

		const files: { file: TFile; tags: string[] }[] = [];
		for (const file of candidates) {
			const tags = this.store.allTagsOf(file.path);
			if (!q.include.every((t) => hasTag(tags, t))) continue;
			if (q.exclude.some((t) => hasTag(tags, t))) continue;
			const name = file.path.toLowerCase();
			if (!q.words.every((w) => name.includes(w))) continue;
			if (q.notWords.some((w) => name.includes(w))) continue;
			files.push({ file, tags });
		}
		files.sort((a, b) => a.file.name.localeCompare(b.file.name));
		for (const f of files.slice(0, RESULT_LIMIT)) out.push({ kind: "file", ...f });
		if (files.length > RESULT_LIMIT) out.push({ kind: "more", count: files.length - RESULT_LIMIT });
		return out;
	}

	renderSuggestion(item: SearchItem, el: HTMLElement) {
		el.addClass("ww-result");
		if (item.kind === "tag") {
			el.addClass("is-tag");
			setIcon(el.createSpan({ cls: "ww-result-icon" }), "tag");
			el.createSpan({ cls: "ww-result-name", text: item.tag });
			el.createSpan({ cls: "ww-result-meta", text: T.tagCount(item.count) });
			return;
		}
		if (item.kind === "more") {
			el.addClass("is-more");
			el.setText(T.searchMore(item.count));
			return;
		}
		const { file, tags } = item;
		setIcon(el.createSpan({ cls: "ww-result-icon" }), file.extension === "md" ? "file-text" : file.extension === "pdf" ? "file-type" : "file");
		const body = el.createDiv({ cls: "ww-result-body" });
		body.createDiv({ cls: "ww-result-name", text: file.extension === "md" ? file.basename : file.name });
		body.createDiv({ cls: "ww-result-path", text: folderOf(file.path) || T.vaultRoot() });
		const chips = body.createDiv({ cls: "ww-chips" });
		for (const tag of tags.slice(0, 8)) chip(chips, tag);
	}

	/** Picking a tag completes it in the query instead of closing the search. */
	selectSuggestion(item: SearchItem, evt: MouseEvent | KeyboardEvent) {
		if (item.kind === "tag") {
			const text = this.inputEl.value.replace(/(-?#)[^\s#]*$/, `$1${item.tag} `);
			this.inputEl.value = text;
			this.inputEl.dispatchEvent(new Event("input"));
			this.inputEl.focus();
			return;
		}
		if (item.kind === "more") return;
		super.selectSuggestion(item, evt);
	}

	onChooseSuggestion(item: SearchItem, evt: MouseEvent | KeyboardEvent) {
		if (item.kind !== "file") return;
		void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(item.file);
	}
}

export function isFolderPath(app: App, path: string): boolean {
	return path === "" || app.vault.getAbstractFileByPath(path) instanceof TFolder;
}
