import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { sessionsDir } from './claudeSessions';

/**
 * 프로젝트별 Claude 토큰 사용량/비용 집계.
 * ~/.claude/projects/<경로 인코딩>/*.jsonl의 assistant 항목에 있는
 * message.usage를 합산한다.
 *
 * 세션 파일은 append-only라 파일별로 "이미 읽은 바이트 오프셋"을 기억하고
 * 늘어난 뒷부분만 이어서 파싱한다 — 작업 중인 세션 파일이 수십 MB로 커져도
 * 갱신 비용이 추가된 분량에만 비례한다. 읽기는 청크 단위 비동기라
 * 첫 파싱에서도 익스텐션 호스트가 멈추지 않는다.
 */

export interface TokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}

export interface ProjectUsage {
    total: TokenTotals;
    today: TokenTotals;
    byModel: Map<string, TokenTotals>;
    /** 가격표에 없는 모델 (비용 미포함) */
    unknownModels: string[];
}

/** 모델 ID 부분 문자열 → $/MTok (input, output). 캐시 쓰기 1.25×, 읽기 0.1×. 순서 중요(구체적인 것 먼저) */
const PRICING: Array<[string, { inp: number; out: number }]> = [
    ['fable-5', { inp: 10, out: 50 }],
    ['mythos', { inp: 10, out: 50 }],
    ['opus-4-5', { inp: 5, out: 25 }],
    ['opus-4-6', { inp: 5, out: 25 }],
    ['opus-4-7', { inp: 5, out: 25 }],
    ['opus-4-8', { inp: 5, out: 25 }],
    ['opus-5', { inp: 5, out: 25 }],
    ['opus-4-1', { inp: 15, out: 75 }],
    ['opus-4', { inp: 15, out: 75 }],
    ['opus-3', { inp: 15, out: 75 }],
    ['sonnet', { inp: 3, out: 15 }],
    ['haiku-4', { inp: 1, out: 5 }],
    ['haiku-3-5', { inp: 0.8, out: 4 }],
    ['haiku', { inp: 1, out: 5 }]
];

function priceOf(model: string): { inp: number; out: number } | undefined {
    const lower = model.toLowerCase();
    return PRICING.find(([key]) => lower.includes(key))?.[1];
}

function zero(): TokenTotals {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addInto(dst: TokenTotals, src: TokenTotals): void {
    dst.input += src.input;
    dst.output += src.output;
    dst.cacheRead += src.cacheRead;
    dst.cacheWrite += src.cacheWrite;
    dst.cost += src.cost;
}

/** 파일 하나의 증분 파싱 상태 */
interface FileUsage {
    /** 파싱을 마친 바이트 오프셋 — 다음 갱신은 여기서부터 이어 읽는다 */
    offset: number;
    total: TokenTotals;
    /**
     * 날짜(dayKey)별 누적. '오늘'을 따로 담지 않고 날짜별로 쪼개 두면
     * 파일이 더 늘지 않은 채 자정이 지나도 오늘 사용량이 정확하다.
     */
    byDay: Map<string, TokenTotals>;
    byModel: Map<string, TokenTotals>;
    unknownModels: Set<string>;
    /** 같은 응답의 중복 기록 제거용 키 — 청크/갱신 경계를 넘어 유지되어야 한다 */
    seen: Set<string>;
}

const fileCache = new Map<string, FileUsage>();
const projectCache = new Map<string, { at: number; usage: ProjectUsage }>();
const inflight = new Map<string, Promise<ProjectUsage | undefined>>();
const PROJECT_TTL = 30_000;

const CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

export function invalidateUsageCache(): void {
    projectCache.clear();
}

function dayKeyOf(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function emptyFileUsage(): FileUsage {
    return {
        offset: 0,
        total: zero(),
        byDay: new Map(),
        byModel: new Map(),
        unknownModels: new Set(),
        seen: new Set()
    };
}

/** jsonl 한 줄(assistant 항목)을 파일 합계에 반영 */
function consumeLine(fu: FileUsage, line: string): void {
    if (!line) {
        return;
    }
    let entry: any;
    try {
        entry = JSON.parse(line);
    } catch {
        return;
    }
    if (entry?.type !== 'assistant') {
        return;
    }
    const u = entry.message?.usage;
    const model: string = entry.message?.model ?? '';
    if (!u || !model || model === '<synthetic>') {
        return;
    }
    // 같은 응답이 콘텐츠 블록 수만큼 반복 기록되므로 requestId+message.id로 중복 제거
    const dedupe = `${entry.requestId ?? ''}:${entry.message?.id ?? ''}`;
    if (dedupe !== ':') {
        if (fu.seen.has(dedupe)) {
            return;
        }
        fu.seen.add(dedupe);
    }

    const price = priceOf(model);
    const t: TokenTotals = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cost: 0
    };
    if (price) {
        t.cost =
            (t.input * price.inp +
                t.output * price.out +
                t.cacheWrite * price.inp * 1.25 +
                t.cacheRead * price.inp * 0.1) /
            1_000_000;
    } else {
        fu.unknownModels.add(model);
    }
    addInto(fu.total, t);
    const perModel = fu.byModel.get(model) ?? zero();
    addInto(perModel, t);
    fu.byModel.set(model, perModel);
    if (entry.timestamp) {
        const key = dayKeyOf(new Date(entry.timestamp));
        const perDay = fu.byDay.get(key) ?? zero();
        addInto(perDay, t);
        fu.byDay.set(key, perDay);
    }
}

/**
 * fu.offset부터 size까지 늘어난 부분만 읽어 누적한다.
 * 청크마다 await로 이벤트 루프를 양보하므로 큰 파일에서도 UI가 멈추지 않는다.
 */
async function parseIncremental(file: string, fu: FileUsage, size: number): Promise<void> {
    let handle: fsp.FileHandle;
    try {
        handle = await fsp.open(file, 'r');
    } catch {
        return;
    }
    try {
        const buf = Buffer.allocUnsafe(CHUNK);
        // 청크 경계에 걸친 미완성 줄은 바이트 그대로 이월한다. 줄 단위로만 디코딩하므로
        // UTF-8 멀티바이트 문자가 잘릴 일이 없다 ('\n'은 멀티바이트 시퀀스 안에 나타나지 않음).
        let leftover = EMPTY;
        let pos = fu.offset;
        while (pos < size) {
            const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK, size - pos), pos);
            if (bytesRead <= 0) {
                break;
            }
            pos += bytesRead;
            const data = leftover.length
                ? Buffer.concat([leftover, buf.subarray(0, bytesRead)])
                : buf.subarray(0, bytesRead);
            let start = 0;
            for (let nl = data.indexOf(NEWLINE); nl >= 0; nl = data.indexOf(NEWLINE, start)) {
                consumeLine(fu, data.toString('utf8', start, nl));
                start = nl + 1;
            }
            // buf는 다음 read에서 덮어쓰이므로 반드시 복사해서 이월
            leftover = start < data.length ? Buffer.from(data.subarray(start)) : EMPTY;
        }
        // 개행으로 끝난 지점까지만 소비 처리 — 기록 중이라 잘린 마지막 줄은 다음에 이어 읽는다
        fu.offset = pos - leftover.length;
    } finally {
        await handle.close();
    }
}

