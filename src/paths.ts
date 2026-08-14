import * as path from 'path';

/** 경로 비교용 정규화 (Windows 대소문자/구분자 차이 흡수) */
export function normalizePath(p: string): string {
    let n = path.resolve(p).replace(/[\\/]+$/, '');
    if (process.platform === 'win32') {
        n = n.toLowerCase();
    }
    return n;
}

export function samePath(a: string, b: string): boolean {
    return normalizePath(a) === normalizePath(b);
}

/** child가 parent 경로 자체이거나 그 하위인지 */
export function isWithin(parent: string, child: string): boolean {
    const p = normalizePath(parent);
    const c = normalizePath(child);
    return c === p || c.startsWith(p + path.sep);
}
