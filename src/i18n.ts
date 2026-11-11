import { moment } from "obsidian";

const ko = () => moment.locale().startsWith("ko");

export const T = {
	searchPlaceholder: () =>
		ko() ? "#태그, -#제외할태그, 파일 이름 (예: #Chemistry #CM2112 보고서)" : "#tag, -#excluded, file name (e.g. #Chemistry #CM2112 report)",
	searchEmpty: () => (ko() ? "찾는 파일이 없습니다." : "No matching files."),
	searchMore: (n: number) => (ko() ? `외 ${n}개. 검색어를 좁혀 보세요.` : `${n} more. Narrow the search.`),
	tagCount: (n: number) => (ko() ? `${n}개 파일` : `${n} files`),
	editTitle: () => (ko() ? "태그 편집" : "Edit tags"),
	thisFile: () => (ko() ? "이 파일" : "This file"),
	thisFolder: () => (ko() ? "이 폴더" : "This folder"),
	folder: (name: string) => (ko() ? `폴더: ${name}` : `Folder: ${name}`),
	inherited: () => (ko() ? "상위 폴더" : "Inherited"),
	noteTags: () => (ko() ? "노트 안의 #태그" : "#tags in the note"),
	addTag: () => (ko() ? "태그 추가" : "Add tag"),
	removeTag: (tag: string) => (ko() ? `${tag} 제거` : `Remove ${tag}`),
	vaultRoot: () => (ko() ? "보관함 루트" : "Vault root"),
	folderNote: () =>
		ko() ? "폴더 태그는 이 폴더와 하위 폴더의 모든 파일에 적용됩니다." : "Folder tags apply to every file in this folder and below.",
	cmdSearch: () => (ko() ? "태그로 파일 찾기" : "Search files by tag"),
	cmdEdit: () => (ko() ? "현재 파일의 태그 편집" : "Edit tags of the current file"),
	cmdReload: () => (ko() ? "태그 파일 다시 읽기" : "Reload tag files"),
};
