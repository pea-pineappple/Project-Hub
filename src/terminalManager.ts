import * as vscode from 'vscode';
import { Project } from './types';
import { normalizePath, isWithin } from './paths';
import { AgentDef, getAgents, getDefaultAgent, resolveCommand, resolveSessionCommand } from './agents';
import { sessionTag } from './sessionLabels';
import { wrapForPersistence } from './remotePersist';

const AGENT_ICONS: Record<string, string> = {
    claude: 'sparkle',
    gemini: 'flame',
    codex: 'circuit-board',
    antigravity: 'rocket',
    opencode: 'code',
    terminal: 'terminal'
};

/**
 * 셸이 입력을 받을 준비가 된 뒤에 명령을 보낸다.
 * 새로 만든 터미널에 곧바로 sendText하면 PowerShell(PSReadLine)이 뜨는 도중이라
 * 첫 글자가 잘려 "laude --continue"처럼 실행되는 문제가 있다.
 * shell integration이 활성화되면 그 시점에 보내고, 끝내 안 오면(cmd.exe 등) 일정 시간 뒤 보낸다.
 */
export function sendWhenReady(terminal: vscode.Terminal, text: string, timeoutMs = 4000): void {
    if (terminal.shellIntegration) {
        terminal.sendText(text, true);
        return;
    }
    let done = false;
    const send = () => {
        if (done) {
            return;
        }
        done = true;
        listener.dispose();
        clearTimeout(timer);
        if (terminal.exitStatus === undefined) {
            terminal.sendText(text, true);
        }
    };
    const listener = vscode.window.onDidChangeTerminalShellIntegration(e => {
        if (e.terminal === terminal) {
            // 프롬프트가 완전히 그려질 여유를 조금 둔다
            setTimeout(send, 200);
        }
    });
    const timer = setTimeout(send, timeoutMs);
}

export class TerminalManager {
    /**
     * key: `${agentId}:${normalizedPath}` (기본 터미널)
     *      `${agentId}@${sessionId}:${normalizedPath}` (세션 지정 터미널 — 같은 에이전트 다중 실행)
     */
    private terminals = new Map<string, vscode.Terminal>();

    constructor(
        context: vscode.ExtensionContext,
        private onAgentTerminalClosed?: (agentId: string, projectPath: string, sessionId?: string) => void
    ) {
        context.subscriptions.push(
            vscode.window.onDidCloseTerminal(t => {
                for (const [key, term] of this.terminals) {
                    if (term === t) {
                        this.terminals.delete(key);
                        // Windows 경로에 드라이브 콜론이 있으므로 첫 콜론에서만 분리
                        const i = key.indexOf(':');
                        const agentPart = key.slice(0, i);
                        const at = agentPart.indexOf('@');
                        this.onAgentTerminalClosed?.(
                            at < 0 ? agentPart : agentPart.slice(0, at),
                            key.slice(i + 1),
                            at < 0 ? undefined : agentPart.slice(at + 1)
                        );
                    }
                }
            })
        );
    }

    private key(agentId: string, projectPath: string, sessionId?: string): string {
        const agentPart = sessionId ? `${agentId}@${sessionId}` : agentId;
        return `${agentPart}:${normalizePath(projectPath)}`;
    }

    private terminalName(agentId: string, project: Project, sessionId?: string): string {
        // 세션 태그는 세션 이름(있으면) 또는 ID 앞 8자리 — sessionLabels가 영속이라
        // 창 리로드 후에도 같은 이름이 재구성되어 재인식이 유지된다
        return sessionId
            ? `${agentId} · ${project.name} · ${sessionTag(sessionId)}`
            : `${agentId} · ${project.name}`;
    }

