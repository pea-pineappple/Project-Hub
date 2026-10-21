import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';

/** 에이전트 터미널 아래에서 실행 중인 백그라운드 프로세스 하나 */
export interface BgProcess {
    pid: number;
    name: string;
    /** 표시용 이름 (명령줄에서 추출한 친숙한 라벨, 없으면 name) */
    label: string;
    command: string;
    /** 리슨 중인 TCP 포트 (없으면 빈 배열) */
    ports: number[];
    /** 터미널 셸 기준 깊이 (래퍼 셸 제외). 1 = 터미널에서 직접 실행한 프로세스 */
    depth: number;
    /** 재시작용 추정 실행 명령 — 조상 체인에서 프로젝트 경로가 담긴 최상위 명령줄 */
    launchCommand?: string;
}

export interface ProcessListing {
    shown: BgProcess[];
    /** 핵심만 보기 모드에서 걸러진 개수 (MCP 서버·헬퍼 등) */
    hiddenCount: number;
}

interface RawProc {
    ProcessId: number;
    ParentProcessId: number;
    Name: string | null;
    CommandLine: string | null;
    ExecutablePath: string | null;
    /** PowerShell 5.1 JSON 형식 "/Date(ms)/" */
    CreationDate?: string | null;
    /** (Linux) 시작 시각 ms */
    StartMs?: number;
    /** (Linux) 작업 디렉터리 — 다른 사용자 프로세스 등 읽을 수 없으면 없음 */
    Cwd?: string;
}

const IS_WIN = process.platform === 'win32';

/**
 * 전체 프로세스 + 리슨 포트를 한 번에 조회 (PowerShell CIM).
 * 조회 비용(~0.3초)이 있으므로 짧게 캐시하고, 트리를 펼치거나
 * 새로 고칠 때만 실제 조회가 일어난다.
 */
const PS_SCRIPT =
    '$p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate; ' +
    '$t = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalPort); ' +
    '@{procs=@($p); ports=@($t)} | ConvertTo-Json -Compress -Depth 4';

interface Snapshot {
    at: number;
    procs: RawProc[];
    ports: Map<number, number[]>;
    /** (Linux) tmux 세션 이름 → 패널 셸 PID들. 원격 에이전트는 tmux 안에서 돌기 때문에 */
    tmuxPanes?: Map<string, number[]>;
}

let cache: Snapshot | undefined;
let pending: Promise<Snapshot> | undefined;

function query(): Promise<Snapshot> {
    if (process.platform === 'linux') {
        return queryLinux();
    }
    if (!IS_WIN) {
        // macOS 등은 아직 미지원 — 빈 목록 (호출 측은 조회 실패로 취급)
        return Promise.resolve({ at: Date.now(), procs: [], ports: new Map() });
    }
    return new Promise(resolve => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
            { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 15000 },
            (err, stdout) => {
                const empty: Snapshot = { at: Date.now(), procs: [], ports: new Map() };
                if (err || !stdout) {
                    resolve(empty);
                    return;
                }
                try {
                    const data = JSON.parse(stdout);
                    const procs: RawProc[] = Array.isArray(data.procs)
                        ? data.procs
                        : [data.procs].filter(Boolean);
                    const portRows = Array.isArray(data.ports) ? data.ports : [data.ports].filter(Boolean);
                    const ports = new Map<number, number[]>();
                    for (const r of portRows) {
                        if (!r || typeof r.OwningProcess !== 'number') {
                            continue;
                        }
                        const list = ports.get(r.OwningProcess) ?? [];
                        if (!list.includes(r.LocalPort)) {
                            list.push(r.LocalPort);
                        }
                        ports.set(r.OwningProcess, list);
                    }
                    resolve({ at: Date.now(), procs, ports });
                } catch {
                    resolve(empty);
                }
            }
        );
    });
}

