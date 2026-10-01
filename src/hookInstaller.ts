import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { parse as parseJsonc, ParseError } from 'jsonc-parser';

/** 우리가 설치한 hook을 식별하기 위한 시그니처 (포트가 바뀌어도 제거 가능하도록 URL 패턴으로 판별) */
const HOOK_SIGNATURE = /127\.0\.0\.1:\d+\/hook\//;

interface HookCommand {
    type: string;
    command: string;
    name?: string;
    timeout?: number;
}

interface HookEntry {
    matcher?: string;
    hooks: HookCommand[];
}

/**
 * 모든 에이전트 공통 알림 명령. Claude/Codex/Gemini 셋 다 hook 페이로드를
 * stdin JSON(cwd 필드 포함)으로 전달하므로 curl로 그대로 서버에 중계한다.
 * (curl은 Windows 10+/macOS/Linux 기본 포함)
 *
 * Windows는 에이전트마다 hook 실행 셸이 다르다 — Claude는 Git Bash, Gemini는 powershell -Command.
 * PowerShell 5.1에서 `curl`은 Invoke-WebRequest 별칭이고 `@-`는 문법 오류라 알림이 전혀 오지 않았다.
 * `curl.exe … -d '@-'`는 bash·PowerShell·cmd 모두에서 같은 의미로 동작하고, stdin을 그대로 받아
 * 한글 경로·프롬프트도 깨지지 않는다 ($input 파이프는 PS 5.1 기본 인코딩 때문에 한글이 깨짐).
 */
function curlCommand(port: number, route: string, agentId: string): string {
    const url = `"http://127.0.0.1:${port}/hook/${route}?agent=${agentId}"`;
    return process.platform === 'win32'
        ? `curl.exe -s -m 3 -X POST -H "Content-Type: application/json" -d '@-' ${url}`
        : `curl -s -m 3 -X POST -H "Content-Type: application/json" -d @- ${url}`;
}

/** 현재 형식으로 설치된 명령인지 — 옛 형식(Windows에서 curl)은 자동 재설치되도록 */
function isCurrentFormat(command: string): boolean {
    return process.platform === 'win32' ? command.startsWith('curl.exe ') : command.startsWith('curl ');
}

/** JSONC(주석/트레일링 콤마) 허용 — Gemini settings.json 등은 주석을 포함할 수 있다 */
function readJson(file: string): Record<string, any> {
    if (!fs.existsSync(file)) {
        return {};
    }
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) {
        return {};
    }
    const errors: ParseError[] = [];
    const data = parseJsonc(raw, errors, { allowTrailingComma: true });
    if (errors.length) {
        throw new Error(`Invalid JSON format: ${file}`);
    }
    return data ?? {};
}

function writeJson(file: string, data: Record<string, any>): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** 이벤트 배열에서 우리가 설치했던 항목을 제거하고 새 항목을 추가 */
function mergeEntries(existing: unknown, entry: HookEntry): HookEntry[] {
    const entries: HookEntry[] = Array.isArray(existing) ? existing : [];
    const kept = entries.filter(e => !e?.hooks?.some(h => HOOK_SIGNATURE.test(h?.command ?? '')));
    kept.push(entry);
    return kept;
}

/**
 * hook은 프로젝트가 아니라 **사용자 전역 설정**에 설치한다.
 * - 한 번 설치로 모든 프로젝트에 적용 (cwd는 hook 페이로드에 포함되므로 구분 가능)
 * - 프로젝트 로컬 설정 파일을 에이전트 자신이 다시 쓰면서 hook을 덮어쓰는 충돌 방지
 * - 저장소에 개인 설정 파일을 만들지 않음
 */

/**
 * Claude Code: ~/.claude/settings.json (사용자 전역)
 * 이벤트: UserPromptSubmit → working, Stop → stop, Notification → notification
 * 추가로 PreToolUse(AskUserQuestion|ExitPlanMode) → notification:
 * Claude가 선택지를 제시하거나 계획 승인을 기다리는 "즉시" 알림을 보내기 위함
 * (Notification 이벤트는 권한 요청/60초 유휴만 다루므로 선택 대기는 뒤늦게 잡힘)
 */