    private getManaged(project: Project, agentId: string, sessionId?: string): vscode.Terminal | undefined {
        const key = this.key(agentId, project.path, sessionId);
        const t = this.terminals.get(key);
        if (t && t.exitStatus === undefined) {
            return t;
        }
        // 창 리로드 후에는 맵이 비지만 터미널은 persistent session으로 복원되어 살아 있다.
        // 이때 못 알아보면 전환할 때마다 새 터미널을 또 만들게 되므로(누적 + 에이전트
        // 중복 실행) 이름 규칙으로 다시 인식해 맵에 재등록한다.
        const name = this.terminalName(agentId, project, sessionId);
        const adopted = vscode.window.terminals.find(x => x.exitStatus === undefined && x.name === name);
        if (adopted) {
            this.terminals.set(key, adopted);
        }
        return adopted;
    }

    /** 프로젝트×에이전트의 살아 있는 관리 터미널 (기본 우선, 없으면 세션 터미널) */
    private findManaged(project: Project, agentId: string): vscode.Terminal | undefined {
        const suffix = `:${normalizePath(project.path)}`;
        const exact = this.terminals.get(`${agentId}${suffix}`);
        if (exact && exact.exitStatus === undefined) {
            return exact;
        }
        for (const [key, t] of this.terminals) {
            if (key.endsWith(suffix) && key.startsWith(`${agentId}@`) && t.exitStatus === undefined) {
                return t;
            }
        }
        // 창 리로드로 복원된 터미널을 이름 규칙으로 재인식 (기본 터미널 우선, 세션 터미널 차선)
        const base = this.terminalName(agentId, project);
        let sessionCandidate: vscode.Terminal | undefined;
        for (const t of vscode.window.terminals) {
            if (t.exitStatus !== undefined) {
                continue;
            }
            if (t.name === base) {
                this.terminals.set(`${agentId}${suffix}`, t);
                return t;
            }
            if (!sessionCandidate && t.name.startsWith(`${base} · `)) {
                sessionCandidate = t;
            }
        }
        if (sessionCandidate) {
            const tag = sessionCandidate.name.slice(base.length + 3);
            this.terminals.set(this.key(agentId, project.path, tag), sessionCandidate);
        }
        return sessionCandidate;
    }

    /** 프로젝트×에이전트의 관리 터미널(세션 터미널 포함)이 하나라도 살아 있는지 */
    hasLiveAgentTerminal(agentId: string, project: Project): boolean {
        return !!this.findManaged(project, agentId);
    }

    /**
     * 지시 보내기 등 외부에서 살아 있는 터미널을 직접 얻을 때.
     * sessionId를 주면 그 세션 전용 터미널 우선, 없으면 해당 에이전트의 아무 터미널.
     */
    findLive(project: Project, agentId: string, sessionId?: string): vscode.Terminal | undefined {
        if (sessionId && sessionId !== 'default') {
            const t = this.getManaged(project, agentId, sessionId);
            if (t) {
                return t;
            }
        }
        return this.findManaged(project, agentId);
    }

    /** 프로젝트의 관리 터미널이 하나라도 살아 있는지 (백그라운드 프로세스 노드 표시 여부) */
    hasAnyManaged(project: Project): boolean {
        return getAgents().some(agent => this.findManaged(project, agent.id));
    }

    /** 모든 프로젝트의 살아 있는 관리 터미널 + cwd가 프로젝트 안인 터미널 (그리드 배치용) */
    allLiveTerminals(projects: Project[]): vscode.Terminal[] {
        // 창 리로드로 복원된 터미널을 먼저 이름 규칙으로 재인식
        for (const p of projects) {
            for (const a of getAgents()) {
                this.findManaged(p, a.id);
            }
        }
        const out: vscode.Terminal[] = [];
        const seen = new Set<vscode.Terminal>();
        for (const p of projects) {
            const suffix = `:${normalizePath(p.path)}`;
            for (const [key, t] of this.terminals) {
                if (key.endsWith(suffix) && t.exitStatus === undefined && !seen.has(t)) {
                    seen.add(t);
                    out.push(t);
                }
            }
        }
        // 관리 목록 밖이라도 cwd가 등록 프로젝트 안이면 포함
        // (cmd.exe는 shell integration이 없어 생성 시 cwd로만 판별 가능)
        for (const t of vscode.window.terminals) {
            if (t.exitStatus !== undefined || seen.has(t)) {
                continue;
            }
            const opts = t.creationOptions as vscode.TerminalOptions;
            const raw = t.shellIntegration?.cwd?.fsPath ?? opts.cwd;
            const cwd = typeof raw === 'string' ? raw : raw?.fsPath;
            if (cwd && projects.some(p => isWithin(p.path, cwd))) {
                seen.add(t);
                out.push(t);
            }
        }
        return out;
    }