// ── Linux: /proc 직접 조회 ─────────────────────────────────────
// ps·ss 같은 외부 명령에 기대지 않는다 (최소 설치 서버에는 ss/lsof가 없을 수 있다).
// 다른 사용자의 프로세스는 cwd·fd를 읽을 수 없어 소속 판별에서 자연히 빠진다.

let clockTicks: number | undefined;
function clkTck(): number {
    if (clockTicks === undefined) {
        try {
            clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000 }).trim()) || 100;
        } catch {
            clockTicks = 100;
        }
    }
    return clockTicks;
}

async function readText(file: string): Promise<string | undefined> {
    try {
        return await fs.promises.readFile(file, 'utf8');
    } catch {
        return undefined;
    }
}

async function readLink(file: string): Promise<string | undefined> {
    try {
        return await fs.promises.readlink(file);
    } catch {
        return undefined;
    }
}

async function readProc(pid: number, bootMs: number): Promise<RawProc | undefined> {
    const stat = await readText(`/proc/${pid}/stat`);
    if (!stat) {
        return undefined;
    }
    // "pid (comm) state ppid …" — comm에 공백·괄호가 들어갈 수 있어 마지막 ')' 기준으로 자른다
    const close = stat.lastIndexOf(')');
    const name = stat.slice(stat.indexOf('(') + 1, close);
    const fields = stat.slice(close + 2).split(' ');
    const ppid = Number(fields[1]);
    const startTicks = Number(fields[19]);
    const [cmdline, exe, cwd] = await Promise.all([
        readText(`/proc/${pid}/cmdline`),
        readLink(`/proc/${pid}/exe`),
        readLink(`/proc/${pid}/cwd`)
    ]);
    return {
        ProcessId: pid,
        ParentProcessId: ppid,
        Name: name,
        CommandLine: cmdline ? cmdline.replace(/\0+$/, '').split('\0').join(' ') : null,
        ExecutablePath: exe ?? null,
        StartMs: Number.isFinite(startTicks) ? bootMs + (startTicks / clkTck()) * 1000 : undefined,
        Cwd: cwd
    };
}

/** 리슨 중인 TCP 소켓 inode → 포트 (/proc/net/tcp, tcp6. 상태 0A = LISTEN) */
async function listeningInodes(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const text = await readText(file);
        for (const line of text?.split('\n').slice(1) ?? []) {
            const cols = line.trim().split(/\s+/);
            if (cols.length < 10 || cols[3] !== '0A') {
                continue;
            }
            const port = parseInt(cols[1].split(':').pop() ?? '', 16);
            if (port && cols[9] !== '0') {
                out.set(cols[9], port);
            }
        }
    }
    return out;
}

/** 프로세스가 연 리슨 소켓의 포트들 (fd → socket:[inode]) */
async function portsOf(pid: number, inodes: Map<string, number>): Promise<number[]> {
    let fds: string[];
    try {
        fds = await fs.promises.readdir(`/proc/${pid}/fd`);
    } catch {
        return [];
    }
    const ports = new Set<number>();
    await Promise.all(
        fds.map(async fd => {
            const m = /^socket:\[(\d+)\]$/.exec((await readLink(`/proc/${pid}/fd/${fd}`)) ?? '');
            const port = m ? inodes.get(m[1]) : undefined;
            if (port) {
                ports.add(port);
            }
        })
    );
    return [...ports].sort((a, b) => a - b);
}

function tmuxPanes(): Map<string, number[]> {
    const out = new Map<string, number[]>();
    try {
        const text = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_pid}'], {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        for (const line of text.split('\n')) {
            const [name, pid] = line.trim().split(' ');
            if (name && Number(pid)) {
                out.set(name, [...(out.get(name) ?? []), Number(pid)]);
            }
        }
    } catch {
        // tmux 없음 또는 서버 미실행
    }
    return out;
}

