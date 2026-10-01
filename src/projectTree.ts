import * as vscode from 'vscode';
import * as path from 'path';
import { Project, ProjectStatus, STATUS_LABEL } from './types';
import { ProjectManager } from './projectManager';
import { AvatarStore } from './avatars';
import { getAgentLabel } from './agents';
import { normalizePath, samePath } from './paths';
import { TerminalManager } from './terminalManager';
import { BgProcess, getBackgroundProcesses } from './processTree';
import { DirEntry, listDir } from './fileTree';
import { ProjectUsage, formatCost, formatTokens, getProjectUsage } from './usage';
import { sessionLabel } from './sessionLabels';
import { HostEntry, currentHost, otherHosts } from './hostRegistry';

export type HubNode =
    | { kind: 'project'; project: Project }
    | { kind: 'agent'; project: Project; agentId: string; sessionId: string; status: ProjectStatus; detail?: string }
    | { kind: 'services'; project: Project }
    | { kind: 'proc'; project: Project; proc: BgProcess }
    | { kind: 'procToggle'; project: Project; hiddenCount: number; showAll: boolean }
    | { kind: 'usage'; project: Project; usage: ProjectUsage }
    | { kind: 'path'; project: Project }
    | { kind: 'files'; project: Project }
    | { kind: 'dir'; project: Project; path: string }
    | { kind: 'file'; project: Project; path: string }
    // 다른 PC·서버의 프로젝트 (누르면 그 호스트에 연결된 창을 연다)
    // current: 이 창이 연결된 장비 — 자식이 실제 프로젝트 노드(전환 가능)
    | { kind: 'host'; host: HostEntry; current?: boolean; project?: undefined }
    | { kind: 'hostProject'; host: HostEntry; project: Project };

/** 트리 컨텍스트 메뉴/명령 인자에서 Project 꺼내기 (루트/자식 노드 모두 지원) */
export function asProject(arg?: Project | HubNode): Project | undefined {
    if (!arg) {
        return undefined;
    }
    if (!('kind' in arg)) {
        return arg;
    }
    // 다른 호스트의 프로젝트는 이 창에서 다룰 수 없다
    return arg.kind === 'host' || arg.kind === 'hostProject' ? undefined : arg.project;
}

/** 하위 행 클릭이 프로젝트 전환도 하는 설정이면 툴팁에 안내를 덧붙인다 (서비스 뷰와 공용) */
export function switchHint(): string {
    return vscode.workspace.getConfiguration('projectHub').get<boolean>('switchOnRowClick', true)
        ? '\n' + vscode.l10n.t('Also switches to this project (projectHub.switchOnRowClick)')
        : '';
}

const STATUS_ICON: Record<ProjectStatus, vscode.ThemeIcon> = {
    idle: new vscode.ThemeIcon('circle-outline'),
    working: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow')),
    done: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')),
    attention: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange'))
};

