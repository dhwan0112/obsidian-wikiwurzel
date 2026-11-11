/**
 * What Wikiwurzel offers other plugins (Wikiblatt draws its tag card with it).
 *
 * Wikiwurzel hands this object out through workspace events, so no plugin has to reach
 * into Obsidian's private plugin registry:
 *
 *   "wikiwurzel:request"  sent by another plugin when it wants the API
 *   "wikiwurzel:ready"    sent by Wikiwurzel with the API, once its tags are loaded,
 *                         and again in answer to every request
 *   "wikiwurzel:changed"  sent after any tag changes
 *   "wikiwurzel:unload"   sent when Wikiwurzel is turned off; drop the API then
 *
 * Bump API_VERSION when a member changes meaning or is removed.
 */
export const API_VERSION = 1;

export const EVENT_REQUEST = "wikiwurzel:request";
export const EVENT_READY = "wikiwurzel:ready";
export const EVENT_CHANGED = "wikiwurzel:changed";
export const EVENT_UNLOAD = "wikiwurzel:unload";

export interface WurzelApi {
	version: number;
	/** Tags written for this file itself. */
	ownTags(path: string): string[];
	/** Tags written for a folder ("" = vault root); they apply to everything below it. */
	folderTags(folder: string): string[];
	/** Folder tags that reach `folder` from the folders above it. */
	inheritedTags(folder: string): { tag: string; from: string }[];
	/** Every tag a file carries: its own, its folders', and for notes their #tags. */
	allTagsOf(path: string): string[];
	/** Tag -> paths of the files that carry it, notes and other files together. */
	index(): Map<string, string[]>;
	setOwn(path: string, tags: string[]): Promise<void>;
	setFolder(folder: string, tags: string[]): Promise<void>;
	/** Open the tag search, optionally with a query such as "#Chemistry". */
	openSearch(query?: string): void;
	/** Open the tag editor for a file or folder. */
	openEditor(path: string): void;
}
