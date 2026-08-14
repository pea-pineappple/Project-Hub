import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * 프로젝트 파일 트리용 디렉터리 읽기.
 * 트리를 펼칠 때 한 단계씩만 읽으므로(재귀 없음) 프로젝트가 커도 비용이 일정하다.
 */

export interface DirEntry {
    name: string;
    /** 절대 경로 */
    path: string;
    isDir: boolean;
}

const DEFAULT_EXCLUDE = ['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'out', '.next'];

/**
 * 이름 그대로 비교하는 제외 목록 (glob 아님).
 * Explorer의 files.exclude는 glob이라 매처 의존성이 필요한데, 이름 비교만으로도
 * 실제로 걸러내고 싶은 대상(.git, node_modules 등)은 모두 처리된다.
 */
function excludeSet(): Set<string> {
    const configured = vscode.workspace
        .getConfiguration('projectHub')
        .get<string[]>('fileTreeExclude', DEFAULT_EXCLUDE);
    const list = Array.isArray(configured) ? configured : DEFAULT_EXCLUDE;
    return new Set(list.filter(n => typeof n === 'string').map(n => n.toLowerCase()));
}

/** 자연 정렬 — file2가 file10보다 앞. Explorer와 같은 감각 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** 심볼릭 링크가 디렉터리를 가리키는지 (끊어진 링크는 false) */
async function linkIsDir(full: string): Promise<boolean> {
    try {
        return (await fsp.stat(full)).isDirectory();
    } catch {
        return false;
    }
}

/** 디렉터리 한 단계 목록 — 폴더 먼저, 그다음 파일, 각각 자연 정렬 */
export async function listDir(dir: string): Promise<DirEntry[]> {
    let raw;
    try {
        raw = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        // 권한 없음·삭제됨 등은 빈 목록으로 (트리에 오류 행을 만들지 않는다)
        return [];
    }
    const skip = excludeSet();
    const out: DirEntry[] = [];
    for (const e of raw) {
        if (skip.has(e.name.toLowerCase())) {
            continue;
        }
        const full = path.join(dir, e.name);
        out.push({
            name: e.name,
            path: full,
            isDir: e.isDirectory() || (e.isSymbolicLink() && (await linkIsDir(full)))
        });
    }
    out.sort((a, b) => (a.isDir === b.isDir ? collator.compare(a.name, b.name) : a.isDir ? -1 : 1));
    return out;
}
