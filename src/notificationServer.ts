import * as vscode from 'vscode';
import * as http from 'http';

export type HookEvent = 'working' | 'stop' | 'notification' | 'end';

export interface HookPayload {
    cwd?: string;
    message?: string;
    session_id?: string;
    [key: string]: unknown;
}

/**
 * Claude Code hook이 POST하는 이벤트를 수신하는 로컬 HTTP 서버.
 * 라우트: /hook/working (UserPromptSubmit), /hook/stop (Stop),
 *        /hook/notification (Notification), /hook/end (SessionEnd — 세션 종료 시 잔상 정리)
 *
 * 포트는 한 창만 소유할 수 있다. 바인딩 실패(EADDRINUSE) 시 onConflict 콜백만 호출하고
 * 경고 표시 여부는 호출 측(허브 창 여부)이 결정한다. stop() 후 start()로 재시도할 수 있다.
 */
export class NotificationServer implements vscode.Disposable {
    private server?: http.Server;
    private listening = false;

    constructor(
        private onEvent: (event: HookEvent, payload: HookPayload, agentId: string) => void,
        private onConflict: (port: number) => void
    ) {}

    get isListening(): boolean {
        return this.listening;
    }

    start(port: number): void {
        if (this.server) {
            return;
        }
        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const match = /^\/hook\/(working|stop|notification|end)$/.exec(url.pathname);
            if (req.method !== 'POST' || !match) {
                res.writeHead(404).end();
                return;
            }
            const event = match[1] as HookEvent;
            const agentId = url.searchParams.get('agent') ?? 'claude';
            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (body.length > 1024 * 1024) {
                    req.destroy();
                }
            });
            req.on('end', () => {
                let payload: HookPayload = {};
                try {
                    payload = JSON.parse(body);
                } catch {
                    // 빈 본문/비JSON도 무시하고 이벤트만 전달
                }
                // 본문 없이 응답: Gemini/Codex hook은 명령의 stdout JSON을
                // decision으로 해석할 수 있으므로 curl이 아무것도 출력하지 않게 한다
                res.writeHead(204).end();
                this.onEvent(event, payload, agentId);
            });
        });

        server.on('listening', () => {
            this.listening = true;
        });

        server.on('error', (err: NodeJS.ErrnoException) => {
            this.listening = false;
            this.server = undefined;
            server.close();
            if (err.code === 'EADDRINUSE') {
                this.onConflict(port);
            } else {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('Project Hub notification server error: {0}', err.message)
                );
            }
        });

        this.server = server;
        server.listen(port, '127.0.0.1');
    }

    stop(): void {
        this.server?.close();
        this.server = undefined;
        this.listening = false;
    }

    dispose(): void {
        this.stop();
    }
}
