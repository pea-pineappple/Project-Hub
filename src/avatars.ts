import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Project, ProjectStatus } from './types';

/** 프로젝트 색상 팔레트 (Peacock 계열) */
export const PALETTE: Array<{ label: string; value: string }> = [
    { label: 'Blue', value: '#3b82f6' },
    { label: 'Sky', value: '#0ea5e9' },
    { label: 'Teal', value: '#14b8a6' },
    { label: 'Green', value: '#22c55e' },
    { label: 'Yellow', value: '#eab308' },
    { label: 'Orange', value: '#f97316' },
    { label: 'Red', value: '#e11d48' },
    { label: 'Pink', value: '#d946ef' },
    { label: 'Purple', value: '#8b5cf6' },
    { label: 'Slate', value: '#64748b' }
];

/** 이름 해시 기반 자동 색상 — 지정 색이 없어도 모든 프로젝트가 색을 가진다 */
export function autoColor(name: string): string {
    let h = 0;
    for (const ch of name) {
        h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
    }
    return PALETTE[h % PALETTE.length].value;
}

export function colorOf(project: Project): string {
    return project.color ?? autoColor(project.name);
}

/** 배경색 대비 텍스트 색 */
export function contrastText(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#15181e' : '#ffffff';
}

const STATUS_DOT: Partial<Record<ProjectStatus, string>> = {
    working: '#eab308',
    done: '#22c55e',
    attention: '#f97316'
};

function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 트리 아이콘용 SVG 아바타(색 + 이니셜 + 상태 점) 생성기.
 * 조합별로 globalStorage/avatars에 파일 캐시.
 */
export class AvatarStore {
    private dir: string;

    constructor(context: vscode.ExtensionContext) {
        this.dir = path.join(context.globalStorageUri.fsPath, 'avatars');
        fs.mkdirSync(this.dir, { recursive: true });
    }

    avatar(project: Project, status: ProjectStatus, active: boolean): vscode.Uri {
        const color = colorOf(project);
        const initial = (project.name.trim()[0] ?? '?').toUpperCase();
        const key = `av-${color.slice(1)}-${initial.codePointAt(0)}-${status}-${active ? 1 : 0}.svg`;
        const file = path.join(this.dir, key);
        if (!fs.existsSync(file)) {
            const dot = STATUS_DOT[status];
            const svg =
                `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
                (active
                    ? `<rect x="0.75" y="0.75" width="14.5" height="14.5" rx="4.5" fill="none" stroke="${color}" stroke-opacity="0.5" stroke-width="1.5"/>`
                    : '') +
                `<rect x="2" y="2" width="12" height="12" rx="3" fill="${color}"/>` +
                `<text x="8" y="11" text-anchor="middle" font-family="'Segoe UI',sans-serif" font-size="8.5" font-weight="700" fill="${contrastText(color)}">${escapeXml(initial)}</text>` +
                (dot ? `<circle cx="12.8" cy="3.2" r="3.1" fill="${dot}"/>` : '') +
                `</svg>`;
            fs.writeFileSync(file, svg);
        }
        return vscode.Uri.file(file);
    }

    /** 색상 선택 QuickPick용 원형 견본 */
    swatch(color: string): vscode.Uri {
        const file = path.join(this.dir, `sw-${color.slice(1)}.svg`);
        if (!fs.existsSync(file)) {
            fs.writeFileSync(
                file,
                `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`
            );
        }
        return vscode.Uri.file(file);
    }
}
