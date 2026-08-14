import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Claude Code는 대화를 ~/.claude/projects/<경로 인코딩>/*.jsonl 에 저장한다.
 * 인코딩 규칙: 절대 경로의 영숫자 외 문자를 전부 '-'로 치환.
 * 예: c:\Project\project\qroad-web-site → c--Project-project-qroad-web-site
 */
export function sessionsDir(projectPath: string): string | undefined {
    try {
        const encoded = path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
        const root = path.join(os.homedir(), '.claude', 'projects');
        const match = fs.readdirSync(root).find(d => d.toLowerCase() === encoded);
        return match ? path.join(root, match) : undefined;
    } catch {
        return undefined;
    }
}

export function hasClaudeSessions(projectPath: string): boolean {
    const dir = sessionsDir(projectPath);
    if (!dir) {
        return false;
    }
    try {
        return fs.readdirSync(dir).some(f => f.endsWith('.jsonl'));
    } catch {
        return false;
    }
}

export interface ClaudeSessionInfo {
    id: string;
    mtime: Date;
    preview: string;
}

/**
 * 세션 파일 앞부분에서 미리보기 텍스트 추출.
 * summary 항목(이어진/압축된 세션의 요약)이 있으면 우선, 없으면 첫 사용자 메시지.
 */
function extractPreview(file: string): string {
    try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(64 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        let firstUser = '';
        for (const line of buf.toString('utf8', 0, n).split('\n')) {
            let entry: any;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }
            if (typeof entry?.summary === 'string' && entry.summary) {
                return entry.summary;
            }
            if (!firstUser && entry?.type === 'user') {
                const c = entry.message?.content;
                const text =
                    typeof c === 'string' ? c :
                    Array.isArray(c) ? c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(' ') : '';
                const clean = text.replace(/\s+/g, ' ').trim();
                // <command-name>… 같은 내부 항목은 제외
                if (clean && !clean.startsWith('<')) {
                    firstUser = clean;
                }
            }
        }
        return firstUser;
    } catch {
        return '';
    }
}

/** 프로젝트의 저장된 Claude 세션 목록 (최근 수정 순) */
export function listClaudeSessions(projectPath: string, limit = 30): ClaudeSessionInfo[] {
    const dir = sessionsDir(projectPath);
    if (!dir) {
        return [];
    }
    try {
        return fs
            .readdirSync(dir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({ f, stat: fs.statSync(path.join(dir, f)) }))
            .filter(x => x.stat.size > 0)
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
            .slice(0, limit)
            .map(({ f, stat }) => ({
                id: path.basename(f, '.jsonl'),
                mtime: stat.mtime,
                preview: extractPreview(path.join(dir, f))
            }));
    } catch {
        return [];
    }
}

/** 특정 세션의 미리보기 텍스트 (터미널 이름용 세션 이름 등) */
export function claudeSessionPreview(projectPath: string, sessionId: string): string {
    const dir = sessionsDir(projectPath);
    if (!dir) {
        return '';
    }
    return extractPreview(path.join(dir, `${sessionId}.jsonl`));
}

/** 해당 세션 파일이 실제로 존재하는지 (세션 지정 재개 전 확인용) */
export function hasClaudeSession(projectPath: string, sessionId: string): boolean {
    const dir = sessionsDir(projectPath);
    return !!dir && fs.existsSync(path.join(dir, `${sessionId}.jsonl`));
}