export class ProjectTreeProvider implements vscode.TreeDataProvider<HubNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private manager: ProjectManager,
        private avatars: AvatarStore,
        private terminals: TerminalManager
    ) {
        manager.onDidChange(() => this._onDidChangeTreeData.fire());
    }

    getTreeItem(node: HubNode): vscode.TreeItem {
        if (node.kind === 'host') {
            const isSsh = node.host.kind === 'ssh';
            const item = new vscode.TreeItem(
                node.host.label,
                node.current ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
            );
            item.id = `${node.current ? 'hc' : 'h'}:${node.host.key}`;
            item.iconPath = new vscode.ThemeIcon(isSsh ? 'remote' : 'device-desktop');
            item.description =
                `${isSsh ? 'SSH' : vscode.l10n.t('Local')} · ${node.host.projects.length}` +
                (node.current ? ` · ${vscode.l10n.t('this window')}` : '');
            // 현재 장비는 목록에서 숨길 수 없다
            item.contextValue = node.current ? 'currentHostRow' : 'hostRow';
            item.tooltip = isSsh
                ? vscode.l10n.t('Projects on SSH server {0} ({1})', node.host.label, node.host.authority?.replace(/^ssh-remote\+/, '') ?? '')
                : vscode.l10n.t('Projects on local PC {0}', node.host.label);
            return item;
        }

        if (node.kind === 'hostProject') {
            const item = new vscode.TreeItem(node.project.name, vscode.TreeItemCollapsibleState.None);
            item.id = `hp:${node.host.key}:${node.project.path}`;
            item.iconPath = new vscode.ThemeIcon('link-external');
            item.contextValue = 'hostProjectRow';
            item.tooltip =
                `${node.project.path}\n\n` +
                vscode.l10n.t(
                    'Click: open in a window connected to {0} (switches to it if already open)',
                    node.host.label
                );
            item.command = {
                command: 'projectHub.openOnHost',
                title: 'Open on Host',
                arguments: [node.host, node.project]
            };
            return item;
        }

        if (node.kind === 'agent') {
            // 같은 에이전트의 세션이 둘 이상이면 세션 ID 앞부분을 붙여 구분
            const siblings = this.manager
                .getAgentStatuses(node.project)
                .filter(s => s.agentId === node.agentId).length;
            const tag =
                node.sessionId !== 'default' && siblings > 1
                    ? ` · ${sessionLabel(node.sessionId) ?? node.sessionId.slice(0, 8)}`
                    : '';
            const item = new vscode.TreeItem(
                `${getAgentLabel(node.agentId)}${tag} ${STATUS_LABEL[node.status]}`,
                vscode.TreeItemCollapsibleState.None
            );
            item.id = `a:${node.agentId}:${node.sessionId}:${normalizePath(node.project.path)}`;
            item.iconPath = STATUS_ICON[node.status];
            item.contextValue = 'agentRow';
            // 무슨 작업인지 (UserPromptSubmit hook의 프롬프트) — 옆에 흐리게 표시
            if (node.detail) {
                const d = node.detail.replace(/\s+/g, ' ').trim();
                item.description = d.length > 60 ? `${d.slice(0, 60)}…` : d;
            }
            item.tooltip =
                (node.detail ? `"${node.detail}"\n\n` : '') +
                (node.sessionId !== 'default'
                    ? vscode.l10n.t("Session {0}\nClick: open this session's terminal", node.sessionId)
                    : vscode.l10n.t('Click: open agent terminal')) +
                switchHint();
            item.command = {
                command: 'projectHub.openAgentById',
                title: 'Open Agent Terminal',
                arguments: [node.project, node.agentId, node.sessionId]
            };
            return item;
        }

        if (node.kind === 'files') {
            const item = new vscode.TreeItem(vscode.l10n.t('Files'), vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `fr:${normalizePath(node.project.path)}`;
            item.iconPath = new vscode.ThemeIcon('files');
            item.contextValue = 'filesRow';
            item.tooltip = vscode.l10n.t('Project files — read one level at a time as you expand');
            return item;
        }

        if (node.kind === 'dir' || node.kind === 'file') {
            const isDir = node.kind === 'dir';
            const item = new vscode.TreeItem(
                path.basename(node.path),
                isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            );
            item.id = `${isDir ? 'fd' : 'ff'}:${normalizePath(node.path)}`;
            // resourceUri + File/Folder 테마 아이콘 → 현재 파일 아이콘 테마의 확장자별 아이콘이
            // 그대로 적용되고, Git·문제(Problems) 데코레이션 색상까지 Explorer와 동일해진다.
            item.resourceUri = vscode.Uri.file(node.path);
            item.iconPath = isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
            item.contextValue = isDir ? 'dirRow' : 'fileRow';
            if (!isDir) {
                item.command = {
                    command: 'projectHub.openProjectFile',
                    title: 'Open File',
                    arguments: [node.project, node.path]
                };
            }
            return item;
        }

        if (node.kind === 'services') {
            const item = new vscode.TreeItem(
                vscode.l10n.t('Background Processes'),
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.id = `s:${normalizePath(node.project.path)}`;
            item.iconPath = new vscode.ThemeIcon('server-process');
            item.contextValue = 'servicesRow';
            item.tooltip = vscode.l10n.t("Processes running under this project's agent terminals (queried on expand)");
            return item;
        }

        if (node.kind === 'proc') {
            const p = node.proc;
            const item = new vscode.TreeItem(p.label, vscode.TreeItemCollapsibleState.None);
            item.id = `x:${p.pid}:${normalizePath(node.project.path)}`;
            item.description = p.ports.length
                ? `:${p.ports.join(' :')} · PID ${p.pid}`
                : `PID ${p.pid}`;
            item.iconPath = p.ports.length
                ? new vscode.ThemeIcon('radio-tower', new vscode.ThemeColor('charts.blue'))
                : new vscode.ThemeIcon('gear');
            item.contextValue = 'procRow';
            item.tooltip = new vscode.MarkdownString(
                `**${p.label}** — ${p.name} (PID ${p.pid})` +
                (p.ports.length ? `\n\n${vscode.l10n.t('Listening ports: {0}', p.ports.join(', '))}` : '') +
                (p.command ? `\n\n\`${p.command.slice(0, 400)}\`` : '')
            );
            return item;
        }

        if (node.kind === 'procToggle') {
            const item = new vscode.TreeItem(
                node.showAll
                    ? vscode.l10n.t('Show essential processes only')
                    : vscode.l10n.t('{0} MCP/helper processes hidden', node.hiddenCount),
                vscode.TreeItemCollapsibleState.None
            );
            item.id = `xt:${normalizePath(node.project.path)}`;
            item.iconPath = new vscode.ThemeIcon('filter');
            item.contextValue = 'procToggleRow';
            item.description = node.showAll ? '' : vscode.l10n.t('Click to show all');
            item.tooltip = node.showAll
                ? vscode.l10n.t('Show only processes with listening ports or launched directly from the terminal')
                : vscode.l10n.t('Show everything including MCP servers and helpers spawned internally by the agent');
            item.command = {
                command: 'projectHub.toggleProcessFilter',
                title: 'Toggle Process Filter'
            };
            return item;
        }

        if (node.kind === 'usage') {
            const u = node.usage;
            const item = new vscode.TreeItem(vscode.l10n.t('Usage'), vscode.TreeItemCollapsibleState.None);
            item.id = `u:${normalizePath(node.project.path)}`;
            item.iconPath = new vscode.ThemeIcon('graph');
            item.contextValue = 'usageRow';
            item.description =
                u.today.cost > 0
                    ? vscode.l10n.t('{0} · today {1}', formatCost(u.total.cost), formatCost(u.today.cost))
                    : formatCost(u.total.cost);
            const lines = [
                vscode.l10n.t('**Claude usage** (estimate based on saved sessions)'),
                '',
                vscode.l10n.t(
                    'Total: {0} · input {1} / output {2} / cache read {3} / cache write {4}',
                    formatCost(u.total.cost),
                    formatTokens(u.total.input),
                    formatTokens(u.total.output),
                    formatTokens(u.total.cacheRead),
                    formatTokens(u.total.cacheWrite)
                ),
                vscode.l10n.t(
                    'Today: {0} · input {1} / output {2}',
                    formatCost(u.today.cost),
                    formatTokens(u.today.input),
                    formatTokens(u.today.output)
                )
            ];
            if (u.byModel.size) {
                lines.push('', vscode.l10n.t('By model:'));
                for (const [model, t] of [...u.byModel].sort((a, b) => b[1].cost - a[1].cost)) {
                    lines.push(
                        `- ${model}: ${formatCost(t.cost)} (${vscode.l10n.t('output {0}', formatTokens(t.output))})`
                    );
                }
            }
            if (u.unknownModels.length) {
                lines.push('', vscode.l10n.t('Models without pricing (cost excluded): {0}', u.unknownModels.join(', ')));
            }
            const hint = switchHint();
            if (hint) {
                lines.push('', hint.trim());
            }
            item.tooltip = new vscode.MarkdownString(lines.join('\n'));
            item.command = {
                command: 'projectHub.switchFromRow',
                title: 'Switch Project',
                arguments: [node.project]
            };
            return item;
        }

        if (node.kind === 'path') {
            const item = new vscode.TreeItem(node.project.path, vscode.TreeItemCollapsibleState.None);
            item.id = `d:${normalizePath(node.project.path)}`;
            item.iconPath = new vscode.ThemeIcon('folder');
            item.contextValue = 'pathRow';
            item.tooltip = vscode.l10n.t('Open in file explorer');
            item.command = {
                command: 'revealFileInOS',
                title: 'Reveal in File Explorer',
                arguments: [vscode.Uri.file(node.project.path)]
            };
            return item;
        }

        const project = node.project;
        const active = this.manager.isActive(project);
        const status = this.manager.getStatus(project);

        // 상태 텍스트는 옆(description)이 아니라 아래 자식 행으로 표시한다.
        // 상태가 생기거나 활성이 되면 자동으로 펼쳐지도록, 펼침 여부를 id에 반영
        // (VS Code는 id 기준으로 접힘 상태를 기억하므로 id가 바뀌어야 재적용됨).
        const shouldExpand = active || status !== 'idle';
        const item = new vscode.TreeItem(
            project.name,
            shouldExpand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `p:${normalizePath(project.path)}:${shouldExpand ? 'e' : 'c'}`;
        item.contextValue = 'project';
        // FileDecoration(활성 프로젝트 강조색)용 가상 URI.
        // Uri.parse는 %2F를 '/'로 되돌려 리눅스 경로(/home/…)가 "//home/…"이 되어 UriError가 나므로
        // Uri.from으로 인코딩된 경로를 그대로 둔다 (읽는 쪽에서 decodeURIComponent)
        item.resourceUri = vscode.Uri.from({
            scheme: 'projecthub',
            path: `/${encodeURIComponent(normalizePath(project.path))}`
        });
        item.iconPath = this.avatars.avatar(project, status, active);
        item.command = {
            command: 'projectHub.switchProject',
            title: 'Switch Project',
            arguments: [project]
        };
        item.description = active ? vscode.l10n.t('active') : undefined;

        const statusParts: string[] = [];
        for (const s of this.manager.getAgentStatuses(project)) {
            if (STATUS_LABEL[s.status]) {
                const tag = s.sessionId !== 'default' ? `(${s.sessionId.slice(0, 8)})` : '';
                statusParts.push(`${getAgentLabel(s.agentId)}${tag} ${STATUS_LABEL[s.status]}`);
            }
        }
        item.tooltip = new vscode.MarkdownString(
            `**${project.name}**${active ? ` · ${vscode.l10n.t('active')}` : ''}\n\n${project.path}` +
            (statusParts.length ? `\n\n${statusParts.join(', ')}` : '')
        );
        return item;
    }

    /**
     * 다른 장비가 있을 때만 현재 장비를 그룹으로 감싼다 (장비 → 프로젝트).
     * 장비가 하나뿐이면 계층이 한 단계 늘기만 하므로 예전처럼 프로젝트를 바로 보여 준다.
     */
    private thisHostNode(): HubNode | undefined {
        const host = currentHost();
        if (!host || otherHosts().length === 0) {
            return undefined;
        }
        return { kind: 'host', current: true, host: { ...host, projects: this.manager.getProjects(), updated: 0 } };
    }

    /** treeView.reveal(전환 시 활성 항목 선택)에 필요 */
    getParent(node: HubNode): HubNode | undefined {
        if (node.kind === 'host') {
            return undefined;
        }
        if (node.kind === 'project') {
            return this.thisHostNode();
        }
        if (node.kind === 'hostProject') {
            return { kind: 'host', host: node.host };
        }
        if (node.kind === 'proc' || node.kind === 'procToggle') {
            return { kind: 'services', project: node.project };
        }
        if (node.kind === 'dir' || node.kind === 'file') {
            const parent = path.dirname(node.path);
            return samePath(parent, node.project.path)
                ? { kind: 'files', project: node.project }
                : { kind: 'dir', project: node.project, path: parent };
        }
        return { kind: 'project', project: node.project };
    }

    async getChildren(node?: HubNode): Promise<HubNode[]> {
        const ownProjects = () => this.manager.getProjects().map(project => ({ kind: 'project' as const, project }));
        if (!node) {
            // 장비 → 프로젝트: 현재 장비(펼침)를 맨 위에, 다른 PC·서버를 그 아래 같은 계층에
            const me = this.thisHostNode();
            const others = otherHosts().map(host => ({ kind: 'host' as const, host }));
            return me ? [me, ...others] : [...ownProjects(), ...others];
        }
        if (node.kind === 'host') {
            return node.current
                ? ownProjects()
                : node.host.projects.map(project => ({ kind: 'hostProject' as const, host: node.host, project }));
        }
        if (node.kind === 'services') {
            const pids = await this.terminals.getManagedPids(node.project);
            const showAll = vscode.workspace
                .getConfiguration('projectHub')
                .get<boolean>('showAllProcesses', false);
            const { shown, hiddenCount } = await getBackgroundProcesses(pids, showAll);
            const rows: HubNode[] = shown.map(proc => ({ kind: 'proc' as const, project: node.project, proc }));
            if (hiddenCount > 0 || showAll) {
                rows.push({ kind: 'procToggle', project: node.project, hiddenCount, showAll });
            }
            return rows;
        }
        if (node.kind === 'files' || node.kind === 'dir') {
            const dir = node.kind === 'files' ? node.project.path : node.path;
            const toNode = (e: DirEntry): HubNode =>
                e.isDir
                    ? { kind: 'dir', project: node.project, path: e.path }
                    : { kind: 'file', project: node.project, path: e.path };
            return (await listDir(dir)).map(toNode);
        }
        if (node.kind !== 'project') {
            return [];
        }
        const rows: HubNode[] = [];
        for (const s of this.manager.getAgentStatuses(node.project)) {
            rows.push({
                kind: 'agent',
                project: node.project,
                agentId: s.agentId,
                sessionId: s.sessionId,
                status: s.status,
                detail: s.detail
            });
        }
        rows.push({ kind: 'files', project: node.project });
        // 에이전트 터미널이 살아 있을 때만 백그라운드 프로세스 노드 표시
        if (this.terminals.hasAnyManaged(node.project)) {
            rows.push({ kind: 'services', project: node.project });
        }
        // Claude 세션이 있는 프로젝트만 사용량 표시 (30초 캐시, 늘어난 부분만 파싱)
        const usage = await getProjectUsage(node.project.path);
        if (usage && usage.total.cost > 0) {
            rows.push({ kind: 'usage', project: node.project, usage });
        }
        rows.push({ kind: 'path', project: node.project });
        return rows;
    }
}

/** 프로젝트 드래그로 순서 변경 */
export class ProjectDragAndDrop implements vscode.TreeDragAndDropController<HubNode> {
    static readonly MIME = 'application/vnd.code.tree.projecthub.projects';
    readonly dragMimeTypes = [ProjectDragAndDrop.MIME];
    readonly dropMimeTypes = [ProjectDragAndDrop.MIME];

    constructor(private manager: ProjectManager) {}

    handleDrag(source: readonly HubNode[], dataTransfer: vscode.DataTransfer): void {
        const project = source.find(n => n.kind === 'project');
        if (project) {
            dataTransfer.set(ProjectDragAndDrop.MIME, new vscode.DataTransferItem(project.project.path));
        }
    }

    async handleDrop(target: HubNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const item = dataTransfer.get(ProjectDragAndDrop.MIME);
        if (!item) {
            return;
        }
        const srcPath = await item.asString();
        await this.manager.moveProject(srcPath, target ? asProject(target)?.path : undefined);
    }
}