function installClaudeHooks(port: number): void {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = readJson(file);
    const hooks: Record<string, unknown> = settings.hooks ?? {};
    const routes: Array<[string, string]> = [
        ['UserPromptSubmit', 'working'],
        ['Stop', 'stop'],
        ['Notification', 'notification'],
        // 세션 종료(exit, /clear 등) 시 리스트의 세션별 상태 행 잔상을 정리
        ['SessionEnd', 'end']
    ];
    for (const [event, route] of routes) {
        hooks[event] = mergeEntries(hooks[event], {
            hooks: [{ type: 'command', command: curlCommand(port, route, 'claude'), timeout: 5 }]
        });
    }
    hooks['PreToolUse'] = mergeEntries(hooks['PreToolUse'], {
        matcher: 'AskUserQuestion|ExitPlanMode',
        hooks: [{ type: 'command', command: curlCommand(port, 'notification', 'claude'), timeout: 5 }]
    });
    settings.hooks = hooks;
    writeJson(file, settings);
}

/**
 * Codex CLI: ~/.codex/hooks.json (사용자 전역)
 * 이벤트: UserPromptSubmit → working, Stop → stop, PermissionRequest → notification
 */
function installCodexHooks(port: number): void {
    const file = path.join(os.homedir(), '.codex', 'hooks.json');
    const settings = readJson(file);
    const hooks: Record<string, unknown> = settings.hooks ?? {};
    const routes: Array<[string, string]> = [
        ['UserPromptSubmit', 'working'],
        ['Stop', 'stop'],
        ['PermissionRequest', 'notification']
    ];
    for (const [event, route] of routes) {
        hooks[event] = mergeEntries(hooks[event], {
            hooks: [{ type: 'command', command: curlCommand(port, route, 'codex'), timeout: 10 }]
        });
    }
    settings.hooks = hooks;
    writeJson(file, settings);
}

/**
 * Gemini CLI: ~/.gemini/settings.json (사용자 전역)
 * 이벤트: BeforeAgent → working, AfterAgent → stop, Notification → notification
 * Gemini의 timeout 단위는 밀리초. AfterAgent는 stdout JSON을 decision으로
 * 해석할 수 있으므로 서버는 본문 없는 204로 응답한다(curl 출력 없음).
 */
function installGeminiHooks(port: number): void {
    const file = path.join(os.homedir(), '.gemini', 'settings.json');
    const settings = readJson(file);
    const hooks: Record<string, unknown> = settings.hooks ?? {};
    const routes: Array<[string, string]> = [
        ['BeforeAgent', 'working'],
        ['AfterAgent', 'stop'],
        ['Notification', 'notification']
    ];
    for (const [event, route] of routes) {
        hooks[event] = mergeEntries(hooks[event], {
            hooks: [
                {
                    name: `project-hub-${route}`,
                    type: 'command',
                    command: curlCommand(port, route, 'gemini'),
                    timeout: 10000
                }
            ]
        });
    }
    settings.hooks = hooks;
    writeJson(file, settings);
}

/**
 * Antigravity CLI(agy): ~/.gemini/antigravity-cli/hooks.json (사용자 전역)
 * 파일 전체가 "hook 이름 → 이벤트 구성" 맵이라 다른 에이전트와 구조가 다름.
 * 우리 것은 "project-hub" 키 하나로 관리 (재설치 = 키 덮어쓰기).
 * 이벤트: PreInvocation → working, Stop → stop,
 *        PreToolUse(ask_permission) → notification (권한 대기 알림)
 * stdout은 decision JSON으로 해석될 수 있으므로 서버의 204 무본문 응답이 안전.
 */
