import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Project } from './types';

export interface BriefingEntry {
    at: number;
    projectName: string;
    projectPath: string;
    agentId: string;
    kind: 'done' | 'attention';
    text: string;
}

const BRIEFING_FILE = path.join(os.homedir(), '.project-hub', 'briefing.json');
const MAX_ENTRIES = 200;

/**
 * 자리 비운 사이의 작업 요약 피드.
 * 완료(stop) 이벤트 때 transcript에서 마지막 응답을 뽑아 시간순으로 쌓는다.
 * 파일로 영속화(~/.project-hub/briefing.json)해서 창을 닫아도 유지된다.
 */
export class BriefingStore {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private entries: BriefingEntry[] | undefined;

    private load(): BriefingEntry[] {
        if (!this.entries) {
            try {
                const data = JSON.parse(fs.readFileSync(BRIEFING_FILE, 'utf8'));
                this.entries = Array.isArray(data?.entries) ? data.entries : [];
            } catch {
                this.entries = [];
            }
        }
        return this.entries!;
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(BRIEFING_FILE), { recursive: true });
            fs.writeFileSync(BRIEFING_FILE, JSON.stringify({ entries: this.entries }, null, 2));
        } catch {
            // 저장 실패해도 메모리에는 유지
        }
    }

    getEntries(): BriefingEntry[] {
        return this.load();
    }

    /**
     * 이벤트 기록. transcript가 있으면 마지막 응답 요약, 없으면 message나 기본 문구.
     */
    record(
        project: Project,
        agentId: string,
        kind: 'done' | 'attention',
        transcriptPath?: string,
        message?: string
    ): void {
        let text = message ?? '';
        if (!text && transcriptPath) {
            text = extractLastAssistantText(transcriptPath);
        }
        if (!text) {
            text = kind === 'done' ? vscode.l10n.t('Task completed') : vscode.l10n.t('Attention needed');
        }
        const list = this.load();
        list.unshift({
            at: Date.now(),
            projectName: project.name,
            projectPath: project.path,
            agentId,
            kind,
            text: text.slice(0, 2000)
        });
        if (list.length > MAX_ENTRIES) {
            list.length = MAX_ENTRIES;
        }
        this.save();
        this._onDidChange.fire();
    }

    clear(): void {
        this.entries = [];
        this.save();
        this._onDidChange.fire();
    }
}

/**
 * Claude 세션 transcript(jsonl) 끝부분에서 마지막 assistant 텍스트를 추출.
 * 파일이 커도 마지막 256KB만 읽는다.
 */
export function extractLastAssistantText(file: string): string {
    try {
        const stat = fs.statSync(file);
        const readSize = Math.min(stat.size, 256 * 1024);
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            let entry: any;
            try {
                entry = JSON.parse(lines[i]);
            } catch {
                continue;
            }
            if (entry?.type !== 'assistant') {
                continue;
            }
            const content = entry.message?.content;
            const text = Array.isArray(content)
                ? content
                      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
                      .map((p: any) => p.text)
                      .join(' ')
                : typeof content === 'string'
                  ? content
                  : '';
            const clean = text.replace(/\s+/g, ' ').trim();
            if (clean) {
                return clean;
            }
        }
        return '';
    } catch {
        return '';
    }
}

export function relativeTime(at: number): string {
    const diff = Date.now() - at;
    if (diff < 60_000) {
        return vscode.l10n.t('just now');
    }
    if (diff < 3_600_000) {
        return vscode.l10n.t('{0}m ago', Math.floor(diff / 60_000));
    }
    if (diff < 86_400_000) {
        return vscode.l10n.t('{0}h ago', Math.floor(diff / 3_600_000));
    }
    const d = new Date(at);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

