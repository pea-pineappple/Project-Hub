import * as vscode from 'vscode';
import * as os from 'os';
import { Project } from './types';

/**
 * 여러 PC·서버의 프로젝트 목록을 한 목록에서 보이게 하는 공유 레지스트리.
 *
 * VS Code 창 하나는 로컬 또는 원격 한 곳에만 연결되므로 다른 곳의 프로젝트는 같은 창에서
 * 전환할 수 없다. 대신 각 창이 자기 호스트의 프로젝트 목록을 globalState에 올리고,
 * 다른 호스트 항목을 누르면 그 호스트에 연결된 창을 연다(이미 열려 있으면 VS Code가 그 창으로 이동).
 *
 * globalState를 쓰는 이유: 원격(SSH) 창의 확장도 globalState는 로컬 PC 쪽 저장소를 함께 쓰므로,
 * 로컬 창과 원격 창이 별도 통신 없이 서로의 목록을 읽을 수 있다.
 */

const REGISTRY_KEY = 'projectHub.hostRegistry';
const PENDING_KEY = 'projectHub.pendingSwitch';
/** 다른 창에서 요청한 전환을 이 시간 안에만 수행 (오래된 요청이 엉뚱할 때 실행되지 않도록) */
const PENDING_TTL_MS = 3 * 60 * 1000;

export type HostKind = 'local' | 'ssh';

export interface HostEntry {
    key: string;
    kind: HostKind;
    /** 표시 이름 (호스트명) */
    label: string;
    /** SSH 원격 권한 문자열 (예: ssh-remote+user@10.0.0.5) — 로컬이면 없음 */
    authority?: string;
    /** 그 호스트의 허브 워크스페이스 파일 경로 (있으면 이걸 열어 새로고침 없는 전환 유지) */
    hubFile?: string;
    projects: Project[];
    updated: number;
}

interface PendingSwitch {
    hostKey: string;
    path: string;
    at: number;
}

let memento: vscode.Memento | undefined;

export function initHostRegistry(context: vscode.ExtensionContext): void {
    memento = context.globalState;
}

/**
 * 지금 이 확장이 실행 중인 호스트. SSH 외의 원격(WSL, 컨테이너 등)은 다시 열 방법이 없어 undefined.
 * SSH 권한 문자열은 SSH_CONNECTION(클라이언트IP 포트 서버IP 포트)의 서버 IP와 사용자명으로 만든다.
 * ~/.ssh/config의 Host 별칭은 서버에서 알 수 없으므로 IP로 접속한다 (config의 Host가 IP면 User 등도 적용됨).
 */
export function currentHost(): { key: string; kind: HostKind; label: string; authority?: string } | undefined {
    const remote = vscode.env.remoteName;
    if (!remote) {
        return { key: `local:${os.hostname()}`, kind: 'local', label: os.hostname() };
    }
    if (remote !== 'ssh-remote') {
        return undefined;
    }
    const serverIp = (process.env.SSH_CONNECTION ?? '').trim().split(/\s+/)[2];
    if (!serverIp) {
        return undefined;
    }
    const user = os.userInfo().username;
    // 22가 아닌 포트는 ~/.ssh/config의 해당 IP 항목(Port)으로 적용된다
    return {
        key: `ssh:${user}@${serverIp}`,
        kind: 'ssh',
        label: os.hostname(),
        authority: `ssh-remote+${user}@${serverIp}`
    };
}

function readRegistry(): Record<string, HostEntry> {
    return memento?.get<Record<string, HostEntry>>(REGISTRY_KEY, {}) ?? {};
}

/** 이 호스트의 프로젝트 목록을 레지스트리에 올린다 (창 시작 시와 목록 변경 시) */
export async function publishHost(projects: Project[], hubFile: string | undefined): Promise<void> {
    const host = currentHost();
    if (!host || !memento) {
        return;
    }
    const registry = { ...readRegistry() };
    registry[host.key] = { ...host, hubFile, projects, updated: Date.now() };
    await memento.update(REGISTRY_KEY, registry);
}

/** 다른 호스트들 (프로젝트가 있는 것만, 이름 순) */
export function otherHosts(): HostEntry[] {
    const me = currentHost()?.key;
    return Object.values(readRegistry())
        .filter(h => h.key !== me && h.projects.length > 0)
        .sort((a, b) => a.label.localeCompare(b.label));
}

export async function forgetHost(key: string): Promise<void> {
    if (!memento) {
        return;
    }
    const registry = { ...readRegistry() };
    delete registry[key];
    await memento.update(REGISTRY_KEY, registry);
}

/** 이 창(호스트)에서 해야 할 전환 요청이 있으면 꺼내고 지운다 */
export async function takePendingSwitch(): Promise<string | undefined> {
    const host = currentHost();
    const pending = memento?.get<PendingSwitch>(PENDING_KEY);
    if (!host || !pending || pending.hostKey !== host.key) {
        return undefined;
    }
    await memento!.update(PENDING_KEY, undefined);
    return Date.now() - pending.at < PENDING_TTL_MS ? pending.path : undefined;
}

/** Windows 경로를 URI 경로로 (c:\a\b → /c:/a/b). 원격(리눅스) 확장 호스트에서도 동작하도록 직접 변환 */
function toUriPath(p: string): string {
    const slashed = p.replace(/\\/g, '/');
    return slashed.startsWith('/') ? slashed : `/${slashed}`;
}

/**
 * 다른 호스트의 프로젝트를 연다: 그 호스트의 허브 워크스페이스(없으면 프로젝트 폴더)를 새 창으로 열고,
 * 그 창의 확장이 시작·포커스될 때 전환 요청을 읽어 해당 프로젝트로 바꾼다.
 * 같은 워크스페이스가 이미 다른 창에 열려 있으면 VS Code가 새 창 대신 그 창으로 이동한다.
 */
export async function openOnHost(host: HostEntry, project: Project): Promise<void> {
    if (!memento) {
        return;
    }
    const target = host.hubFile ?? project.path;
    let uri: vscode.Uri;
    if (host.kind === 'ssh') {
        if (!host.authority) {
            return;
        }
        uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: host.authority, path: toUriPath(target) });
    } else if (vscode.env.remoteName) {
        // 원격 창 → 로컬: 원격 확장 호스트에서는 vscode-local 스킴이 로컬 file:로 변환된다
        uri = vscode.Uri.from({ scheme: 'vscode-local', path: toUriPath(target) });
    } else {
        uri = vscode.Uri.file(target);
    }
    const pending: PendingSwitch = { hostKey: host.key, path: project.path, at: Date.now() };
    await memento.update(PENDING_KEY, pending);
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
}
