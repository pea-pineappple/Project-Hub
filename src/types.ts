export interface Project {
    name: string;
    path: string;
    /** 식별 색상 (hex). 없으면 이름 해시로 자동 지정 */
    color?: string;
}

export type ProjectStatus = 'idle' | 'working' | 'done' | 'attention';

/**
 * 에이전트 세션 하나의 상태. 같은 에이전트(예: Claude)를 한 프로젝트에서
 * 여러 개 띄우면 hook 페이로드의 session_id로 구분되어 각각 추적된다.
 * session_id를 주지 않는 에이전트는 'default' 세션 하나로 합쳐진다.
 */
export interface AgentSessionStatus {
    agentId: string;
    sessionId: string;
    status: ProjectStatus;
    /** 무슨 작업인지 (UserPromptSubmit hook의 프롬프트 텍스트) */
    detail?: string;
}

import { l10n } from 'vscode';

export const STATUS_LABEL: Record<ProjectStatus, string> = {
    idle: '',
    working: l10n.t('working…'),
    done: l10n.t('done'),
    attention: l10n.t('waiting for response')
};
