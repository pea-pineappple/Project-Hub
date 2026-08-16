import * as vscode from 'vscode';
import { Project } from './types';
import { ProjectManager } from './projectManager';
import { TerminalManager } from './terminalManager';
import { AvatarStore } from './avatars';
import {
    BgProcess,
    getBackgroundProcesses,
    getListeningServicesByProject,
    serviceUrl,
    webPorts
} from './processTree';
import { normalizePath } from './paths';
import { switchHint } from './projectTree';

export type SvcNode =
    | { kind: 'svcProject'; project: Project; procs: BgProcess[] }
    | { kind: 'service'; project: Project; proc: BgProcess };

export type ServiceNode = Extract<SvcNode, { kind: 'service' }>;
export type ServiceProjectNode = Extract<SvcNode, { kind: 'svcProject' }>;

/**
 * 사이드바 "서비스" 섹션: 프로젝트명 아래에 리슨 중인 프로세스를 하위 트리로 표시.
 *   ▾ qroad_sales_tool   :3100 · :8100   ⏹(전체 종료)
 *       next     :3100                   ⏹
 *       uvicorn  :8100                   ⏹
 *
 * 수집은 두 경로의 합집합:
 *  1) 경로 매칭 — 명령줄/조상 체인에 프로젝트 경로가 드러나는 리슨 프로세스
 *     (다른 창·Start-Process 분리 실행도 잡힘)
 *  2) 관리 터미널 자손 — 상대 경로 실행 등으로 경로가 안 드러나는 경우 보완
 */
export class ServicesTreeProvider implements vscode.TreeDataProvider<SvcNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private manager: ProjectManager,
        private avatars: AvatarStore,
        private terminals: TerminalManager
    ) {
        // 훅 이벤트(작업 중/완료)마다 함께 갱신 — 에이전트가 서버를 띄웠으면 이때 잡힘
        manager.onDidChange(() => this._onDidChangeTreeData.fire());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(node: SvcNode): vscode.TreeItem {
        if (node.kind === 'svcProject') {
            const item = new vscode.TreeItem(node.project.name, vscode.TreeItemCollapsibleState.Expanded);
            item.id = `svcp:${normalizePath(node.project.path)}`;
            item.description = node.procs.flatMap(p => p.ports).map(p => `:${p}`).join(' ');
            item.iconPath = this.avatars.avatar(
                node.project,
                this.manager.getStatus(node.project),
                this.manager.isActive(node.project)
            );
            item.contextValue = 'serviceProjectRow';
            item.tooltip = new vscode.MarkdownString(
                vscode.l10n.t('**{0}** — {1} running service(s)', node.project.name, node.procs.length) +
                '\n\n' +
                node.procs.map(p => `- ${p.label} :${p.ports.join(' :')} (PID ${p.pid})`).join('\n')
            );
            return item;
        }

        const p = node.proc;
        const item = new vscode.TreeItem(p.label, vscode.TreeItemCollapsibleState.None);
        item.id = `svc:${p.pid}`;
        item.description = `:${p.ports.join(' :')} · PID ${p.pid}`;
        item.iconPath = new vscode.ThemeIcon('radio-tower', new vscode.ThemeColor('charts.blue'));
        // 웹으로 열 수 있는 서비스만 '브라우저에서 열기' 메뉴가 뜨도록 구분
        const web = webPorts(p);
        item.contextValue = web.length ? 'serviceRowWeb' : 'serviceRow';
        item.tooltip = new vscode.MarkdownString(
            `**${p.label}** — ${p.name} (PID ${p.pid})\n\n` +
            `${vscode.l10n.t('Project: {0}', node.project.name)}\n\n` +
            vscode.l10n.t('Listening ports: {0}', p.ports.join(', ')) +
            // 툴팁에서 바로 눌러 열 수 있게 링크로 (MarkdownString의 일반 http 링크)
            (web.length ? `\n\n${web.map(port => `[${serviceUrl(port)}](${serviceUrl(port)})`).join(' · ')}` : '') +
            (p.command ? `\n\n\`${p.command.slice(0, 400)}\`` : '') +
            (switchHint() ? `\n\n${switchHint().trim()}` : '')
        );
        item.command = {
            command: 'projectHub.revealServiceTerminal',
            title: 'Show Terminal',
            arguments: [node]
        };
        return item;
    }

    async getChildren(node?: SvcNode): Promise<SvcNode[]> {
        if (node) {
            return node.kind === 'svcProject'
                ? node.procs.map(proc => ({ kind: 'service' as const, project: node.project, proc }))
                : [];
        }
        const projects = this.manager.getProjects();
        const grouped = new Map<string, BgProcess[]>();
        const seenPids = new Set<number>();
        const add = (project: Project, proc: BgProcess) => {
            if (seenPids.has(proc.pid)) {
                return;
            }
            seenPids.add(proc.pid);
            const key = normalizePath(project.path);
            const list = grouped.get(key) ?? [];
            list.push(proc);
            grouped.set(key, list);
        };
        // 1) 경로 매칭
        const byPath = await getListeningServicesByProject(projects.map(p => normalizePath(p.path)));
        for (const project of projects) {
            for (const proc of byPath.get(normalizePath(project.path)) ?? []) {
                add(project, proc);
            }
        }
        // 2) 관리 터미널 자손 보완
        for (const project of projects) {
            const pids = await this.terminals.getManagedPids(project);
            if (pids.length === 0) {
                continue;
            }
            const { shown } = await getBackgroundProcesses(pids, true);
            for (const proc of shown) {
                if (proc.ports.length > 0) {
                    add(project, proc);
                }
            }
        }
        return projects
            .filter(p => grouped.has(normalizePath(p.path)))
            .map(project => ({
                kind: 'svcProject' as const,
                project,
                procs: grouped.get(normalizePath(project.path))!
            }));
    }
}
