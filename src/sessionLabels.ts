import * as vscode from 'vscode';

/**
 * 세션 ID → 사람이 읽는 이름 매핑 (globalState 영속).
 * 터미널 이름(`agent · 프로젝트 · 태그`)이 창 리로드 후 재인식의 기준이므로,
 * 태그를 세션 이름으로 쓰려면 같은 세션 ID가 항상 같은 이름으로 재구성되어야 한다.
 * 이름 출처: 세션 목록의 미리보기(요약/첫 메시지) 또는 세션의 첫 프롬프트.
 */

const KEY = 'projectHub.sessionLabels';
const MAX_ENTRIES = 300;

let memento: vscode.Memento | undefined;

export function initSessionLabels(context: vscode.ExtensionContext): void {
    memento = context.globalState;
}

export function sessionLabel(sessionId: string): string | undefined {
    return memento?.get<Record<string, string>>(KEY, {})[sessionId];
}

export function setSessionLabel(sessionId: string, label: string): void {
    if (!memento || !label) {
        return;
    }
    const map = { ...memento.get<Record<string, string>>(KEY, {}) };
    map[sessionId] = label;
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
        for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) {
            delete map[k];
        }
    }
    void memento.update(KEY, map);
}

/** 터미널 이름 태그: 세션 이름이 있으면 이름, 없으면 ID 앞 8자리 */
export function sessionTag(sessionId: string): string {
    return sessionLabel(sessionId) ?? sessionId.slice(0, 8);
}

/** 터미널 이름에 넣을 수 있게 정리 (공백 압축, 구분자 '·' 제거, 길이 제한) */
export function sanitizeLabel(text: string, max = 16): string {
    const clean = text.replace(/\s+/g, ' ').replace(/·/g, '-').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