function installAntigravityHooks(port: number): void {
    const file = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'hooks.json');
    const settings = readJson(file);
    settings['project-hub'] = {
        enabled: true,
        PreInvocation: [
            { type: 'command', command: curlCommand(port, 'working', 'antigravity'), timeout: 5 }
        ],
        Stop: [{ type: 'command', command: curlCommand(port, 'stop', 'antigravity'), timeout: 5 }],
        PreToolUse: [
            {
                matcher: 'ask_permission',
                hooks: [
                    { type: 'command', command: curlCommand(port, 'notification', 'antigravity'), timeout: 5 }
                ]
            }
        ]
    };
    writeJson(file, settings);
}

const INSTALLERS: Record<string, (port: number) => void> = {
    claude: installClaudeHooks,
    codex: installCodexHooks,
    gemini: installGeminiHooks,
    antigravity: installAntigravityHooks
};

const HOOK_FILES: Record<string, () => string> = {
    claude: () => path.join(os.homedir(), '.claude', 'settings.json'),
    codex: () => path.join(os.homedir(), '.codex', 'hooks.json'),
    gemini: () => path.join(os.homedir(), '.gemini', 'settings.json'),
    antigravity: () => path.join(os.homedir(), '.gemini', 'antigravity-cli', 'hooks.json')
};

/** 해당 에이전트의 알림 hook 설치를 지원하는지 */
export function supportsHooks(agentId: string): boolean {
    return agentId in INSTALLERS;
}

/** 알림 hook을 사용자 전역 설정에 설치. 미지원 에이전트면 false */
export function installAgentHooks(agentId: string, port: number): boolean {
    const installer = INSTALLERS[agentId];
    if (!installer) {
        return false;
    }
    installer(port);
    return true;
}

/** 에이전트별로 설치되어야 하는 이벤트 전체 — 버전 업으로 이벤트가 추가되면 자동 재설치 유도 */
const REQUIRED_EVENTS: Record<string, string[]> = {
    claude: ['UserPromptSubmit', 'Stop', 'Notification', 'PreToolUse', 'SessionEnd'],
    codex: ['UserPromptSubmit', 'Stop', 'PermissionRequest'],
    gemini: ['BeforeAgent', 'AfterAgent', 'Notification']
};

/**
 * 해당 에이전트의 전역 hook이 이미 (현재 버전 기준으로 완전하게) 설치되어 있는지.
 * port를 주면 그 포트로 설치된 것만 인정 — 포트 변경 시 자동 재설치를 유도한다.
 * 필수 이벤트가 하나라도 빠져 있으면 false → 새 이벤트가 추가된 버전에서 자동 보강 설치.
 * (제거/교체 시에는 포트 무관 시그니처를 쓰므로 구 포트 항목도 정리된다.)
 */
export function hasAgentHooks(agentId: string, port?: number): boolean {
    const fileOf = HOOK_FILES[agentId];
    if (!fileOf) {
        return false;
    }
    const signature = port !== undefined ? new RegExp(`127\\.0\\.0\\.1:${port}/hook/`) : HOOK_SIGNATURE;
    // 포트까지 확인하는 경우(자동 설치 판단)엔 명령 형식도 현재 것이어야 인정 → 옛 형식은 재설치
    const ok = (command: string) => signature.test(command) && (port === undefined || isCurrentFormat(command));
    try {
        const settings = readJson(fileOf());
        // Antigravity는 구조가 달라 별도 검사 (project-hub 키 아래 이벤트별 배열)
        if (agentId === 'antigravity') {
            const cfg = settings?.['project-hub'];
            const has = (arr: unknown) =>
                Array.isArray(arr) &&
                arr.some(
                    (e: any) =>
                        ok(e?.command ?? '') ||
                        e?.hooks?.some((h: any) => ok(h?.command ?? ''))
                );
            return !!cfg && has(cfg.PreInvocation) && has(cfg.Stop) && has(cfg.PreToolUse);
        }
        const events: Record<string, HookEntry[]> = settings?.hooks ?? {};
        const required = REQUIRED_EVENTS[agentId] ?? [];
        return required.every(event => {
            const entries = events[event];
            return (
                Array.isArray(entries) &&
                entries.some(e => e?.hooks?.some(h => ok(h?.command ?? '')))
            );
        });
    } catch {
        return false;
    }
}
