import * as vscode from 'vscode';
import { BriefingEntry, BriefingStore, relativeTime } from './briefing';

/**
 * 사이드바 "브리핑" 섹션 (웹뷰).
 * 트리 뷰는 행당 한 줄 제약 때문에 긴 요약을 제대로 못 보여줘서
 * HTML 카드 피드로 렌더링한다 — 폭에 맞춰 자연 줄바꿈, 3줄 넘으면 "더 보기".
 */
export class BriefingViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;

    constructor(
        private store: BriefingStore,
        private agentLabel: (id: string) => string
    ) {}

    register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('projectHub.briefing', this),
            this.store.onDidChange(() => this.render())
        );
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.onDidReceiveMessage((msg: { type: string; at?: number; path?: string }) => {
            if (msg.type === 'open') {
                const entry = this.store
                    .getEntries()
                    .find(e => e.at === msg.at && e.projectPath === msg.path);
                if (entry) {
                    void vscode.commands.executeCommand('projectHub.openBriefing', entry);
                }
            }
        });
        // 다시 보일 때 상대 시각("N분 전")을 갱신
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this.render();
            }
        });
        this.render();
    }

    private render(): void {
        if (!this.view) {
            return;
        }
        this.view.webview.html = this.html(this.store.getEntries());
    }

    private html(entries: BriefingEntry[]): string {
        const esc = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const openTitle = esc(vscode.l10n.t('Click: switch to project'));
        const moreLabel = vscode.l10n.t('Show more');
        const lessLabel = vscode.l10n.t('Collapse');
        const emptyText =
            esc(vscode.l10n.t('No briefings yet.')) +
            '<br>' +
            esc(vscode.l10n.t('Summaries appear here when an agent finishes or waits for your response.'));
        const cards = entries
            .map(e => {
                const icon = e.kind === 'done' ? '✅' : '🔔';
                const time = new Date(e.at).toLocaleString();
                return `
<div class="card">
  <div class="head">
    <span class="icon">${icon}</span>
    <a class="proj" data-at="${e.at}" data-path="${esc(e.projectPath)}" title="${openTitle}">${esc(e.projectName)}</a>
    <span class="agent">${esc(this.agentLabel(e.agentId))}</span>
    <span class="time" title="${esc(time)}">${esc(relativeTime(e.at))}</span>
  </div>
  <div class="body clamp">${esc(e.text)}</div>
  <a class="more" hidden>${esc(moreLabel)}</a>
</div>`;
            })
            .join('\n');

        return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0 10px 10px;
    margin: 0;
  }
  .card {
    padding: 8px 0;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25));
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 4px;
    white-space: nowrap;
  }
  .icon { flex: none; }
  .proj {
    color: var(--vscode-textLink-foreground);
    font-weight: 600;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .proj:hover { text-decoration: underline; }
  .agent {
    color: var(--vscode-descriptionForeground);
    font-size: .88em;
    flex: none;
  }
  .time {
    margin-left: auto;
    color: var(--vscode-descriptionForeground);
    font-size: .88em;
    flex: none;
  }
  .body {
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .body.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .more {
    display: inline-block;
    margin-top: 3px;
    color: var(--vscode-textLink-foreground);
    font-size: .88em;
    cursor: pointer;
  }
  .empty {
    color: var(--vscode-descriptionForeground);
    padding: 14px 2px;
    line-height: 1.6;
  }
</style>
</head>
<body>
${cards || `<div class="empty">${emptyText}</div>`}
<script>
  const vscode = acquireVsCodeApi();
  const MORE = ${JSON.stringify(moreLabel)};
  const LESS = ${JSON.stringify(lessLabel)};
  for (const link of document.querySelectorAll('.proj')) {
    link.addEventListener('click', () => {
      vscode.postMessage({ type: 'open', at: Number(link.dataset.at), path: link.dataset.path });
    });
  }
  for (const card of document.querySelectorAll('.card')) {
    const body = card.querySelector('.body');
    const more = card.querySelector('.more');
    // 3줄로 잘렸을 때만 "더 보기" 표시
    if (body.scrollHeight > body.clientHeight + 2) {
      more.hidden = false;
    }
    more.addEventListener('click', () => {
      const clamped = body.classList.toggle('clamp');
      more.textContent = clamped ? MORE : LESS;
    });
  }
</script>
</body>
</html>`;
    }
}
