import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizePath } from './paths';

/**
 * 서비스 재시작 명령 저장소 (~/.project-hub/services.json).
 * 프로젝트 경로 × 포트별로 사용자가 확정한 재시작 명령을 기억해서
 * 다음 재시작부터는 확인만 하면 되게 한다.
 */

const FILE = path.join(os.homedir(), '.project-hub', 'services.json');

function load(): Record<string, Record<string, string>> {
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch {
        return {};
    }
}

export function getServiceCommand(projectPath: string, port: number): string | undefined {
    return load()[normalizePath(projectPath)]?.[String(port)];
}

export function setServiceCommand(projectPath: string, port: number, command: string): void {
    const data = load();
    const key = normalizePath(projectPath);
    (data[key] ??= {})[String(port)] = command;
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
    } catch {
        // 저장 실패해도 이번 재시작은 진행
    }
}