async function queryLinux(): Promise<Snapshot> {
    const empty: Snapshot = { at: Date.now(), procs: [], ports: new Map() };
    try {
        const btime = /^btime (\d+)/m.exec((await readText('/proc/stat')) ?? '');
        const bootMs = btime ? Number(btime[1]) * 1000 : 0;
        const pids = (await fs.promises.readdir('/proc')).filter(d => /^\d+$/.test(d)).map(Number);
        const procs = (await Promise.all(pids.map(pid => readProc(pid, bootMs)))).filter(
            (p): p is RawProc => !!p
        );
        const inodes = await listeningInodes();
        const ports = new Map<number, number[]>();
        if (inodes.size > 0) {
            await Promise.all(
                procs.map(async p => {
                    const list = await portsOf(p.ProcessId, inodes);
                    if (list.length) {
                        ports.set(p.ProcessId, list);
                    }
                })
            );
            // 워커 프로세스(uvicorn --workers, gunicorn, node cluster)는 부모의 리슨 소켓을
            // 물려받아 같은 포트를 가진다 → 같은 서비스가 여러 줄로 뜨지 않게 부모에게만 남긴다
            const byId = new Map(procs.map(p => [p.ProcessId, p]));
            for (const [pid, list] of [...ports]) {
                const parentPorts = ports.get(byId.get(pid)?.ParentProcessId ?? -1);
                if (parentPorts && list.every(port => parentPorts.includes(port))) {
                    ports.delete(pid);
                }
            }
        }
        return { at: Date.now(), procs, ports, tmuxPanes: tmuxPanes() };
    } catch {
        return empty;
    }
}

async function snapshot(): Promise<Snapshot> {
    if (cache && Date.now() - cache.at < 5000) {
        return cache;
    }
    if (!pending) {
        pending = query().then(s => {
            cache = s;
            pending = undefined;
            return s;
        });
    }
    return pending;
}

/** 강제 재조회 (새로 고침/프로세스 종료 후) */
export function invalidateProcessCache(): void {
    cache = undefined;
}

/**
 * 셸/래퍼 프로세스는 행으로 표시하지 않고 통과시킨다 (자식이 그 깊이를 이어받음).
 * 예: 셸 → cmd.exe(claude.cmd 래퍼) → node.exe 에서 node가 깊이 1로 잡힘.
 */
const PASSTHROUGH = new Set([
    'cmd.exe',
    'powershell.exe',
    'pwsh.exe',
    'conhost.exe',
    'chcp.com',
    'curl.exe',
    // Linux/macOS 셸
    'bash',
    'sh',
    'zsh',
    'fish',
    'dash'
]);

/** tmux 클라이언트(`tmux attach-session -t =ph-…`)가 붙은 세션 이름 */
function tmuxAttachTarget(command: string): string | undefined {
    return (
        /\btmux\b.*\battach(?:-session)?\s+-t\s+'?=?([^'\s]+)/.exec(command)?.[1] ??
        // 터미널을 tmux 클라이언트로 바로 띄운 경우: tmux new-session -A -s <이름>
        /\btmux\b.*\bnew-session\b.*\s-A\b.*\s-s\s+(\S+)/.exec(command)?.[1]
    );
}

/** 프로세스 이름 (조회 실패 시 undefined) */
export async function processName(pid: number): Promise<string | undefined> {
    const snap = await snapshot();
    return snap.procs.find(p => p.ProcessId === pid)?.Name ?? undefined;
}

