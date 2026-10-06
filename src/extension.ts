import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Project, STATUS_LABEL } from './types';
import { ProjectManager, getHubWorkspaceFile, isHubWindow } from './projectManager';
import { EditorStateStore } from './editorState';
import { samePath } from './paths';
import { AvatarStore, PALETTE, colorOf, contrastText } from './avatars';
import { asProject, HubNode, ProjectDragAndDrop } from './projectTree';
import { ProjectTreeProvider } from './projectTree';
import { TerminalManager, sendWhenReady } from './terminalManager';
import { initRemotePersist, liveTmuxSessions } from './remotePersist';
import { migrateFromOldId } from './legacyId';
import { initSshKeySetup, offerKeySetupBeforeOpen, setupSshKey } from './sshKeySetup';
import { HostEntry, currentHost, forgetHost, initHostRegistry, openOnHost, publishHost, takePendingSwitch } from './hostRegistry';
import { NotificationServer, HookEvent, HookPayload } from './notificationServer';
import { installAgentHooks, hasAgentHooks, supportsHooks } from './hookInstaller';
import {
    AgentDef,
    getAgents,
    getAgent,
    getAgentLabel,
    getDefaultAgent,
    canVerifySessions,
    canPickSessions,
    resolveCommand,
    resolveSessionCommand
} from './agents';
import { listClaudeSessions, hasClaudeSession, claudeSessionPreview } from './claudeSessions';
import { initSessionLabels, sessionLabel, sessionTag, setSessionLabel, sanitizeLabel } from './sessionLabels';
import { getServiceCommand, setServiceCommand } from './serviceCommands';
import { hasRunningChild, invalidateProcessCache, processStartTime, killProcessTree, serviceUrl, webPorts } from './processTree';
import { ServiceNode, ServiceProjectNode, ServicesTreeProvider } from './servicesTree';
import { BriefingEntry, BriefingStore } from './briefing';
import { BriefingViewProvider } from './briefingView';
import { invalidateUsageCache } from './usage';