async function computeUsage(projectPath: string): Promise<ProjectUsage | undefined> {
    const dir = sessionsDir(projectPath);
    if (!dir) {
        return undefined;
    }
    let files: string[];
    try {
        files = await fsp.readdir(dir);
    } catch {
        return undefined;
    }
    const dayKey = dayKeyOf(new Date());
    const result: ProjectUsage = { total: zero(), today: zero(), byModel: new Map(), unknownModels: [] };
    const unknown = new Set<string>();
    for (const f of files) {
        if (!f.endsWith('.jsonl')) {
            continue;
        }
        const file = path.join(dir, f);
        let stat: fs.Stats;
        try {
            stat = await fsp.stat(file);
        } catch {
            continue;
        }
        let fu = fileCache.get(file);
        // 파일이 줄었으면 append-only 가정이 깨진 것(삭제 후 재생성 등) → 처음부터 다시
        if (!fu || stat.size < fu.offset) {
            fu = emptyFileUsage();
            fileCache.set(file, fu);
        }
        if (stat.size > fu.offset) {
            await parseIncremental(file, fu, stat.size);
        }
        addInto(result.total, fu.total);
        const today = fu.byDay.get(dayKey);
        if (today) {
            addInto(result.today, today);
        }
        for (const [model, t] of fu.byModel) {
            const perModel = result.byModel.get(model) ?? zero();
            addInto(perModel, t);
            result.byModel.set(model, perModel);
        }
        for (const m of fu.unknownModels) {
            unknown.add(m);
        }
    }
    result.unknownModels = [...unknown];
    projectCache.set(projectPath, { at: Date.now(), usage: result });
    return result;
}

/** 프로젝트의 누적/오늘 사용량 (30초 캐시, 늘어난 부분만 재파싱) */
export function getProjectUsage(projectPath: string): Promise<ProjectUsage | undefined> {
    const cached = projectCache.get(projectPath);
    if (cached && Date.now() - cached.at < PROJECT_TTL) {
        return Promise.resolve(cached.usage);
    }
    // 트리가 여러 번 다시 그려져도 같은 프로젝트를 동시에 두 번 파싱하지 않는다
    const running = inflight.get(projectPath);
    if (running) {
        return running;
    }
    const started = computeUsage(projectPath).finally(() => inflight.delete(projectPath));
    inflight.set(projectPath, started);
    return started;
}

export function formatCost(cost: number): string {
    if (cost >= 100) {
        return `$${Math.round(cost)}`;
    }
    if (cost >= 1) {
        return `$${cost.toFixed(2)}`;
    }
    return `$${cost.toFixed(3)}`;
}

export function formatTokens(n: number): string {
    if (n >= 1_000_000_000) {
        return `${(n / 1_000_000_000).toFixed(1)}B`;
    }
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(1)}K`;
    }
    return String(n);
}