/** 명령줄에서 표시용 라벨 추출 */
function friendlyLabel(name: string, command: string): string {
    const lower = command.toLowerCase();
    const agent = /(?:^|[\\/ ])(claude|gemini|codex)([.\- ]|$)/.exec(lower);
    if (agent) {
        return agent[1];
    }
    // Linux 실행 파일명은 확장자가 없고 버전이 붙는다 (python3.12) → Windows 이름으로 맞춰 판별
    const exe = name.toLowerCase().replace(/\.exe$/, '').replace(/^(python|py)[\d.]*$/, '$1') + '.exe';
    if (exe === 'python.exe' || exe === 'py.exe') {
        // python -m uvicorn … → uvicorn
        const mod = /\s-m\s+([\w.]+)/.exec(command);
        if (mod) {
            return mod[1];
        }
    }
    if (exe === 'node.exe' || exe === 'python.exe' || exe === 'py.exe') {
        // node_modules의 패키지명 (next/vite 등)이 가장 알아보기 쉽다
        const pkg = /node_modules[\\/](?:\.bin[\\/])?(@?[\w.-]+)/.exec(command);
        if (pkg && pkg[1] !== '.bin') {
            return pkg[1];
        }
        // 첫 스크립트 인자(.js/.py/.mjs/.cjs)의 파일명으로 표시
        const script = /[^\s"]+\.(?:m?js|cjs|py)\b/.exec(command.replace(/\\/g, '/'));
        if (script) {
            const base = script[0].split('/').pop();
            if (base) {
                return `${base} (${exe.replace('.exe', '')})`;
            }
        }
    }
    return name.replace(/\.exe$/i, '');
}

/**
 * rootPids(에이전트 터미널 셸 PID들)의 자손 프로세스.
 * showAll=false(핵심만)면 ① 리슨 포트가 있거나 ② 터미널에서 직접 실행한(깊이 1)
 * 프로세스만 남긴다 — MCP 서버·헬퍼 같은 stdio 플러밍은 숨겨진 개수로만 보고.
 */
export async function getBackgroundProcesses(rootPids: number[], showAll = false): Promise<ProcessListing> {
    if (rootPids.length === 0) {
        return { shown: [], hiddenCount: 0 };
    }
    const snap = await snapshot();
    const byParent = new Map<number, RawProc[]>();
    for (const p of snap.procs) {
        const list = byParent.get(p.ParentProcessId) ?? [];
        list.push(p);
        byParent.set(p.ParentProcessId, list);
    }
    const all: BgProcess[] = [];
    // 터미널 프로세스 자체가 tmux 클라이언트면 그 세션의 패널 셸들이 실제 루트
    const byPid = new Map(snap.procs.map(p => [p.ProcessId, p]));
    rootPids = rootPids.flatMap(pid => {
        const root = byPid.get(pid);
        const target = root && (root.Name ?? '').startsWith('tmux') ? tmuxAttachTarget(root.CommandLine ?? '') : undefined;
        return target ? snap.tmuxPanes?.get(target) ?? [] : [pid];
    });
    const seen = new Set<number>(rootPids);
    const queue: Array<{ pid: number; depth: number }> = rootPids.map(pid => ({ pid, depth: 0 }));
    while (queue.length) {
        const { pid, depth } = queue.shift()!;
        for (const child of byParent.get(pid) ?? []) {
            if (seen.has(child.ProcessId)) {
                continue;
            }
            seen.add(child.ProcessId);
            const name = (child.Name ?? '').toLowerCase();
            // 원격(tmux 유지 모드): 터미널 셸 아래엔 tmux 클라이언트만 있고 에이전트는
            // tmux 서버 쪽 패널에서 돈다 → 클라이언트 대신 그 세션의 패널 셸을 따라간다
            const tmuxTarget = name.startsWith('tmux') ? tmuxAttachTarget(child.CommandLine ?? '') : undefined;
            if (tmuxTarget) {
                for (const panePid of snap.tmuxPanes?.get(tmuxTarget) ?? []) {
                    if (!seen.has(panePid)) {
                        seen.add(panePid);
                        queue.push({ pid: panePid, depth });
                    }
                }
                continue;
            }
            if (PASSTHROUGH.has(name)) {
                // 래퍼는 행을 만들지 않고 자식이 현재 깊이를 이어받음
                queue.push({ pid: child.ProcessId, depth });
                continue;
            }
            const childDepth = depth + 1;
            queue.push({ pid: child.ProcessId, depth: childDepth });
            all.push({
                pid: child.ProcessId,
                name: child.Name ?? '?',
                label: friendlyLabel(child.Name ?? '?', child.CommandLine ?? ''),
                command: child.CommandLine ?? '',
                ports: snap.ports.get(child.ProcessId) ?? [],
                depth: childDepth
            });
        }
    }
    const shown = showAll ? all : all.filter(p => p.ports.length > 0 || p.depth === 1);
    return { shown, hiddenCount: all.length - shown.length };
}

/**
 * 셸 아래에서 무언가(에이전트 등) 실행 중인지. conhost 같은 콘솔 호스트는 제외.
 * 프로세스 조회에 실패하면 undefined — 호출 측은 "모름"으로 취급해야 한다
 * (실행 중인 에이전트 입력창에 명령을 잘못 보내지 않도록).
 */
export async function hasRunningChild(shellPid: number): Promise<boolean | undefined> {
    const snap = await snapshot();
    if (snap.procs.length === 0) {
        return undefined;
    }
    return snap.procs.some(
        p => p.ParentProcessId === shellPid && (p.Name ?? '').toLowerCase() !== 'conhost.exe'
    );
}

/** 프로세스 시작 시각(ms). 조회 실패 시 undefined */
export async function processStartTime(pid: number): Promise<number | undefined> {
    const snap = await snapshot();
    const proc = snap.procs.find(p => p.ProcessId === pid);
    if (proc?.StartMs !== undefined) {
        return proc.StartMs;
    }
    const raw = proc?.CreationDate;
    const m = raw ? /Date\((\d+)\)/.exec(raw) : null;
    return m ? Number(m[1]) : undefined;
}

/**
 * 시스템 전체 리슨 프로세스 중 등록된 프로젝트 소속을 찾아낸다.
 * 자신 또는 부모 체인의 명령줄/실행 파일 경로에 프로젝트 경로가 나타나면 그 프로젝트 소속.
 * (터미널 자손 추적과 달리, 중간 부모가 죽었거나 Start-Process로 분리 실행돼도 잡힌다.
 *  예: dev.ps1 → concurrently → uvicorn은 조상 concurrently의 명령줄 경로로 귀속)
 *
 * @param projectPaths 정규화된 프로젝트 경로 목록. 반환 Map의 키로 그대로 쓰인다.
 */
export async function getListeningServicesByProject(
    projectPaths: string[]
): Promise<Map<string, BgProcess[]>> {
    const out = new Map<string, BgProcess[]>();
    if (projectPaths.length === 0) {
        return out;
    }
    const snap = await snapshot();
    const byId = new Map<number, RawProc>();
    for (const p of snap.procs) {
        byId.set(p.ProcessId, p);
    }
    // 중첩 프로젝트 대비: 더 구체적인(긴) 경로 우선 매칭
    // Windows는 대소문자·구분자를 무시하고, Linux는 경로를 그대로 비교한다
    const norm = (v: string) => (IS_WIN ? v.replace(/\//g, '\\').toLowerCase() : v);
    const targets = projectPaths
        .map(orig => ({ orig, needle: norm(orig) }))
        .sort((a, b) => b.needle.length - a.needle.length);
    const matchProject = (proc: RawProc): string | undefined => {
        // VS Code 본체는 열려 있는 폴더 경로가 명령줄에 들어가므로 매칭에서 제외
        // (내부 리스너들이 전부 그 프로젝트 소속으로 오인되는 것 방지)
        const name = (proc.Name ?? '').toLowerCase();
        if (name === 'code.exe' || name === 'msedgewebview2.exe' || isEnvironmentProcess(proc)) {
            return undefined;
        }
        const hay = norm(`${proc.CommandLine ?? ''} ${proc.ExecutablePath ?? ''}`);
        const byCommand = targets.find(t => hay.includes(t.needle))?.orig;
        if (byCommand) {
            return byCommand;
        }
        // Linux는 상대 경로로 띄우는 경우(npm run dev, uvicorn main:app)가 흔해 명령줄에
        // 경로가 안 드러난다 → 작업 디렉터리가 프로젝트 안이면 소속으로 본다
        const cwd = proc.Cwd;
        return cwd ? targets.find(t => cwd === t.needle || cwd.startsWith(t.needle + '/'))?.orig : undefined;
    };
    for (const [pid, ports] of snap.ports) {
        const self = byId.get(pid);
        if (!self) {
            continue;
        }
        // 체인 전체를 걸어 올라가며: 소유 프로젝트 = 가장 가까운 매칭(구체적),
        // 재시작 명령 = 가장 먼 매칭(실제 실행 명령 — dev 스크립트/런처일 가능성이 높음)
        let owner: string | undefined;
        let launch: string | undefined;
        const seen = new Set<number>();
        let launchDone = false;
        for (let cur: RawProc | undefined = self; cur && !seen.has(cur.ProcessId); ) {
            seen.add(cur.ProcessId);
            const matched = matchProject(cur);
            // 에이전트(claude 등)를 넘어서는 재시작 명령을 찾지 않는다 — 에이전트가 띄운 서버의
            // 조상에는 에이전트 자신이 있는데, cwd 매칭에서는 그 명령줄("claude")이 잡히기 때문
            if (cur !== self && isAgentProcess(cur)) {
                launchDone = true;
            }
            if (matched) {
                owner = owner ?? matched;
                if (cur.CommandLine && !launchDone && !isBareShell(cur)) {
                    launch = cur.CommandLine;
                }
            }
            cur = byId.get(cur.ParentProcessId);
        }
        if (!owner) {
            continue;
        }
        const list = out.get(owner) ?? [];
        list.push({
            pid,
            name: self.Name ?? '?',
            label: friendlyLabel(self.Name ?? '?', self.CommandLine ?? ''),
            command: self.CommandLine ?? '',
            ports,
            depth: 1,
            launchCommand: launch
        });
        out.set(owner, list);
    }
    return out;
}

/** VS Code 서버·tmux 서버·시스템 데몬 — 작업 디렉터리가 우연히 프로젝트 안이어도 소속이 아니다 */
function isEnvironmentProcess(proc: RawProc): boolean {
    if (IS_WIN) {
        return false;
    }
    const name = (proc.Name ?? '').toLowerCase();
    if (name.startsWith('tmux') || name === 'systemd' || name === 'sshd' || name === 'init') {
        return true;
    }
    const hay = `${proc.CommandLine ?? ''} ${proc.ExecutablePath ?? ''}`;
    return /\/\.(vscode|vscode-insiders|cursor|windsurf)-server\//.test(hay);
}

function isAgentProcess(proc: RawProc): boolean {
    const label = friendlyLabel(proc.Name ?? '', proc.CommandLine ?? '');
    return label === 'claude' || label === 'gemini' || label === 'codex';
}

/** 대화형 셸이나 `bash -c …`처럼 재시작 명령으로 쓸 수 없는 셸 (`bash ./dev.sh`는 쓸 수 있다) */
function isBareShell(proc: RawProc): boolean {
    const name = (proc.Name ?? '').toLowerCase();
    if (IS_WIN || !PASSTHROUGH.has(name)) {
        return false;
    }
    const args = (proc.CommandLine ?? '').trim().split(/\s+/).slice(1);
    return args.length === 0 || args.includes('-c') || args.every(a => a.startsWith('-'));
}

/**
 * 브라우저로 열어봐야 의미 없는 포트·프로세스.
 * 허용 목록(allowlist)이 아니라 제외 목록으로 두는 이유: 개발 중 띄우는 서버는
 * 대부분 웹이라, 새로운 프레임워크가 쓰는 포트를 일일이 등록하는 것보다
 * 확실히 웹이 아닌 것만 걸러내는 쪽이 놓치는 게 적다.
 */
const NON_HTTP_PORTS = new Set([
    1433, // SQL Server
    1521, // Oracle
    3306, // MySQL / MariaDB
    5432, // PostgreSQL
    6379, // Redis
    5672, // RabbitMQ (AMQP — 관리 UI 15672는 웹이라 제외하지 않음)
    9042, // Cassandra
    9229, 9230, // Node 인스펙터 — dev 서버 옆에 같이 뜨는데 브라우저로 열 대상은 아니다
    11211, // Memcached
    27017, 27018, 27019 // MongoDB
]);

const NON_HTTP_PROCESSES = new Set([
    'postgres.exe',
    'mysqld.exe',
    'mariadbd.exe',
    'mongod.exe',
    'redis-server.exe',
    'sqlservr.exe',
    'memcached.exe'
]);

/** 이 서비스에서 브라우저로 열어볼 만한 포트들 (없으면 웹 서비스가 아님) */
export function webPorts(proc: BgProcess): number[] {
    // Linux 프로세스 이름은 확장자가 없다 (postgres, redis-server)
    if (NON_HTTP_PROCESSES.has(proc.name.toLowerCase().replace(/\.exe$/, '') + '.exe')) {
        return [];
    }
    return proc.ports.filter(p => !NON_HTTP_PORTS.has(p));
}

/** 접속 URL. 개발 서버가 스스로 출력하는 표기와 맞춰 localhost를 쓴다 */
export function serviceUrl(port: number): string {
    return `${port === 443 || port === 8443 ? 'https' : 'http'}://localhost:${port}`;
}

/** 프로세스를 하위 트리까지 강제 종료 */
export function killProcessTree(pid: number): Promise<string | undefined> {
    if (!IS_WIN) {
        return killProcessTreePosix(pid);
    }
    return new Promise(resolve => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, _out, stderr) => {
            invalidateProcessCache();
            resolve(err ? stderr || err.message : undefined);
        });
    });
}

