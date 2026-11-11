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
	graphTitle: () => (ko() ? "태그 그래프" : "Tag graph"),
	graphBack: () => (ko() ? "현재 파일로" : "Back to the current file"),
	graphFit: () => (ko() ? "전체 보기" : "Fit"),
	graphNoFile: () => (ko() ? "열린 파일이 없습니다." : "No file is open."),
	graphNoTags: () => (ko() ? "이 파일에는 태그가 없습니다. 오른쪽 클릭 → 태그 편집으로 붙여 보세요." : "This file has no tags yet. Right-click it and choose Edit tags."),
	cmdGraph: () => (ko() ? "태그 그래프 열기" : "Open tag graph"),
	globalTitle: () => (ko() ? "위키 그래프" : "Wiki graph"),
	globalFilter: () => (ko() ? "#태그, -#제외, 경로로 거르기" : "Filter: #tag, -#tag, path"),
	globalTags: () => (ko() ? "태그" : "Tags"),
	globalOrphans: () => (ko() ? "연결 없는 파일" : "Orphans"),
	globalLinks: () => (ko() ? "노트 링크" : "Note links"),
	globalDense: () => (ko() ? "모든 상위 태그에 연결" : "Link every inherited tag"),
	globalRelayout: () => (ko() ? "다시 배치" : "Lay out again"),
	globalStatus: (n: number, e: number) => (ko() ? `노드 ${n} · 연결 ${e}` : `${n} nodes · ${e} links`),
	cmdGlobal: () => (ko() ? "위키 그래프 열기" : "Open wiki graph"),
	cmdReload: () => (ko() ? "태그 파일 다시 읽기" : "Reload tag files"),
};