    /**
     * 사용자가 직접 연 터미널을 프로젝트×에이전트 소속으로 수동 편입.
     * 반환된 이름으로 터미널 이름을 바꾸면 창 리로드 후에도 재인식된다.
     */
    adoptTerminal(project: Project, agentId: string, terminal: vscode.Terminal): string {
        const tag = Math.random().toString(36).slice(2, 8);
        this.terminals.set(this.key(agentId, project.path, tag), terminal);
        return this.terminalName(agentId, project, tag);
    }

    /**
     * 이름 규칙에 맞는 살아 있는 관리 터미널 전부 (기본 + 세션 터미널).
     * VS Code를 완전히 재시작하면 셸만 복원되고 에이전트는 종료되므로 재실행 대상을 고를 때 쓴다.
     * tag는 세션 터미널의 이름 태그(세션 이름 또는 ID 앞 8자리).
     */
    namedTerminals(projects: Project[]): Array<{ terminal: vscode.Terminal; project: Project; agent: AgentDef; tag?: string }> {
        const out: Array<{ terminal: vscode.Terminal; project: Project; agent: AgentDef; tag?: string }> = [];
        for (const project of projects) {
            for (const agent of getAgents()) {
                const base = this.terminalName(agent.id, project);
                for (const t of vscode.window.terminals) {
                    if (t.exitStatus !== undefined) {
                        continue;
                    }
                    if (t.name === base) {
                        this.terminals.set(this.key(agent.id, project.path), t);
                        out.push({ terminal: t, project, agent });
                    } else if (t.name.startsWith(`${base} · `)) {
                        const tag = t.name.slice(base.length + 3);
                        this.terminals.set(this.key(agent.id, project.path, tag), t);
                        out.push({ terminal: t, project, agent, tag });
                    }
                }
            }
        }
        return out;
    }

    /** 프로젝트의 살아 있는 관리 터미널들의 셸 PID (백그라운드 프로세스 트리의 루트) */
    async getManagedPids(project: Project): Promise<number[]> {
        // 창 리로드 후 복원 터미널을 이름 규칙으로 먼저 재인식
        for (const agent of getAgents()) {
            this.findManaged(project, agent.id);
        }
        const suffix = `:${normalizePath(project.path)}`;
        const pids = new Set<number>();
        for (const [key, t] of this.terminals) {
            if (key.endsWith(suffix) && t.exitStatus === undefined) {
                const pid = await t.processId;
                if (pid) {
                    pids.add(pid);
                }
            }
        }
        return [...pids];
    }

    /**
     * 프로젝트에 속한 터미널 찾기.
     * 우선순위: 기본 에이전트의 관리 터미널 → 다른 에이전트의 관리 터미널
     * → shell integration이 보고하는 현재 cwd → 터미널 생성 시 지정된 cwd.
     * 사용자가 직접 연 터미널도 cwd가 프로젝트 안이면 잡힌다.
     */
    findForProject(project: Project): vscode.Terminal | undefined {
        const managedDefault = this.findManaged(project, getDefaultAgent().id);
        if (managedDefault) {
            return managedDefault;
        }
        for (const agent of getAgents()) {
            const managed = this.findManaged(project, agent.id);
            if (managed) {
                return managed;
            }
        }
        for (const t of vscode.window.terminals) {
            if (t.exitStatus !== undefined) {
                continue;
            }
            const liveCwd = t.shellIntegration?.cwd;
            if (liveCwd?.scheme === 'file' && isWithin(project.path, liveCwd.fsPath)) {
                return t;
            }
            const creationCwd = (t.creationOptions as vscode.TerminalOptions).cwd;
            const cwdPath = typeof creationCwd === 'string' ? creationCwd : creationCwd?.fsPath;
            if (cwdPath && isWithin(project.path, cwdPath)) {
                return t;
            }
        }
        return undefined;
    }

