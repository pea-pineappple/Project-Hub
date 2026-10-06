import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 확장 ID 변경(pecuniaestai.claude-project-hub → pecuniaestai.projecthub) 대응.
 *
 * ID가 바뀌면 VS Code는 다른 확장으로 취급해 globalState와 globalStorage 폴더가 새로 시작된다.
 * - 프로젝트 목록은 ~/.project-hub/에 있어 영향 없음
 * - 허브 워크스페이스는 파일명으로 이전 위치를 인식하는 기존 마이그레이션(isLegacyHubWindow)이 처리
 * - globalStorage의 아바타 이미지는 여기서 한 번 복사 (globalState는 다른 확장 것이라 읽을 수 없음)
 * - 옛 확장이 같이 설치돼 있으면 사이드바·명령·알림 포트가 겹치므로 제거를 안내
 */
const OLD_ID = 'pecuniaestai.claude-project-hub';
const MIGRATED_KEY = 'projectHub.migratedFromOldId';

export function migrateFromOldId(context: vscode.ExtensionContext): void {
    if (!context.globalState.get<boolean>(MIGRATED_KEY)) {
        try {
            // globalStorage는 <User>/globalStorage/<소문자 확장 ID>/ 형태로 나란히 있다
            const oldDir = path.join(path.dirname(context.globalStorageUri.fsPath), OLD_ID);
            const oldAvatars = path.join(oldDir, 'avatars');
            const newAvatars = path.join(context.globalStorageUri.fsPath, 'avatars');
            if (fs.existsSync(oldAvatars) && !fs.existsSync(newAvatars)) {
                fs.mkdirSync(path.dirname(newAvatars), { recursive: true });
                fs.cpSync(oldAvatars, newAvatars, { recursive: true });
            }
        } catch {
            // 복사 실패는 치명적이지 않음 — 아바타만 기본값으로 보인다
        }
        void context.globalState.update(MIGRATED_KEY, true);
    }

    if (vscode.extensions.getExtension(OLD_ID)) {
        const open = vscode.l10n.t('Show Extension');
        vscode.window
            .showWarningMessage(
                vscode.l10n.t(
                    'The old "Project Hub for Claude Code" ({0}) is still installed. It conflicts with this version (same sidebar, commands and notification port). Please uninstall it.',
                    OLD_ID
                ),
                open
            )
            .then(pick => {
                if (pick === open) {
                    void vscode.commands.executeCommand('workbench.extensions.search', `@installed ${OLD_ID}`);
                }
            });
    }
}
