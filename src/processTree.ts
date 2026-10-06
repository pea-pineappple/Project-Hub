import { execFile } from 'child_process';

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
}

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
}

let cache: Snapshot | undefined;
let pending: Promise<Snapshot> | undefined;

function query(): Promise<Snapshot> {
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
const PASSTHROUGH = new Set(['cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'chcp.com', 'curl.exe']);

/** 명령줄에서 표시용 라벨 추출 */
function friendlyLabel(name: string, command: string): string {
    const lower = command.toLowerCase();
    const agent = /[\\/ ](claude|gemini|codex)([.\- ]|$)/.exec(lower);
    if (agent) {
        return agent[1];
    }
    const exe = name.toLowerCase();
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
    const raw = snap.procs.find(p => p.ProcessId === pid)?.CreationDate;
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
    const targets = projectPaths
        .map(orig => ({ orig, needle: orig.replace(/\//g, '\\').toLowerCase() }))
        .sort((a, b) => b.needle.length - a.needle.length);
    const matchProject = (proc: RawProc): string | undefined => {
        // VS Code 본체는 열려 있는 폴더 경로가 명령줄에 들어가므로 매칭에서 제외
        // (내부 리스너들이 전부 그 프로젝트 소속으로 오인되는 것 방지)
        const name = (proc.Name ?? '').toLowerCase();
        if (name === 'code.exe' || name === 'msedgewebview2.exe') {
            return undefined;
        }
        const hay = `${proc.CommandLine ?? ''} ${proc.ExecutablePath ?? ''}`
            .replace(/\//g, '\\')
            .toLowerCase();
        return targets.find(t => hay.includes(t.needle))?.orig;
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
        for (let cur: RawProc | undefined = self; cur && !seen.has(cur.ProcessId); ) {
            seen.add(cur.ProcessId);
            const matched = matchProject(cur);
            if (matched) {
                owner = owner ?? matched;
                if (cur.CommandLine) {
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
    if (NON_HTTP_PROCESSES.has(proc.name.toLowerCase())) {
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
    return new Promise(resolve => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, _out, stderr) => {
            invalidateProcessCache();
            resolve(err ? stderr || err.message : undefined);
        });
    });
}
