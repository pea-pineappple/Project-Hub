import * as vscode from 'vscode';
import * as fs from 'fs';
import { normalizePath, isWithin } from './paths';

interface SavedEditor {
    uri: string;
    viewColumn: number;
    active: boolean;
}

const KEY = 'projectHub.editorState';

/**
 * 프로젝트별 열린 에디터 탭 저장/복원.
 * 전환 시: 나가는 프로젝트의 탭 목록을 저장하고 닫은 뒤, 들어오는 프로젝트의 저장된 탭을 다시 연다.
 * - 일반 텍스트 에디터 탭만 대상 (diff/웹뷰/노트북 등 특수 탭 제외)
 * - 저장 안 된(dirty) 탭은 데이터 손실 방지를 위해 닫지 않고 남겨둔다
 */
export class EditorStateStore {
    constructor(private context: vscode.ExtensionContext) {}

    private load(): Record<string, SavedEditor[]> {
        return this.context.globalState.get<Record<string, SavedEditor[]>>(KEY, {});
    }

    private collect(projectPath: string): Array<{ tab: vscode.Tab; saved: SavedEditor }> {
        const result: Array<{ tab: vscode.Tab; saved: SavedEditor }> = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (!(tab.input instanceof vscode.TabInputText)) {
                    continue;
                }
                const uri = tab.input.uri;
                if (uri.scheme !== 'file' || !isWithin(projectPath, uri.fsPath)) {
                    continue;
                }
                result.push({
                    tab,
                    saved: {
                        uri: uri.toString(),
                        viewColumn: group.viewColumn,
                        active: tab.isActive && group.isActive
                    }
                });
            }
        }
        return result;
    }

    /** 나가는 프로젝트의 열린 에디터 목록 저장 */
    async save(projectPath: string): Promise<void> {
        const all = this.load();
        all[normalizePath(projectPath)] = this.collect(projectPath).map(e => e.saved);
        await this.context.globalState.update(KEY, all);
    }

    /** 나간 프로젝트의 에디터 탭 닫기 */
    async closeTabs(projectPath: string): Promise<void> {
        const tabs = this.collect(projectPath)
            .map(e => e.tab)
            .filter(t => !t.isDirty);
        if (tabs.length) {
            await vscode.window.tabGroups.close(tabs, true);
        }
    }

    /** 들어오는 프로젝트의 저장된 에디터 복원 (활성이었던 탭을 마지막에 열어 포커스 유지) */
    async restore(projectPath: string): Promise<void> {
        const saved = this.load()[normalizePath(projectPath)] ?? [];
        const ordered = [...saved.filter(e => !e.active), ...saved.filter(e => e.active)];
        for (const entry of ordered) {
            try {
                const uri = vscode.Uri.parse(entry.uri);
                if (!fs.existsSync(uri.fsPath)) {
                    continue;
                }
                await vscode.window.showTextDocument(uri, {
                    viewColumn: entry.viewColumn,
                    preview: false,
                    preserveFocus: !entry.active
                });
            } catch {
                // 삭제되었거나 열 수 없는 파일은 건너뜀
            }
        }
    }
}
