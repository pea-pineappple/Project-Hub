import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AgentSessionStatus, Project, ProjectStatus } from './types';
import { normalizePath, samePath, isWithin } from './paths';

const STORE_KEY = 'projectHub.projects';
const ANCHOR_LABEL = '⌂ Hub';

/**
 * 프로젝트 리스트는 익스텐션 ID(퍼블리셔)와 무관한 파일에 저장한다.
 * globalState는 익스텐션 ID별로 분리되어 퍼블리셔 변경/재설치 시 리스트가 사라지기 때문.
 */
const PROJECTS_FILE = path.join(os.homedir(), '.project-hub', 'projects.json');

/**
 * globalState 백업 키. 원격(SSH 등) 창의 globalState는 로컬 PC 쪽 저장소를 함께 쓰므로,
 * 같은 키를 쓰면 원격 서버에 로컬 Windows 프로젝트 목록이 옮겨 오고(반대로 덮어쓰기도 됨)
 * "Folder does not exist: c:\…" 오류가 난다. 원격이면 호스트별로 키를 나눈다.
 */
function backupKey(): string {
    return vscode.env.remoteName ? `${STORE_KEY}@${vscode.env.remoteName}:${os.hostname()}` : STORE_KEY;
}

/** 이 확장이 실행 중인 OS 형식의 절대 경로인지 (Windows 창에 /home/…, 리눅스 원격에 c:\… 가 섞이지 않게) */
function isNativePath(p: string): boolean {
    const windowsStyle = /^[a-zA-Z]:[\\/]|^\\\\/.test(p);
    return process.platform === 'win32' ? windowsStyle : !windowsStyle && p.startsWith('/');
}

/** 허브 .code-workspace 파일 경로 (모든 창이 동일 경로를 참조) */
export function getHubWorkspaceFile(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'project-hub.code-workspace');
}

/**
 * 현재 창이 허브 워크스페이스를 열고 있는 창인지.
 * 파일명 기준으로도 인식해서, 이전 버전(다른 퍼블리셔 ID의 globalStorage)에
 * 만들어진 허브 워크스페이스도 허브 창으로 취급한다.
 */
export function isHubWindow(context: vscode.ExtensionContext): boolean {
    const wf = vscode.workspace.workspaceFile;
    if (!wf || wf.scheme !== 'file') {
        return false;
    }
    return (
        samePath(wf.fsPath, getHubWorkspaceFile(context)) ||
        path.basename(wf.fsPath).toLowerCase() === 'project-hub.code-workspace'
    );
}

export class ProjectManager {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    /**
     * path → (`${agentId}\n${sessionId}` → {status, detail})
     * 같은 에이전트를 한 프로젝트에서 여러 개 띄워도 세션별로 분리 추적된다.
     */
    private statuses = new Map<string, Map<string, { status: ProjectStatus; detail?: string }>>();

    private static sessionKey(agentId: string, sessionId: string): string {
        return `${agentId}\n${sessionId}`;
    }

    private static parseSessionKey(key: string): { agentId: string; sessionId: string } {
        const i = key.indexOf('\n');
        return { agentId: key.slice(0, i), sessionId: key.slice(i + 1) };
    }

    constructor(private context: vscode.ExtensionContext) {
        // 구버전(globalState 저장) 마이그레이션: 파일이 없고 globalState에 데이터가 있으면 파일로 이전
        if (!fs.existsSync(PROJECTS_FILE)) {
            const legacy = this.context.globalState.get<Project[]>(backupKey(), []).filter(p => isNativePath(p.path));
            if (legacy.length) {
                this.writeProjectsFile(legacy);
            }
        }
    }

    getProjects(): Project[] {
        try {
            if (fs.existsSync(PROJECTS_FILE)) {
                const data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
                if (Array.isArray(data?.projects)) {
                    return data.projects.filter((p: Project) => p && p.name && p.path && isNativePath(p.path));
                }
            }
        } catch {
            // 파일 손상 시 globalState 폴백
        }
        return this.context.globalState.get<Project[]>(backupKey(), []).filter(p => isNativePath(p.path));
    }