/**
 * POSIX: 자손까지 SIGTERM으로 정상 종료를 요청하고, 2초 안에 안 끝나면 SIGKILL.
 * (taskkill /T /F 와 같은 결과 — 다만 서버가 정리할 기회를 먼저 준다)
 */
async function killProcessTreePosix(pid: number): Promise<string | undefined> {
    invalidateProcessCache();
    const snap = await snapshot();
    const byParent = new Map<number, number[]>();
    for (const p of snap.procs) {
        byParent.set(p.ParentProcessId, [...(byParent.get(p.ParentProcessId) ?? []), p.ProcessId]);
    }
    const tree: number[] = [];
    const queue = [pid];
    while (queue.length) {
        const cur = queue.shift()!;
        if (!tree.includes(cur)) {
            tree.push(cur);
            queue.push(...(byParent.get(cur) ?? []));
        }
    }
    const signal = (target: number, sig: NodeJS.Signals): string | undefined => {
        try {
            process.kill(target, sig);
            return undefined;
        } catch (err) {
            return (err as NodeJS.ErrnoException).code === 'ESRCH' ? undefined : (err as Error).message;
        }
    };
    // 루트를 못 죽이면(권한 없음 등) 그대로 오류 보고
    const rootError = signal(pid, 'SIGTERM');
    if (rootError) {
        invalidateProcessCache();
        return rootError;
    }
    tree.slice(1).forEach(child => signal(child, 'SIGTERM'));
    const alive = (target: number) => {
        try {
            process.kill(target, 0);
            return true;
        } catch {
            return false;
        }
    };
    for (let waited = 0; waited < 2000 && tree.some(alive); waited += 100) {
        await new Promise(r => setTimeout(r, 100));
    }
    tree.filter(alive).forEach(target => signal(target, 'SIGKILL'));
    invalidateProcessCache();
    return undefined;
}
