import * as vscode from 'vscode';
import { hasClaudeSessions } from './claudeSessions';

export interface AgentDef {
    id: string;
    label: string;
    /** 빈 문자열이면 명령 없이 셸만 연다 (범용 터미널) */
    command: string;
    /** 마지막 세션을 이어서 여는 전체 명령. 비우면 resume 미지원 → command로 새 세션 */
    resumeCommand?: string;
    /** 특정 세션을 이어서 여는 명령 템플릿 ({sessionId} 치환). 비우면 세션 지정 재개 미지원 */
    resumeSessionCommand?: string;
}

const FALLBACK: AgentDef[] = [
    {
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        resumeCommand: 'claude --continue',
        resumeSessionCommand: 'claude --resume {sessionId}'
    }
];

/** 알려진 에이전트의 기본값 — 사용자가 agents 배열을 부분적으로만 적어도 누락 필드를 보충 */
const DEFAULT_BY_ID: Record<string, Partial<AgentDef>> = {
    claude: {
        label: 'Claude',
        resumeCommand: 'claude --continue',
        resumeSessionCommand: 'claude --resume {sessionId}'
    },
    gemini: { label: 'Gemini', resumeCommand: 'gemini --resume' },
    codex: { label: 'Codex', resumeCommand: 'codex resume --last' },
    // Antigravity CLI(agy): --continue는 워크스페이스(cwd)별 마지막 대화를 이어간다
    antigravity: {
        label: 'Antigravity',
        resumeCommand: 'agy --continue',
        resumeSessionCommand: 'agy --conversation {sessionId}'
    },
    opencode: {
        label: 'OpenCode',
        resumeCommand: 'opencode --continue',
        resumeSessionCommand: 'opencode --session {sessionId}'
    },
    // 범용 터미널: 에이전트 CLI 없이 프로젝트 cwd의 셸만 연다
    terminal: { label: 'Terminal' }
};

export function getAgents(): AgentDef[] {
    const config = vscode.workspace.getConfiguration('projectHub');
    let agents = (config.get<AgentDef[]>('agents') ?? FALLBACK)
        .filter(a => a && a.id && typeof a.command === 'string')
        .map(a => ({ ...DEFAULT_BY_ID[a.id], ...a, label: a.label || DEFAULT_BY_ID[a.id]?.label || a.id }));
    if (agents.length === 0) {
        return FALLBACK;
    }
    // 구버전 설정 호환: projectHub.claudeCommand를 커스터마이즈했던 경우
    // 새 세션 명령과 이어가기 명령 모두에 반영 (커스텀 경로/플래그 유실 방지)
    const legacy = config.get<string>('claudeCommand', 'claude');
    if (legacy && legacy !== 'claude') {
        agents = agents.map(a =>
            a.id === 'claude' && a.command === 'claude'
                ? {
                      ...a,
                      command: legacy,
                      resumeCommand:
                          a.resumeCommand === 'claude --continue' ? `${legacy} --continue` : a.resumeCommand,
                      resumeSessionCommand:
                          a.resumeSessionCommand === 'claude --resume {sessionId}'
                              ? `${legacy} --resume {sessionId}`
                              : a.resumeSessionCommand
                  }
                : a
        );
    }
    return agents;
}

/**
 * 이전 세션 존재를 실제로 확인할 수 있는 에이전트인지.
 * 전환 시 자동 시작 같은 비대화형 경로에서는 확인 불가능한 에이전트에
 * resume 명령을 보내지 않는다 (세션이 없으면 오류로 종료될 수 있으므로).
 */
export function canVerifySessions(agent: AgentDef): boolean {
    return agent.id === 'claude';
}

export function getAgent(id: string): AgentDef | undefined {
    return getAgents().find(a => a.id === id);
}

export function getAgentLabel(id: string): string {
    return getAgent(id)?.label ?? id;
}

export function getDefaultAgent(): AgentDef {
    const id = vscode.workspace.getConfiguration('projectHub').get<string>('defaultAgent', 'claude');
    return getAgent(id) ?? getAgents()[0];
}

/**
 * 실행할 명령 결정. resume 요청 시 resumeCommand를 사용하되,
 * claude는 이전 세션 존재 여부까지 확인해서 없으면 새 세션 명령으로 대체한다
 * (claude --continue는 이어갈 대화가 없으면 오류로 종료되므로).
 */
export function resolveCommand(agent: AgentDef, resume: boolean, projectPath: string): string {
    if (!resume || !agent.resumeCommand) {
        return agent.command;
    }
    if (agent.id === 'claude' && !hasClaudeSessions(projectPath)) {
        return agent.command;
    }
    return agent.resumeCommand;
}

/** 특정 세션을 이어서 여는 명령 (미지원 에이전트는 undefined) */
export function resolveSessionCommand(agent: AgentDef, sessionId: string): string | undefined {
    return agent.resumeSessionCommand?.replace('{sessionId}', sessionId);
}

/**
 * 저장된 세션 목록을 조회하고 세션을 지정해 재개할 수 있는 에이전트인지.
 * 세션 파일 저장 위치를 아는 claude만 지원 (다른 에이전트는 목록 조회 불가).
 */
export function canPickSessions(agent: AgentDef): boolean {
    return agent.id === 'claude' && !!agent.resumeSessionCommand;
}
