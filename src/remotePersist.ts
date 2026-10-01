import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { Project } from './types';
import { normalizePath } from './paths';

/**
 * 원격(SSH 등) 연결에서 에이전트를 tmux 세션 안에서 실행해, 연결이 끊기거나
 * 원격 VS Code 서버가 재시작돼도 에이전트가 계속 돌게 한다 (원격이면 항상 적용).
 *
 * 원격 연결에서는 이 확장 자체가 원격 서버에서 실행되므로 tmux 설치 여부를 직접 확인할 수 있다.
 * 셸 조건문(command -v tmux && … || …)은 bash/zsh/fish 문법이 달라 쓰지 않는다.
 * tmux가 없으면 일반 터미널로 실행하고 안내만 한 번 띄운다.
 */

const SESSIONS_KEY = 'projectHub.tmuxSessions';
const NO_TMUX_DISMISSED_KEY = 'projectHub.noTmuxNoticeDismissed';
/** 이 확장이 만든 tmux 세션 이름 접두사 — 재연결 시 우리 세션만 골라 붙기 위해 */
const PREFIX = 'ph-';

export interface TmuxSessionInfo {
    projectPath: string;
    agentId: string;
    sessionId?: string;
}

let memento: vscode.Memento | undefined;
let noticeShownThisWindow = false;

export function initRemotePersist(context: vscode.ExtensionContext): void {
    memento = context.globalState;
}

/** 원격 연결(Windows가 아닌 원격 호스트)이면 적용 — 로컬 창에는 영향 없음 */
export function persistEnabled(): boolean {
    return !!vscode.env.remoteName && process.platform !== 'win32';
}

/** 매번 확인 — 나중에 tmux를 설치하면 바로 반영되도록 (실행 비용 수 ms) */
export function hasTmux(): boolean {
    try {
        execFileSync('tmux', ['-V'], { timeout: 2000, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** tmux 세션 이름: 이름·경로 해시·에이전트(·세션). tmux는 '.'과 ':'을 허용하지 않는다 */
export function tmuxSessionName(project: Project, agentId: string, sessionId?: string): string {
    const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24);
    const hash = crypto.createHash('sha1').update(normalizePath(project.path)).digest('hex').slice(0, 4);
    const parts = [slug(project.name), hash, slug(agentId)];
    if (sessionId) {
        parts.push(sessionId.slice(0, 8));
    }
    return PREFIX + parts.join('-');
}

/** POSIX 셸 작은따옴표 인용 (bash/zsh/fish 공통으로 동작하는 형태) */
function quote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function tmux(args: string[]): void {
    execFileSync('tmux', args, { timeout: 5000, stdio: 'ignore' });
}

function tmuxHasSession(name: string): boolean {
    try {
        // '=' 접두사: 이름 정확 일치 (tmux는 기본적으로 접두사 일치로 찾는다)
        tmux(['has-session', '-t', `=${name}`]);
        return true;
    } catch {
        return false;
    }
}

/**
 * 에이전트를 tmux 세션에서 실행하고, 터미널에 보낼 "붙기" 명령을 돌려준다.
 * 조건이 안 맞거나 세션 생성에 실패하면 원래 명령 그대로.
 *
 * 세션은 확장이 직접(원격 호스트에서) 만든다: 사용자의 기본 셸을 대화형으로 띄우고
 * 그 안에 명령을 입력한다. `tmux new-session … 'claude'`처럼 명령을 넘기면 비대화형
 * sh -c로 실행돼 ~/.bashrc의 PATH(~/.local/bin, nvm 등)를 못 읽어 곧바로 종료되고,
 * 그 뒤 터미널 질의 응답(997;1n …)이 셸에 명령처럼 찍힌다.
 * 에이전트가 끝나도 셸이 남아 오류 메시지를 볼 수 있다.
 * 이미 세션이 살아 있으면 새로 만들지 않고 붙기만 한다 → 재연결 후 돌고 있던 화면으로 복귀.
 */
export function wrapForPersistence(command: string, project: Project, agentId: string, sessionId?: string): string {
    if (!command || !persistEnabled()) {
        return command;
    }
    if (!hasTmux()) {
        showNoTmuxNotice();
        return command;
    }
    const name = tmuxSessionName(project, agentId, sessionId);
    if (!tmuxHasSession(name)) {
        try {
            tmux(['new-session', '-d', '-s', name, '-c', project.path]);
            // tmux 기본값은 마우스 휠 스크롤이 막혀 있어 이 세션에만 켠다
            tmux(['set-option', '-t', name, 'mouse', 'on']);
            tmux(['send-keys', '-t', name, '-l', command]);
            tmux(['send-keys', '-t', name, 'Enter']);
        } catch {
            return command;
        }
    }
    remember(name, { projectPath: project.path, agentId, sessionId });
    return `tmux attach-session -t ${quote(`=${name}`)}`;
}

function remember(name: string, info: TmuxSessionInfo): void {
    if (!memento) {
        return;
    }
    const map = { ...memento.get<Record<string, TmuxSessionInfo>>(SESSIONS_KEY, {}) };
    map[name] = info;
    void memento.update(SESSIONS_KEY, map);
}

/** 원격에서 지금 살아 있는, 이 확장이 만든 tmux 세션들 (재연결 시 자동으로 다시 붙기용) */
export function liveTmuxSessions(): Array<TmuxSessionInfo & { name: string }> {
    if (!persistEnabled() || !memento) {
        return [];
    }
    let names: string[];
    try {
        names = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
            timeout: 3000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        })
            .split('\n')
            .map(s => s.trim())
            .filter(s => s.startsWith(PREFIX));
    } catch {
        // tmux 없음 또는 서버 미실행(세션 0개)
        return [];
    }
    const map = memento.get<Record<string, TmuxSessionInfo>>(SESSIONS_KEY, {});
    return names.filter(n => map[n]).map(n => ({ name: n, ...map[n] }));
}

function showNoTmuxNotice(): void {
    if (noticeShownThisWindow || memento?.get<boolean>(NO_TMUX_DISMISSED_KEY)) {
        return;
    }
    noticeShownThisWindow = true;
    const dontShow = vscode.l10n.t("Don't Show Again");
    vscode.window
        .showInformationMessage(
            vscode.l10n.t(
                'tmux is not installed on this remote host, so agents run in plain terminals and may stop when the connection drops. Install tmux (e.g. sudo apt install tmux) to keep them running.'
            ),
            dontShow
        )
        .then(pick => {
            if (pick === dontShow) {
                void memento?.update(NO_TMUX_DISMISSED_KEY, true);
            }
        });
}