    /**
     * 프로젝트×에이전트 전용 터미널을 열거나 기존 터미널을 표시.
     * resume=true면 에이전트의 resumeCommand로 마지막 세션을 이어서 연다.
     * (이미 실행 중인 터미널이 있으면 세션이 살아 있는 것이므로 그대로 표시만 한다.)
     */
    /**
     * 새 터미널 위치. 설정에 따라 패널 대신 에디터 탭으로 열고,
     * 같은 프로젝트의 관리 터미널이 이미 살아 있으면 그 옆에 분할해서 연다
     * (탭 목록을 눌러 오가지 않고 여러 에이전트를 한 화면에서 보도록).
     */
    private location(project: Project): vscode.TerminalOptions['location'] {
        const config = vscode.workspace.getConfiguration('projectHub');
        // 프로젝트 그리드 모드에서는 확장이 곧바로 에디터 그리드로 옮기므로 패널에 단독으로 연다
        if (config.get<boolean>('projectTerminalGrid', true)) {
            return undefined;
        }
        if (config.get<boolean>('splitAgentTerminals', true)) {
            // 창 재시작 직후엔 맵이 비어 있으므로 복원된 터미널을 이름 규칙으로 먼저 재인식
            for (const a of getAgents()) {
                this.findManaged(project, a.id);
            }
            const suffix = `:${normalizePath(project.path)}`;
            for (const [key, t] of this.terminals) {
                if (key.endsWith(suffix) && t.exitStatus === undefined) {
                    return { parentTerminal: t };
                }
            }
        }
        return config.get<boolean>('terminalsInEditor', false) ? vscode.TerminalLocation.Editor : undefined;
    }

    open(project: Project, agent: AgentDef, resume = false, focus = true): void {
        let terminal = this.getManaged(project, agent.id);
        if (!terminal) {
            terminal = vscode.window.createTerminal({
                name: this.terminalName(agent.id, project),
                cwd: project.path,
                iconPath: new vscode.ThemeIcon(AGENT_ICONS[agent.id] ?? 'robot'),
                location: this.location(project)
            });
            const command = wrapForPersistence(resolveCommand(agent, resume, project.path), project, agent.id);
            if (command) {
                sendWhenReady(terminal, command);
            }
            this.terminals.set(this.key(agent.id, project.path), terminal);
        }
        terminal.show(!focus);
    }

    /**
     * 특정 세션을 이어서 여는 전용 터미널. 세션별로 별도 터미널이 생기므로
     * 같은 에이전트를 한 프로젝트에서 여러 개 병행할 수 있다.
     */
    openSession(project: Project, agent: AgentDef, sessionId: string, focus = true): void {
        const command = resolveSessionCommand(agent, sessionId);
        if (!command) {
            this.open(project, agent, true, focus);
            return;
        }
        let terminal = this.getManaged(project, agent.id, sessionId);
        if (!terminal) {
            terminal = vscode.window.createTerminal({
                name: this.terminalName(agent.id, project, sessionId),
                cwd: project.path,
                iconPath: new vscode.ThemeIcon(AGENT_ICONS[agent.id] ?? 'robot'),
                location: this.location(project)
            });
            sendWhenReady(terminal, wrapForPersistence(command, project, agent.id, sessionId));
            this.terminals.set(this.key(agent.id, project.path, sessionId), terminal);
        }
        terminal.show(!focus);
    }

    /** 해당 세션 전용 관리 터미널이 살아 있으면 반환 (창 리로드로 복원된 터미널 포함) */
    findSessionTerminal(project: Project, agentId: string, sessionId: string): vscode.Terminal | undefined {
        return this.getManaged(project, agentId, sessionId);
    }
}