    private writeProjectsFile(projects: Project[]): void {
        fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
        fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ projects }, null, 2) + '\n');
    }

    private async saveProjects(projects: Project[]): Promise<void> {
        this.writeProjectsFile(projects);
        await this.context.globalState.update(backupKey(), projects);
        this._onDidChange.fire();
    }

    findByPath(p: string): Project | undefined {
        return this.getProjects().find(prj => samePath(prj.path, p));
    }

    /** cwd가 프로젝트 폴더 자체 또는 하위 폴더일 때 가장 깊게 일치하는 프로젝트 */
    findContaining(cwd: string): Project | undefined {
        const candidates = this.getProjects().filter(prj => isWithin(prj.path, cwd));
        candidates.sort((a, b) => b.path.length - a.path.length);
        return candidates[0];
    }

    async addProject(folderPath: string): Promise<Project | undefined> {
        if (this.findByPath(folderPath)) {
            return undefined;
        }
        const project: Project = { name: path.basename(folderPath), path: folderPath };
        await this.saveProjects([...this.getProjects(), project]);
        return project;
    }

    async removeProject(project: Project): Promise<void> {
        await this.saveProjects(this.getProjects().filter(p => !samePath(p.path, project.path)));
        this.statuses.delete(normalizePath(project.path));
    }

    /** 프로젝트 색상 지정/해제 */
    async setProjectColor(project: Project, color: string | undefined): Promise<void> {
        await this.saveProjects(
            this.getProjects().map(p => (samePath(p.path, project.path) ? { ...p, color } : p))
        );
    }

    /** srcPath 프로젝트를 beforePath 앞으로 이동 (beforePath 없으면 맨 뒤로) */
    async moveProject(srcPath: string, beforePath?: string): Promise<void> {
        const projects = this.getProjects();
        const from = projects.findIndex(p => samePath(p.path, srcPath));
        if (from < 0) {
            return;
        }
        const [moved] = projects.splice(from, 1);
        let to = beforePath ? projects.findIndex(p => samePath(p.path, beforePath)) : projects.length;
        if (to < 0) {
            to = projects.length;
        }
        projects.splice(to, 0, moved);
        await this.saveProjects(projects);
    }

    /**
     * 앵커 폴더: 워크스페이스의 첫 번째 폴더 자리를 영구히 차지하는 고정 폴더.
     * VS Code는 첫 번째 워크스페이스 폴더가 바뀌면 extension host를 재시작하므로
     * (Claude 연결 끊김, 사이드바 사라짐의 원인), 첫 자리를 이 폴더로 고정하고
     * 프로젝트는 두 번째 자리에서만 교체한다.
     */
    getAnchorDir(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'hub-home');
    }

    private ensureAnchorDir(): string {
        const dir = this.getAnchorDir();
        fs.mkdirSync(dir, { recursive: true });
        const readme = path.join(dir, 'README.md');
        if (!fs.existsSync(readme)) {
            fs.writeFileSync(
                readme,
                '# Project Hub\n\n' +
                'This folder pins the first workspace slot so projects can be switched without a window reload or extension host restart.\n' +
                'Do NOT remove it from the workspace — otherwise every switch restarts all extensions (including Claude Code).\n'
            );
        }
        return dir;
    }

    /** 현재 앵커 또는 이전 버전(다른 퍼블리셔 ID) 앵커인지 */
    isAnchorPath(p: string): boolean {
        if (samePath(p, this.getAnchorDir())) {
            return true;
        }
        const n = normalizePath(p);
        return path.basename(n) === 'hub-home' && n.includes(`${path.sep}globalstorage${path.sep}`);
    }

    /** 현재 Explorer에 표시 중인(활성) 프로젝트 경로 — 앵커 폴더는 제외 */
    getActivePath(): string | undefined {
        return vscode.workspace.workspaceFolders?.find(f => !this.isAnchorPath(f.uri.fsPath))?.uri.fsPath;
    }

    /** 이전 퍼블리셔 ID 위치의 허브 워크스페이스를 쓰고 있는 창인지 */
    isLegacyHubWindow(): boolean {
        const wf = vscode.workspace.workspaceFile;
        return (
            !!wf &&
            wf.scheme === 'file' &&
            path.basename(wf.fsPath).toLowerCase() === 'project-hub.code-workspace' &&
            !samePath(wf.fsPath, getHubWorkspaceFile(this.context))
        );
    }

    /** 허브 워크스페이스 파일을 새 위치로 이전하고 다시 연다 (창 1회 리로드) */
    async migrateLegacyHub(): Promise<void> {
        const active = this.getActivePath();
        const anchor = this.ensureAnchorDir();
        const folders: Array<{ name: string; path: string }> = [{ name: ANCHOR_LABEL, path: anchor }];
        if (active) {
            const project = this.findByPath(active);
            folders.push({ name: project?.name ?? path.basename(active), path: active });
        }
        const hubFile = getHubWorkspaceFile(this.context);
        fs.mkdirSync(path.dirname(hubFile), { recursive: true });
        fs.writeFileSync(hubFile, JSON.stringify({ folders }, null, 2));
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(hubFile), { forceReuseWindow: true });
    }

    isActive(project: Project): boolean {
        const active = this.getActivePath();
        return !!active && samePath(active, project.path);
    }

    /** 프로젝트의 에이전트×세션별 상태 목록 (idle 제외, 발생 순서 유지) */
    getAgentStatuses(project: Project): AgentSessionStatus[] {
        const perSession = this.statuses.get(normalizePath(project.path));
        if (!perSession) {
            return [];
        }
        return [...perSession].map(([key, v]) => ({
            ...ProjectManager.parseSessionKey(key),
            status: v.status,
            detail: v.detail
        }));
    }

    /** 트리 아이콘용 대표 상태: working > attention > done > idle */
    getStatus(project: Project): ProjectStatus {
        const all = [...(this.statuses.get(normalizePath(project.path))?.values() ?? [])].map(v => v.status);
        for (const s of ['working', 'attention', 'done'] as ProjectStatus[]) {
            if (all.includes(s)) {
                return s;
            }
        }
        return 'idle';
    }

    /**
     * detail(무슨 작업인지)은 함께 주어지면 갱신, 생략하면 이전 값 유지 —
     * working→done 전환(Stop hook에는 프롬프트가 없음) 때 내용이 사라지지 않게.
     */
    setStatus(project: Project, agentId: string, sessionId: string, status: ProjectStatus, detail?: string): void {
        const key = normalizePath(project.path);
        const perSession = this.statuses.get(key) ?? new Map<string, { status: ProjectStatus; detail?: string }>();
        const sk = ProjectManager.sessionKey(agentId, sessionId);
        if (status === 'idle') {
            perSession.delete(sk);
        } else {
            perSession.set(sk, { status, detail: detail ?? perSession.get(sk)?.detail });
        }
        this.statuses.set(key, perSession);
        this._onDidChange.fire();
    }

    /**
     * 세션 종료(SessionEnd hook)나 터미널 닫힘 시 '작업 중' 잔상 정리.
     * done/attention은 사용자가 확인(전환)할 때까지 유지한다.
     * sessionId를 생략하면 해당 에이전트의 모든 working 세션을 정리.
     */
    clearWorking(project: Project, agentId: string, sessionId?: string): void {
        const perSession = this.statuses.get(normalizePath(project.path));
        if (!perSession) {
            return;
        }
        let changed = false;
        for (const [key, v] of [...perSession]) {
            if (v.status !== 'working') {
                continue;
            }
            const parsed = ProjectManager.parseSessionKey(key);
            if (parsed.agentId !== agentId) {
                continue;
            }
            if (sessionId !== undefined && parsed.sessionId !== sessionId) {
                continue;
            }
            perSession.delete(key);
            changed = true;
        }
        if (changed) {
            this._onDidChange.fire();
        }
    }

    /** 전환 등으로 확인된 done/attention 상태를 일괄 해제 */
    clearSeenStatuses(project: Project): void {
        const perSession = this.statuses.get(normalizePath(project.path));
        if (!perSession) {
            return;
        }
        for (const [key, v] of [...perSession]) {
            if (v.status === 'done' || v.status === 'attention') {
                perSession.delete(key);
            }
        }
        this._onDidChange.fire();
    }

    refresh(): void {
        this._onDidChange.fire();
    }

    /**
     * 프로젝트 전환.
     * - 허브 워크스페이스 안이면 앵커(첫 폴더)는 그대로 두고 두 번째 자리의 폴더만 교체
     *   → extension host 재시작 없음, 터미널/Claude 세션/사이드바 모두 유지.
     * - 단일 폴더/빈 창이면 허브 워크스페이스를 만들어 열어야 함 → 최초 1회만 리로드.
     * - 앵커가 없는 구버전 허브라면 이번 한 번만 앵커를 삽입 (이때만 확장 재시작 발생).
     */
    async switchTo(project: Project): Promise<boolean> {
        if (!fs.existsSync(project.path)) {
            vscode.window.showErrorMessage(vscode.l10n.t('Folder does not exist: {0}', project.path));
            return false;
        }
        if (!vscode.workspace.workspaceFile) {
            return this.openHubWorkspace(project);
        }

        const folders = vscode.workspace.workspaceFolders ?? [];
        const anchor = this.ensureAnchorDir();
        const hasAnchor = folders.length > 0 && samePath(folders[0].uri.fsPath, anchor);

        if (hasAnchor && folders.length === 2 && this.isActive(project)) {
            // 이미 활성인 프로젝트를 다시 누른 것 = 확인했다는 뜻.
            // 폴더 교체는 필요 없지만 완료/응답 대기 표시는 지워야 배지가 남지 않는다.
            this.clearSeenStatuses(project);
            return true;
        }

        let ok: boolean;
        if (hasAnchor) {
            ok = vscode.workspace.updateWorkspaceFolders(1, folders.length - 1, {
                uri: vscode.Uri.file(project.path),
                name: project.name
            });
        } else {
            ok = vscode.workspace.updateWorkspaceFolders(
                0,
                folders.length,
                { uri: vscode.Uri.file(anchor), name: ANCHOR_LABEL },
                { uri: vscode.Uri.file(project.path), name: project.name }
            );
        }
        if (!ok) {
            vscode.window.showErrorMessage(vscode.l10n.t('Failed to switch workspace folders.'));
            return false;
        }
        this.clearSeenStatuses(project);
        this._onDidChange.fire();
        return true;
    }

    /** 허브 .code-workspace 파일을 만들고 연다 (최초 1회 리로드 발생) */
    private async openHubWorkspace(project: Project): Promise<boolean> {
        const confirmLabel = vscode.l10n.t('Switch to Hub Workspace');
        const pick = await vscode.window.showInformationMessage(
            vscode.l10n.t(
                'Project Hub uses a hub workspace (.code-workspace) to switch projects without reloading. The window will reopen once now; after that, switching is instant with no reload.'
            ),
            { modal: true },
            confirmLabel
        );
        if (pick !== confirmLabel) {
            return false;
        }

        // 현재 열려 있는 폴더도 프로젝트 리스트에 보존
        const current = this.getActivePath();
        if (current && !this.findByPath(current)) {
            await this.addProject(current);
        }

        const anchor = this.ensureAnchorDir();
        const hubFile = getHubWorkspaceFile(this.context);
        fs.mkdirSync(path.dirname(hubFile), { recursive: true });
        fs.writeFileSync(
            hubFile,
            JSON.stringify(
                {
                    folders: [
                        { name: ANCHOR_LABEL, path: anchor },
                        { name: project.name, path: project.path }
                    ]
                },
                null,
                2
            )
        );

        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(hubFile), { forceReuseWindow: true });
        return true;
    }
}