export function activate(context: vscode.ExtensionContext): void {
    const config = () => vscode.workspace.getConfiguration('projectHub');
    initSessionLabels(context);
    initRemotePersist(context);
    initHostRegistry(context);
    migrateFromOldId(context);
    initSshKeySetup(context);
    const manager = new ProjectManager(context);
    // 에이전트 터미널이 닫히면 (Stop hook이 못 오므로) '작업 중' 표시를 정리
    const terminals = new TerminalManager(context, (agentId, projectPath, sessionId) => {
        const project = manager.findByPath(projectPath);
        if (!project) {
            return;
        }
        if (sessionId) {
            // 세션 전용 터미널 → 그 세션의 잔상만 정리
            manager.clearWorking(project, agentId, sessionId);
        } else if (!terminals.hasLiveAgentTerminal(agentId, project)) {
            // 기본 터미널 → 같은 에이전트의 다른 터미널이 남아 있지 않을 때만 정리
            manager.clearWorking(project, agentId);
        }
    });
    const editors = new EditorStateStore(context);
    const avatars = new AvatarStore(context);
    const tree = new ProjectTreeProvider(manager, avatars, terminals);

    const treeView = vscode.window.createTreeView('projectHub.projects', {
        treeDataProvider: tree,
        dragAndDropController: new ProjectDragAndDrop(manager)
    });
    context.subscriptions.push(treeView);

    // ── 여러 PC·서버 목록 ─────────────────────────────────────────
    // 목록 제목 옆에 이 창이 연결된 곳(로컬 PC / SSH 서버)을 표시
    const thisHost = currentHost();
    treeView.description = thisHost
        ? `${thisHost.kind === 'ssh' ? 'SSH' : vscode.l10n.t('Local')} · ${thisHost.label}`
        : vscode.env.remoteName;

    // 이 호스트의 프로젝트 목록을 공유 레지스트리에 올려 다른 창(다른 PC·서버)에서도 보이게 한다.
    // 상태 변경 등으로 onDidChange가 자주 오므로 목록이 실제로 바뀔 때만 쓴다.
    let lastPublished = '';
    function publishThisHost(): void {
        const hubFile = getHubWorkspaceFile(context);
        const projects = manager.getProjects();
        const snapshot = JSON.stringify([projects, fs.existsSync(hubFile)]);
        if (snapshot === lastPublished) {
            return;
        }
        lastPublished = snapshot;
        void publishHost(projects, fs.existsSync(hubFile) ? hubFile : undefined);
    }
    publishThisHost();
    context.subscriptions.push(manager.onDidChange(() => publishThisHost()));

    const servicesTree = new ServicesTreeProvider(manager, avatars, terminals);
    const servicesView = vscode.window.createTreeView('projectHub.services', {
        treeDataProvider: servicesTree
    });
    context.subscriptions.push(
        servicesView,
        // 섹션을 펼쳐 볼 때마다 최신 상태로 재조회
        servicesView.onDidChangeVisibility(e => {
            if (e.visible) {
                invalidateProcessCache();
                servicesTree.refresh();
            }
        })
    );

    const briefingStore = new BriefingStore();
    new BriefingViewProvider(briefingStore, getAgentLabel).register(context);

    // 액티비티 바 배지: 확인 대기(완료/응답 대기) 프로젝트 수
    function updateBadge(): void {
        const pending = manager
            .getProjects()
            .filter(p => ['done', 'attention'].includes(manager.getStatus(p))).length;
        treeView.badge = pending
            ? { value: pending, tooltip: vscode.l10n.t('{0} project(s) waiting for your attention', pending) }
            : undefined;
    }
    updateBadge();
    context.subscriptions.push(manager.onDidChange(() => updateBadge()));

    // ── 활성 프로젝트 강조: 리스트 항목 강조색 (FileDecoration) ─────
    const activeDecoration = new (class implements vscode.FileDecorationProvider {
        private readonly _onDidChange = new vscode.EventEmitter<undefined>();
        readonly onDidChangeFileDecorations = this._onDidChange.event;
        fire(): void {
            this._onDidChange.fire(undefined);
        }
        provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
            if (uri.scheme !== 'projecthub') {
                return undefined;
            }
            const target = decodeURIComponent(uri.path.replace(/^\//, ''));
            const active = manager.getActivePath();
            if (active && samePath(active, target)) {
                return {
                    color: new vscode.ThemeColor('projectHub.activeProject'),
                    tooltip: vscode.l10n.t('Active project')
                };
            }
            return undefined;
        }
    })();
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(activeDecoration),
        manager.onDidChange(() => activeDecoration.fire())
    );

    // ── (선택 기능) 전환 시 타이틀 바 색상 = 프로젝트 색상 ──────────
    // 파일 직접 쓰기는 updateWorkspaceFolders 직후 VS Code의 워크스페이스 파일
    // 저장과 경쟁해 덮어써지므로, 반드시 설정 API로 기록한다.
    async function writeTitleBarColor(project: Project | undefined): Promise<void> {
        if (!isHubWindow(context)) {
            return;
        }
        const wb = vscode.workspace.getConfiguration('workbench');
        const workspaceValue =
            (wb.inspect<Record<string, string>>('colorCustomizations')?.workspaceValue as Record<string, string>) ?? {};
        const cc = { ...workspaceValue };
        const keys = ['titleBar.activeBackground', 'titleBar.activeForeground', 'titleBar.inactiveBackground'];
        if (project) {
            const color = colorOf(project);
            cc['titleBar.activeBackground'] = color;
            cc['titleBar.activeForeground'] = contrastText(color);
            cc['titleBar.inactiveBackground'] = color + 'aa';
        } else {
            if (!keys.some(k => k in cc)) {
                return; // 지울 것도 없으면 건드리지 않음
            }
            for (const k of keys) {
                delete cc[k];
            }
        }
        try {
            await wb.update(
                'colorCustomizations',
                Object.keys(cc).length ? cc : undefined,
                vscode.ConfigurationTarget.Workspace
            );
        } catch {
            // 워크스페이스 설정을 쓸 수 없으면 색상 적용은 건너뜀
        }
    }

    function applyWindowColor(project: Project | undefined): void {
        if (!config().get<boolean>('windowColor', false)) {
            return;
        }
        void writeTitleBarColor(project);
    }

    function reconcileWindowColor(): void {
        if (config().get<boolean>('windowColor', false)) {
            const activePath = manager.getActivePath();
            void writeTitleBarColor(activePath ? manager.findByPath(activePath) : undefined);
        } else {
            // 꺼져 있으면 남아 있는 색을 제거
            void writeTitleBarColor(undefined);
        }
    }
    reconcileWindowColor();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('projectHub.windowColor')) {
                reconcileWindowColor();
            }
        })
    );

    // ── 상태 표시줄: 현재 활성 프로젝트 ─────────────────────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'projectHub.quickSwitch';
    context.subscriptions.push(statusBar);

    function updateStatusBar(): void {
        const active = manager.getActivePath();
        const project = active ? manager.findByPath(active) : undefined;
        const label = project?.name ?? (active ? path.basename(active) : vscode.l10n.t('No project'));
        statusBar.text = `$(folder-library) ${label}`;
        statusBar.tooltip = vscode.l10n.t('Project Hub: quick switch project');
        statusBar.show();
    }
    updateStatusBar();
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            manager.refresh();
            updateStatusBar();
        }),
        manager.onDidChange(() => updateStatusBar())
    );

    // 이전 퍼블리셔 ID 위치의 허브 워크스페이스를 쓰는 창이면 새 위치로 이전 안내
    // (이전하지 않으면 구버전 저장 폴더가 정리될 때 허브가 깨질 수 있음)
    if (manager.isLegacyHubWindow()) {
        const migrateNow = vscode.l10n.t('Migrate Now');
        vscode.window
            .showInformationMessage(
                vscode.l10n.t(
                    'Project Hub: this window uses a hub workspace from a previous version. Migrating to the new location is recommended (the window will reopen once).'
                ),
                migrateNow,
                vscode.l10n.t('Later')
            )
            .then(pick => {
                if (pick === migrateNow) {
                    void manager.migrateLegacyHub();
                }
            });
    }

    // ── 에이전트 터미널 열기 (전역 hook 자동 설치 포함) ────────────
    function ensureHooks(agentId: string): void {
        const port = config().get<number>('port', 43917);
        if (
            !config().get<boolean>('autoInstallHooks', true) ||
            !supportsHooks(agentId) ||
            hasAgentHooks(agentId, port)
        ) {
            return;
        }
        try {
            installAgentHooks(agentId, port);
            vscode.window.setStatusBarMessage(
                `$(bell) ${vscode.l10n.t('{0} completion hooks installed (applies to all projects)', getAgentLabel(agentId))}`,
                5000
            );
        } catch {
            // 설치 실패는 치명적이지 않음 — 수동 설치 명령으로 재시도 가능
        }
    }

    function openAgent(project: Project, agent: AgentDef, resume: boolean, focus: boolean): void {
        ensureHooks(agent.id);
        terminals.open(project, agent, resume, focus);
        afterTerminalOpened(project);
    }

    function openAgentSession(project: Project, agent: AgentDef, sessionId: string): void {
        terminals.openSession(project, agent, sessionId, true);
        afterTerminalOpened(project);
    }

    /** 프로젝트 그리드 모드면 새로 연 터미널까지 포함해 활성 프로젝트 그리드를 다시 짠다 */
    function afterTerminalOpened(project: Project): void {
        if (projectGridMode() && manager.isActive(project)) {
            void regridProject(project);
        }
    }

    // ── 전환 로직 ───────────────────────────────────────────────
    // ── 터미널 그리드 상태 ──────────────────────────────────────
    // "활성 프로젝트만" 그리드는 프로젝트 전환 시 따라와야 한다:
    // 이전 프로젝트 터미널은 패널로 되돌리고 새 프로젝트 터미널로 재구성.
    // "전체 프로젝트" 그리드는 여러 프로젝트를 동시에 보는 목적이므로 전환해도 유지.
    let activeGrid: { projectPath: string; terminals: vscode.Terminal[] } | undefined;
    const gridPause = () => new Promise(resolve => setTimeout(resolve, 150));

    /**
     * 조건이 이미 맞으면 즉시, 아니면 이벤트가 올 때마다 확인해 맞는 순간 끝난다 (상한 timeoutMs).
     * 터미널 이동은 완료를 알려 주는 API가 없어 예전엔 단계마다 150ms씩 고정으로 기다렸는데,
     * 실제로는 수십 ms면 끝나므로 이벤트로 기다리면 전환 시 멈칫거림이 줄어든다.
     */
    function waitUntil(check: () => boolean, events: vscode.Event<unknown>[], timeoutMs: number): Promise<void> {
        if (check()) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            const subs: vscode.Disposable[] = [];
            const done = () => {
                clearTimeout(timer);
                subs.forEach(d => d.dispose());
                resolve();
            };
            const timer = setTimeout(done, timeoutMs);
            for (const ev of events) {
                subs.push(ev(() => check() && done()));
            }
        });
    }
    const TAB_EVENTS: vscode.Event<unknown>[] = [
        vscode.window.tabGroups.onDidChangeTabs,
        vscode.window.tabGroups.onDidChangeTabGroups
    ];
    const terminalTabCount = () =>
        vscode.window.tabGroups.all.reduce(
            (n, g) => n + g.tabs.filter(t => t.input instanceof vscode.TabInputTerminal).length,
            0
        );

    /**
     * cells[i]의 터미널들을 그리드 i번째 칸에 탭으로 넣는다.
     * 터미널마다 한 칸이면 [[a], [b]], 프로젝트마다 한 칸(전체 보기)이면 [[a1, a2], [b1]].
     */
    async function arrangeGrid(cells: vscode.Terminal[][]): Promise<void> {
        // 에디터 영역을 2열 그리드로 만들고 칸마다 터미널을 옮긴다 (최대 6칸, 넘치면 마지막 칸에 탭으로)
        // 먼저 기존 에디터 그룹(비어 있는 칸 포함)을 하나로 합쳐 두어야 남는 칸이 터미널을 밀어내지 않는다.
        // 열려 있던 파일은 첫 칸의 뒤쪽 탭으로 남는다.
        await unlockAndCloseEmptyGroups();
        await vscode.commands.executeCommand('workbench.action.joinAllGroups');
        cells = cells.filter(c => c.length > 0);
        const k = Math.min(cells.length, 6);
        const leftRows = Math.ceil(k / 2);
        const rightRows = k - leftRows;
        const col = (rows: number) => (rows > 1 ? { groups: Array.from({ length: rows }, () => ({})) } : {});
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: rightRows > 0 ? [col(leftRows), col(rightRows)] : [col(leftRows)]
        });
        for (let i = 0; i < cells.length; i++) {
            for (const term of cells[i]) {
                await vscode.commands.executeCommand(FOCUS_GROUP[Math.min(i, k - 1)]);
                const before = terminalTabCount();
                term.show(false);
                await waitUntil(() => vscode.window.activeTerminal === term, [vscode.window.onDidChangeActiveTerminal], 300);
                await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
                await waitUntil(() => terminalTabCount() > before, TAB_EVENTS, 500);
            }
        }
        await vscode.commands.executeCommand('workbench.action.closePanel');
    }

    /**
     * 프로젝트 그리드 모드: 에디터 영역에는 활성 프로젝트의 터미널만 그리드로 띄우고
     * 다른 프로젝트 터미널은 (닫힌) 하단 패널로 보낸다. VS Code는 터미널 탭 목록을
     * 거르는 API가 없어서, "현재 프로젝트 터미널만 보이게" 하는 유일한 방법이다.
     */
    function projectGridMode(): boolean {
        return config().get<boolean>('projectTerminalGrid', true);
    }

    let regridding: Promise<void> = Promise.resolve();
    function regridProject(project: Project): Promise<void> {
        // 전환·열기가 연달아 오면 배치 명령이 뒤섞이므로 순서대로 실행
        regridding = regridding.then(async () => {
            if (!manager.isActive(project)) {
                return;
            }
            const incoming = terminals.allLiveTerminals([project]);
            // 이미 같은 터미널들로 그리드가 짜여 있고 모두 에디터에 떠 있으면 다시 할 필요가 없다
            // (전환 직후 자동 시작·포커스 이벤트 등으로 연달아 불릴 때 깜빡임 방지)
            if (
                activeGrid &&
                samePath(activeGrid.projectPath, project.path) &&
                activeGrid.terminals.length === incoming.length &&
                incoming.every(t => activeGrid!.terminals.includes(t)) &&
                terminalTabCount() === incoming.length
            ) {
                return;
            }
            // 에디터의 터미널을 모두 패널로 모은 뒤 다시 배치 (이미 에디터에 있는 터미널은
            // show() 시 제자리에서 열려 칸 순서가 어긋나므로)
            await moveAllEditorTerminalsToPanel();
            if (incoming.length === 0) {
                await unlockAndCloseEmptyGroups();
                await vscode.commands.executeCommand('workbench.action.closePanel');
                activeGrid = undefined;
                return;
            }
            await arrangeGrid(incoming.map(t => [t]));
            activeGrid = { projectPath: project.path, terminals: incoming };
        }).catch(() => {
            /* 배치 실패는 무시 — 터미널은 그대로 살아 있다 */
        });
        return regridding;
    }

    const FOCUS_GROUP = [
        'workbench.action.focusFirstEditorGroup',
        'workbench.action.focusSecondEditorGroup',
        'workbench.action.focusThirdEditorGroup',
        'workbench.action.focusFourthEditorGroup',
        'workbench.action.focusFifthEditorGroup',
        'workbench.action.focusSixthEditorGroup',
        'workbench.action.focusSeventhEditorGroup',
        'workbench.action.focusEighthEditorGroup'
    ];

    /**
     * 에디터 그룹 잠금을 풀고 빈 그룹을 닫는다.
     * VS Code는 터미널만 든 그룹을 자동으로 잠그는데(workbench.editor.autoLockGroups),
     * 터미널을 패널로 되돌린 뒤에도 잠긴 빈 그룹은 닫히지도 합쳐지지도 않고
     * 빈 칸(가운데 VS Code 로고 + 잠금 해제 아이콘)으로 남아 새 그리드를 밀어낸다.
     */
    async function unlockAndCloseEmptyGroups(): Promise<void> {
        if (vscode.window.tabGroups.all.length <= 1) {
            return;
        }
        // 모든 그룹의 잠금을 푼다. 빈 그룹만 골라 풀면, 터미널을 막 뺀 직후엔 탭 목록이
        // 아직 갱신 전이라 빈 그룹이 비어 있지 않은 것으로 보여 빠지고, 잠긴 채 남은 그룹은
        // joinAllGroups에서도 빠져 빈 칸이 그리드를 오른쪽으로 밀어낸다. (그룹당 명령 2개라 비용은 작다)
        // 뒤 칸부터 처리해야 닫을 때 앞 칸들의 번호가 바뀌지 않는다
        const columns = vscode.window.tabGroups.all
            .map(g => g.viewColumn)
            .filter(c => c <= FOCUS_GROUP.length)
            .sort((a, b) => b - a);
        for (const column of columns) {
            await vscode.commands.executeCommand(FOCUS_GROUP[column - 1]);
            await vscode.commands.executeCommand('workbench.action.unlockEditorGroup');
            // 닫기 판단은 잠금 해제 후 최신 상태로
            const g = vscode.window.tabGroups.all.find(x => x.viewColumn === column);
            if (g && g.tabs.length === 0 && vscode.window.tabGroups.all.length > 1) {
                await vscode.commands.executeCommand('workbench.action.closeGroup');
            }
        }
    }

    /**
     * 에디터 영역의 터미널 탭을 모두 패널로 되돌린다 (프로젝트 그리드 모드 전용).
     * 탭 라벨은 에이전트가 바꾼 제목(예: "✳ Claude Code")이라 터미널 이름으로 찾을 수 없으므로,
     * 그룹을 포커스하고 탭 위치로 활성화한 뒤 옮긴다.
     */
    async function moveAllEditorTerminalsToPanel(): Promise<void> {
        // 옮길 때마다 탭 구성이 바뀌므로 매번 다시 조회 (무한 반복 방지 상한)
        for (let guard = 0; guard < 30; guard++) {
            let target: { column: number; index: number } | undefined;
            for (const g of vscode.window.tabGroups.all) {
                const index = g.tabs.findIndex(t => t.input instanceof vscode.TabInputTerminal);
                if (index >= 0 && g.viewColumn <= FOCUS_GROUP.length) {
                    target = { column: g.viewColumn, index };
                    break;
                }
            }
            if (!target) {
                return;
            }
            const { column, index } = target;
            const before = terminalTabCount();
            await vscode.commands.executeCommand(FOCUS_GROUP[column - 1]);
            await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
            // 그 터미널 탭이 활성화된 뒤에 옮겨야 다른 터미널을 옮기지 않는다
            await waitUntil(
                () => {
                    const g = vscode.window.tabGroups.activeTabGroup;
                    return g.viewColumn === column && !!g.activeTab && g.tabs.indexOf(g.activeTab) === index;
                },
                TAB_EVENTS,
                300
            );
            await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
            await waitUntil(() => terminalTabCount() < before, TAB_EVENTS, 500);
        }
    }

    /** 에디터 탭으로 떠 있는 터미널들을 패널로 되돌린다 (세션 유지) */
    async function moveTerminalsToPanel(terms: vscode.Terminal[]): Promise<void> {
        // 에디터 탭인 터미널만 대상 (탭 라벨 = 터미널 이름)
        const tabLabels = new Set(
            vscode.window.tabGroups.all.flatMap(g =>
                g.tabs.filter(t => t.input instanceof vscode.TabInputTerminal).map(t => t.label)
            )
        );
        for (const t of terms) {
            if (t.exitStatus !== undefined || !tabLabels.has(t.name)) {
                continue;
            }
            t.show(false);
            await gridPause();
            await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
            await gridPause();
        }
    }

    /**
     * 프로젝트 전환.
     * revealTerminal=false는 하위 행 클릭처럼 호출자가 곧바로 특정 터미널을 표시하는 경우 —
     * 전환 단계의 자동 시작을 건너뛰지 않으면 기본 에이전트 터미널이 하나 더 떠 버린다.
     */
    async function switchTo(project: Project, revealTerminal = true): Promise<void> {
        const restoreEditors = config().get<boolean>('restoreEditorsOnSwitch', true);
        const outgoingPath = manager.getActivePath();
        const isSameTarget = !!outgoingPath && samePath(outgoingPath, project.path);

        // 나가는 프로젝트의 열린 탭을 전환 전에 스냅샷
        if (restoreEditors && outgoingPath && !isSameTarget) {
            await editors.save(outgoingPath);
        }

        const switched = await manager.switchTo(project);
        if (!switched) {
            return;
        }
        applyWindowColor(project);
        // 활성 항목에 선택 하이라이트(배경) 적용
        treeView.reveal({ kind: 'project', project }, { select: true, focus: false }).then(
            undefined,
            () => { /* reveal 실패는 무시 */ }
        );

        if (restoreEditors && outgoingPath && !isSameTarget) {
            await editors.closeTabs(outgoingPath);
            await editors.restore(project.path);
        }
        if (projectGridMode()) {
            if (!isSameTarget) {
                await regridProject(project);
            }
        } else if (activeGrid && outgoingPath && !isSameTarget && samePath(activeGrid.projectPath, outgoingPath)) {
            await moveTerminalsToPanel(activeGrid.terminals);
            const incoming = terminals.allLiveTerminals([project]);
            if (incoming.length >= 2) {
                await arrangeGrid(incoming.map(t => [t]));
                activeGrid = { projectPath: project.path, terminals: incoming };
            } else {
                await vscode.commands.executeCommand('workbench.action.closePanel');
                activeGrid = undefined;
            }
        }
        if (revealTerminal && config().get<boolean>('focusClaudeTerminalOnSwitch', true)) {
            const existing = terminals.findForProject(project);
            if (existing) {
                existing.show(true);
            } else if (config().get<boolean>('autoStartClaudeOnSwitch', true)) {
                // 전환한 프로젝트에 터미널이 없으면 기본 에이전트를 자동 시작.
                // 세션 존재를 확인할 수 있는 에이전트만 자동 resume — 확인 불가 에이전트에
                // 무조건 resume을 보내면 세션이 없을 때 오류로 종료될 수 있다
                const agent = getDefaultAgent();
                openAgent(project, agent, canVerifySessions(agent), false);
            }
        }
    }

    // ── 하위 행 클릭 시 프로젝트 전환 ───────────────────────────
    // 프로젝트 하위 행(에이전트 상태·사용량)이나 서비스 행을 클릭하면 그 프로젝트의
    // 터미널이 떠 있는데 Explorer는 이전 프로젝트를 가리키는 불일치가 생긴다.
    // 기본값은 함께 전환. 끄면 Explorer를 그대로 둔 채 다른 프로젝트를 들여다볼 수 있다.
    function rowClickSwitches(): boolean {
        return config().get<boolean>('switchOnRowClick', true);
    }

    /** 하위 행 동작(터미널 표시) 직전에 그 프로젝트로 전환 */
    async function switchBeforeRowAction(project: Project): Promise<void> {
        if (rowClickSwitches() && !manager.isActive(project)) {
            await switchTo(project, false);
        }
    }

    /** 파일 트리 노드(파일·폴더)의 절대 경로 */
    function fileNodePath(node?: HubNode): string | undefined {
        return node && 'kind' in node && (node.kind === 'file' || node.kind === 'dir') ? node.path : undefined;
    }

    // 설정을 바꾸면 행 툴팁·파일 목록에 바로 반영되도록 트리를 다시 그린다
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (
                e.affectsConfiguration('projectHub.switchOnRowClick') ||
                e.affectsConfiguration('projectHub.fileTreeExclude')
            ) {
                manager.refresh();
            }
        })
    );

    // ── 알림 자동 숨김 ──────────────────────────────────────────
    // VS Code는 버튼 있는 토스트를 직접 닫는 API가 없으므로, 일정 시간 뒤
    // notifications.hideToasts로 화면의 토스트를 알림 센터(종 아이콘)로 내린다.
    // 알림 자체는 지워지지 않아 '프로젝트로 전환' 버튼을 나중에도 누를 수 있다.
    let toastHideTimer: NodeJS.Timeout | undefined;
    function scheduleToastHide(): void {
        const seconds = config().get<number>('notificationTimeout', 10);
        if (seconds <= 0) {
            return;
        }
        if (toastHideTimer) {
            clearTimeout(toastHideTimer);
        }
        toastHideTimer = setTimeout(() => {
            toastHideTimer = undefined;
            void vscode.commands.executeCommand('notifications.hideToasts');
        }, seconds * 1000);
    }
    context.subscriptions.push({
        dispose: () => {
            if (toastHideTimer) {
                clearTimeout(toastHideTimer);
            }
        }
    });

    // ── 에이전트 hook 이벤트 처리 ─────────────────────────────────
    function onHookEvent(event: HookEvent, payload: HookPayload, agentId: string): void {
        const str = (k: string) => (typeof payload[k] === 'string' && payload[k] ? (payload[k] as string) : undefined);
        // 배열 필드(Antigravity workspacePaths 등)의 첫 문자열
        const firstOf = (k: string) => {
            const v = payload[k];
            return Array.isArray(v) ? v.find((x): x is string => typeof x === 'string') : undefined;
        };
        const cwd = str('cwd') ?? firstOf('workspacePaths') ?? firstOf('workspace_paths');
        if (!cwd) {
            return;
        }
        const agentLabel = getAgentLabel(agentId);
        const project = manager.findContaining(cwd);
        if (!project) {
            offerUnknownProject(cwd, event, agentLabel);
            return;
        }
        const isActive = manager.isActive(project);
        // 같은 에이전트 다중 실행 구분: hook 페이로드의 세션 ID (없는 에이전트는 단일 버킷)
        const sessionId = str('session_id') ?? str('conversation_id') ?? str('conversationId') ?? 'default';

        if (event === 'working') {
            const prompt = str('prompt');
            // 세션의 첫 프롬프트를 세션 이름으로 기억 (다중 세션 구분·터미널 이름용)
            if (sessionId !== 'default' && prompt && !sessionLabel(sessionId)) {
                setSessionLabel(sessionId, sanitizeLabel(prompt));
            }
            // 무슨 작업인지 리스트에 보여주기 위해 프롬프트 텍스트를 함께 저장
            manager.setStatus(project, agentId, sessionId, 'working', prompt);
            return;
        }

        if (event === 'end') {
            // 세션 종료(exit, /clear 등): '작업 중' 잔상만 정리.
            // done/attention은 사용자가 확인(전환)할 때까지 유지한다.
            manager.clearWorking(project, agentId, sessionId === 'default' ? undefined : sessionId);
            return;
        }

        if (event === 'stop') {
            manager.setStatus(project, agentId, sessionId, isActive ? 'idle' : 'done');
            // 브리핑: transcript에서 마지막 응답 요약을 뽑아 피드에 기록
            briefingStore.record(project, agentId, 'done', str('transcript_path') ?? str('transcriptPath'));
            const notifyActive = config().get<boolean>('notifyForActiveProject', true);
            if (!isActive || (notifyActive && !vscode.window.state.focused)) {
                const switchLabel = vscode.l10n.t('Switch to Project');
                vscode.window
                    .showInformationMessage(
                        vscode.l10n.t('✅ {0}: {1} finished its task.', project.name, agentLabel),
                        switchLabel
                    )
                    .then(pick => {
                        if (pick === switchLabel) {
                            void switchTo(project);
                        }
                    });
                scheduleToastHide();
            }
            return;
        }

        if (event === 'notification') {
            // 활성 프로젝트라도 창이 포커스를 잃었으면 권한 요청을 놓치지 않게 알림
            const notifyActive = config().get<boolean>('notifyForActiveProject', true);
            const alert = !isActive || (notifyActive && !vscode.window.state.focused);
            // 알릴 상황이 아니면(보고 있는 프로젝트) 상태를 건드리지 않는다.
            // 예전처럼 'idle'을 넣으면 setStatus가 세션 항목을 지워버려서
            // 진행 중이던 '작업 중' 행과 프롬프트 내용까지 같이 사라진다.
            if (alert) {
                manager.setStatus(project, agentId, sessionId, 'attention');
                const message =
                    typeof payload.message === 'string' ? payload.message :
                    payload.tool_name === 'AskUserQuestion' ? vscode.l10n.t('A choice is needed') :
                    payload.tool_name === 'ExitPlanMode' ? vscode.l10n.t('Waiting for plan approval') :
                    STATUS_LABEL.attention;
                briefingStore.record(project, agentId, 'attention', undefined, message);
                const switchLabel = vscode.l10n.t('Switch to Project');
                vscode.window
                    .showWarningMessage(`🔔 ${project.name} (${agentLabel}): ${message}`, switchLabel)
                    .then(pick => {
                        if (pick === switchLabel) {
                            void switchTo(project);
                        }
                    });
                scheduleToastHide();
            }
        }
    }

    function offerUnknownProject(cwd: string, event: HookEvent, agentLabel: string): void {
        if (event !== 'stop') {
            return;
        }
        const addLabel = vscode.l10n.t('Add as Project');
        vscode.window
            .showInformationMessage(
                vscode.l10n.t('✅ {0}: {1} finished its task. (folder not in the list)', path.basename(cwd), agentLabel),
                addLabel
            )
            .then(async pick => {
                if (pick === addLabel) {
                    await manager.addProject(cwd);
                }
            });
        scheduleToastHide();
    }

    // ── 알림 서버: 포트는 허브 창이 우선 소유 ─────────────────────
    // 규칙: 허브 워크스페이스 창이면 항상 바인딩 시도(충돌 시 경고).
    //       허브가 아직 만들어지지 않았다면 일반 창도 임시로 소유 가능.
    //       허브가 생긴 뒤 일반 창은 포트를 반납 → 알림이 허브 창으로 수렴.
    let conflictWarned = false;
    const server = new NotificationServer(onHookEvent, port => {
        if (isHubWindow(context) && !conflictWarned) {
            conflictWarned = true;
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    'Project Hub: port {0} is already in use, so completion notifications cannot be received. Closing other VS Code windows lets this window take over automatically. If another program holds the port, change the projectHub.port setting.',
                    port
                )
            );
        }
    });
    context.subscriptions.push(server);

    function shouldOwnPort(): boolean {
        return isHubWindow(context) || !fs.existsSync(getHubWorkspaceFile(context));
    }

    function reconcileServer(): void {
        if (shouldOwnPort()) {
            if (!server.isListening) {
                server.start(config().get<number>('port', 43917));
            }
        } else if (server.isListening) {
            server.stop();
        }
    }
    reconcileServer();

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(state => {
            if (state.focused) {
                reconcileServer();
            }
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('projectHub.port')) {
                conflictWarned = false;
                server.stop();
                reconcileServer();
            }
        })
    );

    // ── 명령 등록 ───────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('projectHub.addProject', async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: true,
                openLabel: vscode.l10n.t('Add as Project')
            });
            if (!picked) {
                return;
            }
            for (const uri of picked) {
                const project = await manager.addProject(uri.fsPath);
                if (project) {
                    offerHookSetup(project);
                }
            }
        }),

        vscode.commands.registerCommand('projectHub.openOnHost', async (host: HostEntry, project: Project) => {
            // 키 인증이 안 되는 SSH 서버면 창을 열기 전에 키 설정을 권한다 (비밀번호 반복 입력 방지)
            if (host.kind === 'ssh' && host.authority) {
                const target = host.authority.replace(/^ssh-remote\+/, '');
                if (!(await offerKeySetupBeforeOpen(target))) {
                    return;
                }
            }
            await openOnHost(host, project);
        }),

        vscode.commands.registerCommand('projectHub.setupSshKey', (node?: HubNode) =>
            setupSshKey(
                node?.kind === 'host' && node.host.authority ? node.host.authority.replace(/^ssh-remote\+/, '') : undefined
            )
        ),

        vscode.commands.registerCommand('projectHub.forgetHost', async (node?: HubNode) => {
            if (node?.kind !== 'host') {
                return;
            }
            await forgetHost(node.host.key);
            manager.refresh();
        }),

        vscode.commands.registerCommand('projectHub.addCurrentFolder', async () => {
            const current = manager.getActivePath();
            if (!current) {
                vscode.window.showWarningMessage(vscode.l10n.t('No folder is open.'));
                return;
            }
            const project = await manager.addProject(current);
            if (project) {
                offerHookSetup(project);
            } else {
                vscode.window.showInformationMessage(vscode.l10n.t('This project is already in the list.'));
            }
        }),

        // 기존 폴더 등록(addProject)과 달리, 폴더를 새로 만들어서 등록하고 바로 전환한다
        vscode.commands.registerCommand('projectHub.createProject', async () => {
            // 상위 폴더 기본 위치: 마지막에 등록한 프로젝트의 부모 (대개 같은 작업 루트)
            const known = manager.getProjects();
            const lastParent = known.length ? path.dirname(known[known.length - 1].path) : undefined;
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: lastParent && fs.existsSync(lastParent) ? vscode.Uri.file(lastParent) : undefined,
                openLabel: vscode.l10n.t('Select Parent Folder')
            });
            if (!picked?.length) {
                return;
            }
            const parent = picked[0].fsPath;

            const input = await vscode.window.showInputBox({
                title: vscode.l10n.t('New Project'),
                prompt: vscode.l10n.t('Folder name to create under {0}', parent),
                placeHolder: 'my-new-project',
                ignoreFocusOut: true,
                validateInput: value => {
                    const name = value.trim();
                    if (!name || /^\.+$/.test(name)) {
                        return vscode.l10n.t('Enter a folder name.');
                    }
                    if (/[\\/:*?"<>|]/.test(name)) {
                        return vscode.l10n.t('These characters cannot be used: \\ / : * ? " < > |');
                    }
                    if (fs.existsSync(path.join(parent, name))) {
                        return vscode.l10n.t('A folder with that name already exists.');
                    }
                    return undefined;
                }
            });
            if (!input) {
                return;
            }
            const target = path.join(parent, input.trim());

            try {
                fs.mkdirSync(target);
            } catch (err) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Failed to create folder: {0}', (err as Error).message)
                );
                return;
            }

            const project = await manager.addProject(target);
            if (!project) {
                // 만든 폴더가 이미 리스트에 있는 경로였던 경우 (거의 없지만 방어)
                vscode.window.showInformationMessage(vscode.l10n.t('This project is already in the list.'));
                return;
            }
            offerHookSetup(project);
            vscode.window.setStatusBarMessage(
                `$(new-folder) ${vscode.l10n.t('Project created: {0}', target)}`,
                5000
            );
            await switchTo(project);
        }),

        vscode.commands.registerCommand('projectHub.switchProject', (project: Project) => switchTo(project)),

        vscode.commands.registerCommand('projectHub.quickSwitch', async () => {
            const projects = manager.getProjects();
            if (projects.length === 0) {
                vscode.window.showInformationMessage(vscode.l10n.t('No projects registered. Add a project first.'));
                return;
            }
            const items = projects.map(project => {
                const status = manager.getStatus(project);
                const icon =
                    status === 'working' ? '$(sync~spin) ' :
                    status === 'done' ? '$(pass-filled) ' :
                    status === 'attention' ? '$(bell-dot) ' :
                    manager.isActive(project) ? '$(circle-filled) ' : '$(circle-outline) ';
                const agentParts = manager
                    .getAgentStatuses(project)
                    .map(s => `${getAgentLabel(s.agentId)} ${STATUS_LABEL[s.status]}`)
                    .filter(Boolean);
                return {
                    label: `${icon}${project.name}`,
                    description: agentParts.join(' · '),
                    detail: project.path,
                    project
                };
            });
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: vscode.l10n.t('Select a project to switch to')
            });
            if (picked) {
                await switchTo(picked.project);
            }
        }),

        vscode.commands.registerCommand('projectHub.removeProject', async (node?: Project | HubNode) => {
            const project = asProject(node);
            if (!project) {
                return;
            }
            const removeLabel = vscode.l10n.t('Remove');
            const pick = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Remove '{0}' from the project list?\n\nOnly the list entry is removed — folders, files, and running terminals/sessions are kept.",
                    project.name
                ),
                { modal: true },
                removeLabel
            );
            if (pick === removeLabel) {
                await manager.removeProject(project);
            }
        }),

        vscode.commands.registerCommand('projectHub.openClaudeTerminal', (node?: Project | HubNode) => {
            const target =
                asProject(node) ??
                (manager.getActivePath() ? manager.findByPath(manager.getActivePath()!) : undefined);
            if (!target) {
                vscode.window.showWarningMessage(vscode.l10n.t('Target project not found.'));
                return;
            }
            openAgent(target, getDefaultAgent(), false, true);
        }),

        vscode.commands.registerCommand('projectHub.openAgentTerminal', async (node?: Project | HubNode) => {
            const target =
                asProject(node) ??
                (manager.getActivePath() ? manager.findByPath(manager.getActivePath()!) : undefined);
            if (!target) {
                vscode.window.showWarningMessage(vscode.l10n.t('Target project not found.'));
                return;
            }
            const items = getAgents().flatMap(agent => [
                { label: `$(terminal) ${vscode.l10n.t('{0} — new session', agent.label)}`, agent, resume: false },
                ...(agent.resumeCommand
                    ? [
                          {
                              label: `$(history) ${vscode.l10n.t('{0} — resume (last session)', agent.label)}`,
                              agent,
                              resume: true
                          }
                      ]
                    : [])
            ]);
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: vscode.l10n.t('Select an agent to run in {0}', target.name)
            });
            if (picked) {
                openAgent(target, picked.agent, picked.resume, true);
            }
        }),

        vscode.commands.registerCommand('projectHub.resumeClaudeTerminal', (node?: Project | HubNode) => {
            const target =
                asProject(node) ??
                (manager.getActivePath() ? manager.findByPath(manager.getActivePath()!) : undefined);
            if (!target) {
                vscode.window.showWarningMessage(vscode.l10n.t('Target project not found.'));
                return;
            }
            openAgent(target, getDefaultAgent(), true, true);
        }),

        vscode.commands.registerCommand('projectHub.setupNotifications', () => {
            const port = config().get<number>('port', 43917);
            const installed: string[] = [];
            const failed: string[] = [];
            for (const agent of getAgents()) {
                if (!supportsHooks(agent.id)) {
                    continue;
                }
                try {
                    installAgentHooks(agent.id, port);
                    installed.push(agent.label);
                } catch (err) {
                    failed.push(`${agent.label} (${(err as Error).message})`);
                }
            }
            if (installed.length) {
                vscode.window.showInformationMessage(
                    vscode.l10n.t(
                        'Completion hooks installed — {0}, applies to all projects. Running agent sessions pick them up after a restart.',
                        installed.join(', ')
                    )
                );
            }
            if (failed.length) {
                vscode.window.showErrorMessage(vscode.l10n.t('Hook installation failed — {0}', failed.join(', ')));
            }
        }),

        // 사용량 행처럼 이어서 할 동작이 없는 행 — 클릭 = 그 프로젝트로 전환
        vscode.commands.registerCommand('projectHub.switchFromRow', async (project?: Project) => {
            if (project && rowClickSwitches()) {
                await switchTo(project);
            }
        }),

        // 파일 트리에서 파일 클릭 — Explorer처럼 미리보기 탭으로 연다
        vscode.commands.registerCommand('projectHub.openProjectFile', async (project?: Project, file?: string) => {
            if (!project || !file) {
                return;
            }
            await switchBeforeRowAction(project);
            try {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { preview: true });
            } catch {
                // 바이너리 등 열 수 없는 파일은 VS Code가 자체 안내를 띄운다
            }
        }),

        vscode.commands.registerCommand('projectHub.revealFileNodeInOS', (node?: HubNode) => {
            const target = fileNodePath(node);
            if (target) {
                void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
            }
        }),

        vscode.commands.registerCommand('projectHub.copyFilePath', async (node?: HubNode) => {
            const target = fileNodePath(node);
            if (target) {
                await vscode.env.clipboard.writeText(target);
                vscode.window.setStatusBarMessage(
                    `$(clippy) ${vscode.l10n.t('Path copied: {0}', target)}`,
                    3000
                );
            }
        }),

        vscode.commands.registerCommand(
            'projectHub.openAgentById',
            async (project: Project, agentId: string, sessionId?: string) => {
                const agent = getAgent(agentId) ?? getDefaultAgent();
                // 살아 있는 세션인지는 전환 "전에" 판단해야 한다: 전환하면 완료/응답 대기 상태가
                // 확인 처리로 지워져서, 방금 누른 행의 세션이 종료된 것으로 오판되고
                // --resume으로 같은 세션을 하나 더 열게 된다 (같은 대화가 두 터미널에서 동시에 진행)
                const wasLive = manager
                    .getAgentStatuses(project)
                    .some(s => s.agentId === agent.id && s.sessionId === sessionId);
                await switchBeforeRowAction(project);

                if (sessionId && sessionId !== 'default' && canPickSessions(agent)) {
                    // 이 세션 전용으로 우리가 연 터미널이 있으면 그대로 표시
                    const existing = terminals.findSessionTerminal(project, agent.id, sessionId);
                    if (existing) {
                        existing.show(false);
                        return;
                    }
                    // 상태 행(작업 중/응답 대기/완료)에 있는 세션은 어딘가에서 살아 있는 것.
                    // 기본 터미널에서 시작된 세션은 전용 터미널이 없으므로, 같은 세션을
                    // --resume으로 또 열면 대화가 분기된다 → 그 에이전트의 기존 터미널을 표시.
                    // 상태 목록에 없어도 그 에이전트 터미널이 살아 있으면 세션이 거기서 돌고 있을 수 있다
                    // (예: --continue로 연 기본 터미널) → 새로 열지 않고 그 터미널을 보여 준다
                    if (wasLive || terminals.findLive(project, agent.id)) {
                        const live = terminals.findLive(project, agent.id) ?? terminals.findForProject(project);
                        if (live) {
                            live.show(false);
                        } else {
                            // 패널 등 터미널 밖에서 실행 중 — 새 세션을 또 띄우지 않는다
                            vscode.window.setStatusBarMessage(
                                vscode.l10n.t(
                                    'The {0} session seems to be running outside a terminal (e.g. in a panel) — no terminal to switch to.',
                                    agent.label
                                ),
                                6000
                            );
                        }
                        return;
                    }
                    // 완전히 종료된 세션만 지정 재개
                    if (hasClaudeSession(project.path, sessionId)) {
                        if (!sessionLabel(sessionId)) {
                            setSessionLabel(sessionId, sanitizeLabel(claudeSessionPreview(project.path, sessionId)));
                        }
                        ensureHooks(agent.id);
                        openAgentSession(project, agent, sessionId);
                        return;
                    }
                }

                // 같은 에이전트의 살아 있는 터미널 우선, 다음으로 프로젝트의 아무 터미널
                const fallback = terminals.findLive(project, agent.id) ?? terminals.findForProject(project);
                if (fallback) {
                    fallback.show(false);
                    return;
                }
                openAgent(project, agent, false, true);
            }
        ),

        vscode.commands.registerCommand('projectHub.pickSession', async (node?: Project | HubNode) => {
            const target =
                asProject(node) ??
                (manager.getActivePath() ? manager.findByPath(manager.getActivePath()!) : undefined);
            if (!target) {
                vscode.window.showWarningMessage(vscode.l10n.t('Target project not found.'));
                return;
            }
            const agent = getAgents().find(canPickSessions);
            if (!agent) {
                vscode.window.showWarningMessage(vscode.l10n.t('No agent supports resuming a specific session.'));
                return;
            }
            const sessions = listClaudeSessions(target.path);
            if (sessions.length === 0) {
                vscode.window.showInformationMessage(
                    vscode.l10n.t('{0}: no saved {1} sessions.', target.name, agent.label)
                );
                return;
            }
            const items = sessions.map(s => ({
                label: `$(comment-discussion) ${s.preview ? s.preview.slice(0, 60) : vscode.l10n.t('(untitled)')}`,
                description: `${relTime(s.mtime)} · ${s.id.slice(0, 8)}`,
                id: s.id,
                preview: s.preview
            }));
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: vscode.l10n.t(
                    'Select a {0} session to resume in {1} (each session opens in its own terminal)',
                    agent.label,
                    target.name
                )
            });
            if (picked) {
                // 터미널 이름에 세션 ID 대신 세션 이름(미리보기)을 쓰도록 기억
                if (picked.preview && !sessionLabel(picked.id)) {
                    setSessionLabel(picked.id, sanitizeLabel(picked.preview));
                }
                ensureHooks(agent.id);
                openAgentSession(target, agent, picked.id);
            }
        }),

        vscode.commands.registerCommand('projectHub.setProjectColor', async (node?: Project | HubNode) => {
            const project = asProject(node);
            if (!project) {
                return;
            }
            const items: Array<vscode.QuickPickItem & { value?: string }> = PALETTE.map(c => ({
                label: c.label,
                description: c.value,
                iconPath: avatars.swatch(c.value),
                value: c.value
            }));
            items.push({ label: `$(sync) ${vscode.l10n.t('Automatic (based on name)')}`, value: undefined });
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: vscode.l10n.t('Select an identification color for {0}', project.name)
            });
            if (!picked) {
                return;
            }
            await manager.setProjectColor(project, picked.value);
            if (manager.isActive(project)) {
                const updated = manager.findByPath(project.path);
                applyWindowColor(updated ?? project);
            }
        }),

        vscode.commands.registerCommand('projectHub.killProcess', async (node?: HubNode) => {
            if (!node || !('kind' in node) || node.kind !== 'proc') {
                return;
            }
            const p = node.proc;
            const killLabel = vscode.l10n.t('Kill');
            const pick = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    'Kill process {0} (PID {1}{2})?\n\nChild processes are terminated as well.',
                    p.name,
                    p.pid,
                    p.ports.length ? `, ${vscode.l10n.t('ports')} ${p.ports.join(', ')}` : ''
                ),
                { modal: true },
                killLabel
            );
            if (pick !== killLabel) {
                return;
            }
            const error = await killProcessTree(p.pid);
            manager.refresh();
            if (error) {
                vscode.window.showWarningMessage(vscode.l10n.t('Failed to kill process: {0}', error));
            }
        }),

        vscode.commands.registerCommand('projectHub.adoptTerminal', async () => {
            const terminal = vscode.window.activeTerminal;
            if (!terminal) {
                vscode.window.showWarningMessage(vscode.l10n.t('No active terminal.'));
                return;
            }
            const projects = manager.getProjects();
            if (projects.length === 0) {
                vscode.window.showWarningMessage(vscode.l10n.t('No projects registered.'));
                return;
            }
            // 활성 프로젝트를 맨 위에
            const activePath = manager.getActivePath();
            const sorted = [...projects].sort((a, b) => {
                const aActive = activePath && samePath(a.path, activePath) ? 0 : 1;
                const bActive = activePath && samePath(b.path, activePath) ? 0 : 1;
                return aActive - bActive;
            });
            const projPick = await vscode.window.showQuickPick(
                sorted.map(p => ({
                    label: p.name,
                    description: activePath && samePath(p.path, activePath) ? vscode.l10n.t('active') : undefined,
                    detail: p.path,
                    p
                })),
                { placeHolder: vscode.l10n.t('Project to attach the "{0}" terminal to', terminal.name) }
            );
            if (!projPick) {
                return;
            }
            const agentPick = await vscode.window.showQuickPick(
                getAgents().map(a => ({
                    label: a.label,
                    description: vscode.l10n.t('When {0} is running in this terminal', a.label),
                    a
                })),
                {
                    placeHolder: vscode.l10n.t(
                        'Which agent runs in this terminal? (used for grid layout, instructions, and row clicks)'
                    )
                }
            );
            if (!agentPick) {
                return;
            }
            const name = terminals.adoptTerminal(projPick.p, agentPick.a.id, terminal);
            // 이름을 규칙에 맞게 바꿔야 창 리로드 후에도 재인식됨
            terminal.show();
            await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
            manager.refresh();
            vscode.window.setStatusBarMessage(
                `$(plug) ${vscode.l10n.t('Attached to {0}: {1}', projPick.p.name, name)}`,
                5000
            );
        }),

        vscode.commands.registerCommand('projectHub.arrangeTerminalGrid', async () => {
            const all = terminals.allLiveTerminals(manager.getProjects());
            if (all.length === 0) {
                vscode.window.showInformationMessage(vscode.l10n.t('No live agent terminals.'));
                return;
            }
            // 범위 선택: 활성 프로젝트만 vs 전체 (활성 밖 터미널이 없으면 바로 진행)
            const activePath = manager.getActivePath();
            const activeProject = activePath ? manager.findByPath(activePath) : undefined;
            const activeTerms = activeProject ? terminals.allLiveTerminals([activeProject]) : [];
            let terms = all;
            if (activeProject && activeTerms.length > 0 && activeTerms.length < all.length) {
                const pick = await vscode.window.showQuickPick(
                    [
                        {
                            label: `$(multiple-windows) ${vscode.l10n.t('All projects')}`,
                            description: vscode.l10n.t('{0} terminal(s)', all.length),
                            scope: 'all' as const
                        },
                        {
                            label: `$(target) ${vscode.l10n.t('Active project only — {0}', activeProject.name)}`,
                            description: vscode.l10n.t('{0} terminal(s)', activeTerms.length),
                            scope: 'active' as const
                        }
                    ],
                    { placeHolder: vscode.l10n.t('Choose the scope to arrange in a grid') }
                );
                if (!pick) {
                    return;
                }
                terms = pick.scope === 'active' ? activeTerms : all;
            }
            if (terms.length === 1) {
                terms[0].show();
                return;
            }
            if (projectGridMode()) {
                // 이전 그리드의 터미널이 에디터에 남아 칸을 차지하지 않도록 먼저 모두 패널로
                await moveAllEditorTerminalsToPanel();
            }
            // 전체 보기: 프로젝트마다 한 칸, 프로젝트 안의 여러 터미널은 그 칸에 탭으로
            // (터미널이 한 프로젝트에만 있으면 기존처럼 터미널마다 한 칸)
            const seen = new Set<vscode.Terminal>();
            const cells = manager
                .getProjects()
                .map(p => terminals.allLiveTerminals([p]).filter(t => !seen.has(t) && (seen.add(t), true)))
                .filter(c => c.length > 0);
            if (terms === all && cells.length > 1) {
                await arrangeGrid(cells);
            } else {
                await arrangeGrid(terms.map(t => [t]));
            }
            // 활성 프로젝트 터미널만으로 구성된 그리드면 전환 시 따라가도록 기억
            const isActiveOnly =
                !!activeProject && activeTerms.length > 0 && terms.every(t => activeTerms.includes(t));
            activeGrid = isActiveOnly ? { projectPath: activeProject!.path, terminals: terms } : undefined;
        }),

        vscode.commands.registerCommand('projectHub.sendInstruction', async (node?: Project | HubNode) => {
            // 에이전트 행에서 실행하면 그 에이전트×세션이 대상, 프로젝트 행이면 살아 있는 에이전트 중 선택
            let project: Project | undefined;
            let target: { label: string; terminal: vscode.Terminal } | undefined;
            if (node && 'kind' in node && node.kind === 'agent') {
                project = node.project;
                const t = terminals.findLive(project, node.agentId, node.sessionId);
                if (t) {
                    target = { label: getAgentLabel(node.agentId), terminal: t };
                }
            } else {
                project = asProject(node);
            }
            if (!project) {
                return;
            }
            if (!target) {
                const candidates = getAgents()
                    .map(a => ({ agent: a, terminal: terminals.findLive(project!, a.id) }))
                    .filter((x): x is { agent: AgentDef; terminal: vscode.Terminal } => !!x.terminal);
                if (candidates.length === 0) {
                    const openLabel = vscode.l10n.t('Open Terminal');
                    const pick = await vscode.window.showWarningMessage(
                        vscode.l10n.t('{0}: no running agent terminals. Start an agent first.', project.name),
                        openLabel
                    );
                    if (pick === openLabel) {
                        openAgent(project, getDefaultAgent(), true, true);
                    }
                    return;
                }
                if (candidates.length === 1) {
                    target = { label: candidates[0].agent.label, terminal: candidates[0].terminal };
                } else {
                    const picked = await vscode.window.showQuickPick(
                        candidates.map(c => ({ label: c.agent.label, c })),
                        { placeHolder: vscode.l10n.t('Select the agent to send the instruction to') }
                    );
                    if (!picked) {
                        return;
                    }
                    target = { label: picked.c.agent.label, terminal: picked.c.terminal };
                }
            }
            const text = await vscode.window.showInputBox({
                prompt: vscode.l10n.t('Instruction to send to {0} · {1}', project.name, target.label),
                placeHolder: vscode.l10n.t('Typed as-is into the terminal where the agent is running'),
                ignoreFocusOut: true
            });
            if (!text || !text.trim()) {
                return;
            }
            target.terminal.sendText(text, true);
            vscode.window.setStatusBarMessage(
                `$(comment) ${vscode.l10n.t('Instruction sent to {0} · {1}', project.name, target.label)}`,
                4000
            );
        }),

        vscode.commands.registerCommand('projectHub.openBriefing', async (entry?: BriefingEntry) => {
            if (!entry) {
                return;
            }
            const project = manager.findByPath(entry.projectPath);
            if (project) {
                await switchTo(project);
            } else {
                vscode.window.setStatusBarMessage(
                    vscode.l10n.t('Project is not in the list: {0}', entry.projectName),
                    4000
                );
            }
        }),

        vscode.commands.registerCommand('projectHub.clearBriefing', async () => {
            const clearLabel = vscode.l10n.t('Clear All');
            const pick = await vscode.window.showWarningMessage(
                vscode.l10n.t('Clear all briefing entries?'),
                clearLabel,
                vscode.l10n.t('Cancel')
            );
            if (pick === clearLabel) {
                briefingStore.clear();
            }
        }),

        vscode.commands.registerCommand('projectHub.killProjectServices', async (node?: ServiceProjectNode) => {
            if (!node || node.kind !== 'svcProject' || node.procs.length === 0) {
                return;
            }
            const summary = node.procs.map(p => `${p.label} :${p.ports.join(' :')}`).join(', ');
            const stopAllLabel = vscode.l10n.t('Stop All');
            const pick = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    'Stop all {0} service(s) of {1} ({2})? Child processes are terminated as well.',
                    node.procs.length,
                    node.project.name,
                    summary
                ),
                stopAllLabel,
                vscode.l10n.t('Cancel')
            );
            if (pick !== stopAllLabel) {
                return;
            }
            const errors: string[] = [];
            for (const p of node.procs) {
                const error = await killProcessTree(p.pid);
                if (error) {
                    errors.push(`${p.label}(PID ${p.pid}): ${error}`);
                }
            }
            manager.refresh();
            if (errors.length) {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('Some services failed to stop — {0}', errors.join(' / '))
                );
            }
        }),

        vscode.commands.registerCommand('projectHub.openServiceInBrowser', async (node?: ServiceNode) => {
            if (!node || node.kind !== 'service') {
                return;
            }
            const ports = webPorts(node.proc);
            if (ports.length === 0) {
                return;
            }
            let port = ports[0];
            if (ports.length > 1) {
                // 한 프로세스가 여러 포트를 리슨하면 어느 쪽을 열지 고르게 한다
                const picked = await vscode.window.showQuickPick(
                    ports.map(p => ({ label: `$(globe) ${serviceUrl(p)}`, port: p })),
                    { placeHolder: vscode.l10n.t('Select the address to open') }
                );
                if (!picked) {
                    return;
                }
                port = picked.port;
            }
            await vscode.env.openExternal(vscode.Uri.parse(serviceUrl(port)));
        }),

        vscode.commands.registerCommand('projectHub.killService', async (node?: ServiceNode) => {
            if (!node || node.kind !== 'service') {
                return;
            }
            const p = node.proc;
            const stopLabel = vscode.l10n.t('Stop');
            const pick = await vscode.window.showWarningMessage(
                vscode.l10n.t(
                    'Stop {0} (PID {1}, :{2})? Child processes are terminated as well.',
                    p.label,
                    p.pid,
                    p.ports.join(' :')
                ),
                stopLabel,
                vscode.l10n.t('Cancel')
            );
            if (pick !== stopLabel) {
                return;
            }
            const error = await killProcessTree(p.pid);
            manager.refresh();
            if (error) {
                vscode.window.showWarningMessage(vscode.l10n.t('Failed to kill process: {0}', error));
            }
        }),

        vscode.commands.registerCommand('projectHub.restartService', async (node?: ServiceNode) => {
            if (!node || node.kind !== 'service') {
                return;
            }
            const p = node.proc;
            const project = node.project;
            const port = p.ports[0];
            // 저장된 명령 > 조상 체인의 실행 명령 > 프로세스 명령줄 순으로 미리 채움
            const command = await vscode.window.showInputBox({
                prompt: vscode.l10n.t(
                    'Restart command for {0} (:{1}) — runs in a terminal at the project root',
                    p.label,
                    port
                ),
                value: getServiceCommand(project.path, port) ?? p.launchCommand ?? p.command,
                ignoreFocusOut: true
            });
            if (!command || !command.trim()) {
                return;
            }
            setServiceCommand(project.path, port, command);
            const error = await killProcessTree(p.pid);
            if (error) {
                vscode.window.showWarningMessage(vscode.l10n.t('Failed to kill process: {0}', error));
                return;
            }
            // 포트가 풀릴 시간을 잠깐 준다
            await new Promise(resolve => setTimeout(resolve, 1500));
            const termName = `service · ${project.name} · :${port}`;
            const term =
                vscode.window.terminals.find(t => t.name === termName && t.exitStatus === undefined) ??
                vscode.window.createTerminal({
                    name: termName,
                    cwd: project.path,
                    iconPath: new vscode.ThemeIcon('radio-tower')
                });
            sendWhenReady(term, command);
            term.show(false);
            manager.refresh();
        }),

        vscode.commands.registerCommand('projectHub.revealServiceTerminal', async (node?: ServiceNode) => {
            if (!node || node.kind !== 'service') {
                return;
            }
            await switchBeforeRowAction(node.project);
            const t = terminals.findForProject(node.project);
            if (t) {
                t.show(true);
            } else {
                // 다른 창/분리 실행으로 띄운 서비스라 이 창에는 터미널이 없는 경우
                vscode.window.setStatusBarMessage(
                    vscode.l10n.t(
                        '{0}: this service has no terminal attached to this window (PID {1})',
                        node.project.name,
                        node.proc.pid
                    ),
                    4000
                );
            }
        }),

        vscode.commands.registerCommand('projectHub.toggleProcessFilter', async () => {
            const current = config().get<boolean>('showAllProcesses', false);
            await config().update('showAllProcesses', !current, vscode.ConfigurationTarget.Global);
            manager.refresh();
        }),

        vscode.commands.registerCommand('projectHub.refresh', () => {
            invalidateProcessCache();
            invalidateUsageCache();
            manager.refresh();
        })
    );

    function relTime(d: Date): string {
        const mins = Math.round((Date.now() - d.getTime()) / 60000);
        if (mins < 1) {
            return vscode.l10n.t('just now');
        }
        if (mins < 60) {
            return vscode.l10n.t('{0}m ago', mins);
        }
        const hours = Math.round(mins / 60);
        if (hours < 24) {
            return vscode.l10n.t('{0}h ago', hours);
        }
        return vscode.l10n.t('{0}d ago', Math.round(hours / 24));
    }

    // ── VS Code 완전 재시작 후 에이전트 재실행 ─────────────────────
    // 창 리로드와 달리 앱을 완전히 껐다 켜면 VS Code는 터미널 셸과 화면 내용만 복원하고
    // 그 안에서 돌던 에이전트는 종료된다. 이름 규칙으로 알아본 관리 터미널 중 셸 아래에
    // 실행 중인 프로세스가 없는 것만 골라 마지막(또는 해당) 세션을 이어서 실행한다.
    async function reviveRestoredAgents(): Promise<void> {
        if (!config().get<boolean>('resumeAgentsOnRestart', true)) {
            return;
        }
        const restored = terminals.namedTerminals(manager.getProjects()).filter(r => r.agent.command);
        if (restored.length === 0) {
            return;
        }
        invalidateProcessCache();
        // 창 리로드에서는 셸이 그대로 살아 있다(시작 시각이 확장 호스트보다 한참 이전).
        // 셸이 확장 호스트와 비슷한 시점에 새로 떴을 때만 완전 재시작으로 보고 재실행한다
        // — 사용자가 일부러 에이전트를 끄고 셸만 남겨 둔 터미널을 리로드 때 되살리지 않도록.
        const hostStart = Date.now() - process.uptime() * 1000;
        for (const r of restored) {
            const pid = await r.terminal.processId;
            if (!pid) {
                continue;
            }
            const started = await processStartTime(pid);
            if (started === undefined || started < hostStart - 60_000) {
                continue;
            }
            // 조회 실패(undefined)면 실행 중일 수도 있으므로 건드리지 않는다
            if ((await hasRunningChild(pid)) !== false) {
                continue;
            }
            let command: string | undefined;
            if (r.tag && canPickSessions(r.agent)) {
                const session = listClaudeSessions(r.project.path, 100).find(x => sessionTag(x.id) === r.tag);
                command = session ? resolveSessionCommand(r.agent, session.id) : undefined;
            }
            command ??= resolveCommand(r.agent, true, r.project.path);
            ensureHooks(r.agent.id);
            sendWhenReady(r.terminal, command);
        }
    }
    // ── 원격 재연결 시 tmux 세션에 다시 붙기 ───────────────────────
    // 원격 서버가 재시작돼 터미널이 사라져도 tmux 세션(에이전트)은 살아 있다.
    // 살아 있는 우리 세션마다 관리 터미널이 없으면 열어서 붙는다
    // (open/openSession이 보내는 tmux new-session -A 가 기존 세션에 attach).
    function reattachTmuxSessions(): void {
        for (const s of liveTmuxSessions()) {
            const project = manager.findByPath(s.projectPath);
            const agent = project ? getAgent(s.agentId) : undefined;
            if (!project || !agent) {
                continue;
            }
            if (s.sessionId) {
                if (!terminals.findSessionTerminal(project, agent.id, s.sessionId)) {
                    terminals.openSession(project, agent, s.sessionId, false);
                }
            } else if (!terminals.findLive(project, agent.id)) {
                terminals.open(project, agent, false, false);
            }
        }
    }

    // ── 다른 창에서 요청한 전환 ────────────────────────────────────
    // 다른 PC·서버 목록의 프로젝트를 누르면 그 호스트의 창을 열면서 전환 요청을 남긴다.
    // 새로 열린 창은 시작할 때, 이미 열려 있던 창은 포커스를 받을 때 요청을 수행한다.
    async function applyPendingSwitch(): Promise<void> {
        const target = await takePendingSwitch();
        const project = target ? manager.findByPath(target) : undefined;
        if (project && !manager.isActive(project)) {
            await switchTo(project);
        }
    }
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(e => {
            if (e.focused) {
                // 다른 창이 목록을 바꿨을 수 있으므로 트리 갱신
                manager.refresh();
                void applyPendingSwitch();
            }
        })
    );

    // 복원된 셸이 프롬프트를 띄울 시간을 준 뒤 확인하고, 그리드 모드면 활성 프로젝트 그리드 구성
    setTimeout(async () => {
        await applyPendingSwitch();
        reattachTmuxSessions();
        await reviveRestoredAgents();
        const activePath = manager.getActivePath();
        const active = activePath ? manager.findByPath(activePath) : undefined;
        if (active && projectGridMode()) {
            await regridProject(active);
        }
    }, 3000);

    function offerHookSetup(project: Project): void {
        if (hasAgentHooks(getDefaultAgent().id)) {
            return;
        }
        const setupLabel = vscode.l10n.t('Set Up Notifications');
        vscode.window
            .showInformationMessage(
                vscode.l10n.t(
                    '{0}: installing hooks is required to get agent completion notifications (once, applies everywhere).',
                    project.name
                ),
                setupLabel,
                vscode.l10n.t('Later')
            )
            .then(pick => {
                if (pick === setupLabel) {
                    vscode.commands.executeCommand('projectHub.setupNotifications');
                }
            });
    }
}

export function deactivate(): void {}
