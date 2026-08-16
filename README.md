# Project Hub for Claude Code

**One VS Code window, many projects, isolated AI agent sessions.**

Switch projects from a sidebar list without reloading the window — terminals and your Claude / Gemini / Codex / Antigravity sessions keep running in the background, and a notification (with a one-click **Switch to Project** button) tells you when an agent finishes or needs your input.

*UI languages: English · 한국어 · 日本語 · 简体中文 · 繁體中文 (follows the VS Code display language).*
*[한국어 문서는 아래에 있습니다 →](#한국어)*

---

## The problem this solves

Running several AI agents across several repos normally means one VS Code window per repo. Opening a folder in an existing window (`openFolder`) reloads it and kills every terminal, so your agent sessions die with it.

Project Hub keeps **one** window. Projects swap inside a hub workspace, so the Explorer changes while every terminal and agent session stays alive. You leave an agent working on project A, go do something on project B, and get a toast when A is done.

## Features

**Instant project switching** — no window reload, no extension-host restart. The Explorer swaps; terminals don't.

**Isolated agent sessions** — per-project, per-agent terminals. Sessions are keyed by working directory, so projects never collide. The same agent can run several sessions in one project, tracked as separate rows.

**Create or add projects** — register existing folders, or create a brand-new project folder and switch straight into it.

**Browse files without switching** — every project has a `Files` node with a lazy-loaded file tree that uses your file icon theme and Git status colours, so you can look inside another project without leaving the one you're working in.

**Notifications** — toast plus an activity-bar badge when an agent finishes, asks a question, or waits for permission. Hooks install once, user-globally.

**See what's running** — per-agent status rows showing the prompt you gave (`Claude working… fix the login bug`), a **Services** section listing every dev server your agents started (with one-click stop), and a background-process tree per project.

**Briefing feed** — a card feed of what finished while you were away, summarised from each agent's last response. Persisted across restarts, last 200 entries.

**Send instructions without switching** — right-click a project, type, and it goes straight to that project's agent terminal.

**Terminal grid** — arrange live agent terminals in a 2-column editor grid with one click. An active-project grid follows you across project switches.

**Usage & cost** — per-project Claude token usage and estimated cost, aggregated from saved sessions.

**Editor tab restore** — each project remembers and restores its open tabs on switch.

## Requirements

| | |
|---|---|
| VS Code | 1.93.0 or newer |
| `curl` | Used by the notification hooks. Bundled with Windows 10+, macOS, and most Linux distros. |
| Agent CLIs | Whichever you use — `claude`, `gemini`, `codex`, `agy`. Must be on your `PATH`. |
| OS | Cross-platform, **except** the Services and Background Processes views, which use PowerShell and are Windows-only for now. |

## Install

This extension is distributed as a `.vsix` file.

**From the command line**

```bash
code --install-extension claude-project-hub-0.11.0.vsix
```

**From the VS Code UI**

Extensions view → `...` menu (top right) → **Install from VSIX…** → pick the file.

Reload the window when prompted. The **Project Hub** icon appears in the activity bar.

> Upgrading: install the newer `.vsix` the same way — VS Code replaces the previous version in place. Your project list, colours, and briefing history live outside the extension (in `~/.project-hub/`), so they survive upgrades and reinstalls.

## Getting started

1. Click the **Project Hub** icon in the activity bar.
2. **Add Project** (`+`) registers existing folders. **Create New Project** (new-folder icon) creates a folder and registers it in one step, then switches to it.
3. Click a project to switch. The first click reopens the window once into the hub workspace; every switch after that is instant.
4. Start an agent with the terminal button (▶ default agent) or the robot button (🤖 pick an agent). Notification hooks install automatically on first launch.
5. Work on another project while agents run. You'll get a toast when one finishes or needs you — click **Switch to Project** to jump back.

Status rows under each project: `🔄 working…` · `✅ done` · `🔔 waiting for response`, with the prompt text you submitted shown alongside.

> **Do not remove the `⌂ Hub` folder from the workspace.** VS Code restarts every extension when the *first* workspace folder changes. That small pinned folder permanently occupies the first slot so projects can swap in the second slot without restarting anything — including Claude Code itself.

## Multi-agent

Agents are defined in the `projectHub.agents` setting. Built-in defaults:

| Agent | New session | Resume last | Resume specific |
|---|---|---|---|
| Claude | `claude` | `claude --continue` | `claude --resume {sessionId}` |
| Gemini | `gemini` | `gemini --resume` | — |
| Codex | `codex` | `codex resume --last` | — |
| Antigravity | `agy` | `agy --continue` | `agy --conversation {sessionId}` |

- Add any CLI by appending to the array — known ids auto-fill missing fields.
- `projectHub.defaultAgent` controls auto-start on switch and the default terminal button.
- Notifications are supported for all four out of the box. Custom agents can be wired manually by POSTing `{"cwd": "..."}` to `http://127.0.0.1:43917/hook/stop?agent=<id>`.

## Sessions after a VS Code restart

Terminal processes die on a full restart, but conversation history is preserved (e.g. `~/.claude/projects/<encoded path>`).

- **⏱ Resume** restores the last conversation (`claude --continue`).
- Right-click → **Open a Claude Session** lists saved sessions with previews. Each opens in its own terminal (`claude --resume <id>`), so several sessions can run in parallel.

## Services & processes

- The **Services** section lists every process listening on a port that belongs to a registered project — grouped by project, with per-service and per-project stop buttons, plus a **Restart Service** action that remembers the command you used. Detection works even for servers started detached or from another window, matched by command line and process ancestry.
- Web services get an **Open in Browser** button that opens `http://localhost:<port>`. Known non-HTTP ports and processes — PostgreSQL, MySQL, Redis, MongoDB, the Node inspector, and so on — don't get one. Ports 443 and 8443 open over https. If a service listens on several web ports you're asked which to open, and the tooltip lists them as clickable links.
- Each project also has a **Background Processes** node showing everything under its agent terminals. MCP servers and internal helpers are hidden by default (the "N hidden" row toggles them).

## Browsing project files

Each project row has a **Files** node — a file tree of that project, right in the sidebar.

- Directories are read **one level at a time, only when you expand them**, so a large repository costs nothing until you look into it.
- Rows carry the real file URI, so you get your **file icon theme** and **Git status colours** exactly as in the Explorer.
- Clicking a file opens it in a preview tab. With `projectHub.switchOnRowClick` on (the default) it switches to that project first; turn it off to peek into another project without moving the Explorer.
- Right-click a file or folder for **Reveal in File Explorer** and **Copy Path**.
- `projectHub.fileTreeExclude` hides names you don't want listed (`.git`, `node_modules`, … by default). Matching is on the exact name, not a glob.
- The tree is read on expand — use **Project Hub: Refresh**, or collapse and expand, to pick up files created outside VS Code.

## Terminal layout

- **Grid**: the ⫽ button arranges live agent terminals in a 2-column editor grid (choose *active project only* or *all projects*). An active-project grid follows you when you switch: outgoing terminals return to the panel with sessions intact, incoming terminals form a new grid.
- `projectHub.terminalsInEditor` opens agent terminals as editor tabs from the start.
- Right-click any terminal → **Attach This Terminal to a Project** to adopt a terminal you opened yourself.

## Briefing & usage

- **Briefing**: a webview card feed of completed work and attention requests, with the agent's last response as the summary. Expand with *Show more*, click the project name to switch.
- **Usage**: projects with Claude sessions show a Usage row — total and today's estimated cost, with a per-model breakdown in the tooltip. Estimates use list prices (cache write 1.25×, cache read 0.1×). On a subscription plan this is an API-equivalent estimate, not a bill.

## Commands

Available from the Command Palette (`Ctrl+Shift+P`):

| Command | What it does |
|---|---|
| Project Hub: Add Project | Register one or more existing folders |
| Project Hub: Create New Project | Create a folder, register it, switch to it |
| Project Hub: Add Current Folder as Project | Register the folder currently open |
| Project Hub: Quick Switch Project | Fuzzy-pick a project (also on the status bar) |
| Project Hub: Arrange Agent Terminals in Grid | 2-column editor grid |
| Project Hub: Attach This Terminal to a Project | Adopt a terminal you opened yourself |
| Project Hub: Set Up Completion Notifications | (Re)install the global hooks |
| Project Hub: Refresh | Re-query processes, usage, and the tree |

Right-click a project row for per-project actions: resume, pick a session, open with a specific agent, send an instruction, set an identification colour, remove from the list.

## Settings

| Setting | Default | Description |
|---|---|---|
| `projectHub.port` | `43917` | Local HTTP port for notifications (reinstall hooks after changing) |
| `projectHub.agents` | Claude/Gemini/Codex/Antigravity | Agent list (id, label, command, resumeCommand, resumeSessionCommand) |
| `projectHub.defaultAgent` | `claude` | Agent used for auto-start and the default terminal button |
| `projectHub.focusClaudeTerminalOnSwitch` | `true` | Reveal the project's terminal on switch |
| `projectHub.switchOnRowClick` | `true` | Clicking an agent, usage, or service row switches to that project first |
| `projectHub.autoStartClaudeOnSwitch` | `true` | Auto-start the default agent if the project has no terminal |
| `projectHub.autoInstallHooks` | `true` | Install notification hooks automatically |
| `projectHub.restoreEditorsOnSwitch` | `true` | Save and restore editor tabs per project |
| `projectHub.terminalsInEditor` | `false` | Open agent terminals as editor tabs |
| `projectHub.fileTreeExclude` | `.git`, `node_modules`, `.venv`, `__pycache__`, `dist`, `out`, `.next` | Names hidden in the Files tree (exact name, not a glob) |
| `projectHub.showAllProcesses` | `false` | Show MCP servers and helpers in the process list |
| `projectHub.windowColor` | `false` | Tint the title bar with the project colour |
| `projectHub.notifyForActiveProject` | `true` | Notify for the active project too (when unfocused) |
| `projectHub.notificationTimeout` | `10` | Auto-hide toasts after N seconds (0 = keep) |

## How it works

- **No-reload switching**: replacing the whole folder (`openFolder`) reloads the window and kills every terminal. Project Hub instead swaps folders inside a hub workspace (`.code-workspace`) via `updateWorkspaceFolders`, so the Explorer switches while terminals and agent sessions stay alive.
- **Anchor folder (`⌂ Hub`)**: VS Code restarts all extensions when the first workspace folder changes. A small pinned folder occupies that slot permanently; projects swap in the second slot only.
- **Session isolation**: each agent runs in a dedicated terminal with the project as its working directory. The CLIs scope sessions by cwd, so projects never share a session.
- **Notifications**: hooks are installed once, in user-global config — Claude `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Gemini `~/.gemini/settings.json`, Antigravity `~/.gemini/antigravity-cli/hooks.json`. On each event the hook POSTs to a local HTTP server; the payload's working directory identifies the project. Nothing is written into your repositories.
- **Where your data lives**: project list, briefing history, and saved restart commands are in `~/.project-hub/`. Token usage is read (never written) from the agent CLIs' own session files.

## Troubleshooting

**No notifications arrive.**
Run **Project Hub: Set Up Completion Notifications** to reinstall the hooks, then restart any running agent sessions — a session picks up hooks at start. If you changed `projectHub.port`, the hooks must be reinstalled to match.

**"Port is already in use" warning.**
Another window or program holds the port. The hub-workspace window owns it by preference and other windows hand it over automatically, so closing the other VS Code window usually resolves it. If a different program holds it, change `projectHub.port` and reinstall the hooks.

**Every switch restarts all extensions.**
The `⌂ Hub` anchor folder was removed from the workspace. Switch projects once and it is recreated in the first slot.

**A project's Services section is empty although a dev server is running.**
Service detection is Windows-only. On Windows, servers are matched by command line and process ancestry — a server launched in a way that never mentions the project path may not be attributed. It will still appear under **Background Processes** if it was started from an agent terminal.

**I clicked a row under a project, but the Explorer still shows the previous project.**
Clicking an agent, usage, or service row switches to that project by default. If it doesn't, `projectHub.switchOnRowClick` is off — that setting exists so you can look at another project's terminal without moving the Explorer. The project row itself always switches.

**The hook seems to block my agent.**
It cannot. Hooks use `curl` with a 3-second timeout and fail silently when the server is down.

## Limitations

- Services and Background Processes require PowerShell and are Windows-only. Everything else is cross-platform.
- Codex `resume --last` cwd filtering requires a 2026+ CLI.
- Antigravity hook events follow current public docs — please report if notifications don't fire.
- Usage figures are estimates from list prices, not billing data.

## License

MIT

---

<a id="한국어"></a>

# 한국어

**VS Code 창 하나로 여러 프로젝트를.**

사이드바에서 창 리로드 없이 프로젝트를 전환하고, Claude / Gemini / Codex / Antigravity 세션을 프로젝트별로 격리해 실행합니다. 백그라운드 작업이 끝나면 알림이 오고, **프로젝트로 전환** 버튼 한 번으로 돌아갑니다.

## 이 확장이 해결하는 문제

여러 저장소에서 AI 에이전트를 동시에 돌리려면 보통 창을 저장소 수만큼 띄웁니다. 기존 창에서 폴더를 열면(`openFolder`) 창이 리로드되면서 터미널이 전부 죽고, 에이전트 세션도 같이 사라집니다.

Project Hub는 창을 **하나만** 씁니다. 허브 워크스페이스 안에서 폴더만 교체하므로 Explorer는 바뀌지만 터미널과 에이전트 세션은 그대로 살아 있습니다. A 프로젝트에 일을 시켜두고 B로 넘어가 작업하다가, A가 끝나면 알림을 받습니다.

## 주요 기능

- **즉시 전환** — 창 리로드도, extension host 재시작도 없습니다.
- **세션 격리** — 프로젝트×에이전트별 전용 터미널. 세션은 작업 디렉터리로 구분되어 섞이지 않고, 같은 에이전트를 한 프로젝트에서 여러 개 띄우면 세션별 행으로 나뉩니다.
- **프로젝트 추가·생성** — 기존 폴더를 등록하거나, **새 프로젝트 만들기**로 폴더를 새로 만들어 곧바로 전환합니다.
- **전환 없이 파일 훑어보기** — 프로젝트마다 **파일** 노드가 있어 Explorer처럼 파일 트리를 볼 수 있습니다. 파일 아이콘 테마와 Git 상태 색상이 그대로 적용되고, 작업 중인 프로젝트를 떠나지 않고 다른 프로젝트 안을 들여다볼 수 있습니다.
- **알림** — 완료·질문·권한 대기 시 토스트와 액티비티 바 배지. hook은 전역에 한 번만 설치됩니다.
- **무엇이 돌고 있는지** — 시킨 프롬프트가 함께 보이는 에이전트 상태 행(`Claude 작업 중… 로그인 버그 수정`), 에이전트가 띄운 dev 서버를 모아 보여주는 **서비스** 섹션(원클릭 종료·재시작), 프로젝트별 백그라운드 프로세스 트리.
- **브리핑** — 자리 비운 사이 끝난 작업을 카드 피드로. 에이전트의 마지막 응답이 요약으로 들어가며 최근 200개가 보존됩니다.
- **전환 없이 지시 보내기** — 프로젝트를 우클릭하고 입력하면 그 프로젝트의 에이전트 터미널로 바로 전달됩니다.
- **터미널 그리드** — 살아 있는 에이전트 터미널을 에디터 2열 그리드로 배치. 활성 프로젝트 그리드는 전환을 따라옵니다.
- **사용량·비용** — 저장된 세션을 집계한 프로젝트별 Claude 토큰 사용량과 예상 비용.
- **에디터 탭 복원** — 프로젝트마다 열어둔 탭을 기억했다가 전환 시 되살립니다.

## 요구 사항

| | |
|---|---|
| VS Code | 1.93.0 이상 |
| `curl` | 알림 hook이 사용. Windows 10+, macOS, 대부분의 Linux에 기본 포함 |
| 에이전트 CLI | 사용하는 것만 — `claude`, `gemini`, `codex`, `agy`. `PATH`에 있어야 합니다 |
| OS | 크로스 플랫폼. 단 **서비스·백그라운드 프로세스**는 PowerShell 기반이라 현재 Windows 전용 |

## 설치

`.vsix` 파일로 배포됩니다.

**명령줄**

```bash
code --install-extension claude-project-hub-0.11.0.vsix
```

**VS Code UI**

확장 뷰 → 우측 상단 `...` → **VSIX에서 설치…** → 파일 선택

안내가 뜨면 창을 다시 로드하세요. 액티비티 바에 **Project Hub** 아이콘이 생깁니다.

> 업그레이드도 새 `.vsix`를 같은 방법으로 설치하면 이전 버전을 대체합니다. 프로젝트 목록·색상·브리핑 기록은 확장 바깥(`~/.project-hub/`)에 있어서 업그레이드나 재설치 후에도 유지됩니다.

## 시작하기

1. 액티비티 바의 **Project Hub** 아이콘을 클릭합니다.
2. **프로젝트 추가**(`+`)로 기존 폴더를 등록하거나, **새 프로젝트 만들기**(새 폴더 아이콘)로 폴더를 새로 만들어 등록하고 바로 전환합니다.
3. 프로젝트를 클릭해 전환합니다. 최초 1회만 허브 워크스페이스로 창이 다시 열리고, 이후 전환은 즉시입니다.
4. ▶ 버튼(기본 에이전트) 또는 🤖 버튼(에이전트 선택)으로 전용 터미널을 시작합니다. 알림 hook은 첫 실행 때 자동 설치됩니다.
5. 다른 프로젝트에서 일하는 동안 완료·응답 대기 알림이 오면 **프로젝트로 전환**으로 돌아갑니다.

상태 행: `🔄 작업 중…` · `✅ 작업 완료` · `🔔 응답 대기 중` — 옆에 **시킨 작업 내용**이 함께 표시됩니다.

> **`⌂ Hub` 앵커 폴더를 워크스페이스에서 제거하지 마세요.** VS Code는 워크스페이스의 *첫* 폴더가 바뀌면 모든 확장을 재시작합니다. 이 작은 고정 폴더가 첫 자리를 영구히 차지하고 있어야 프로젝트가 두 번째 자리에서만 교체되고, Claude Code를 포함한 어떤 확장도 재시작되지 않습니다.

## 멀티 에이전트

`projectHub.agents` 설정으로 관리합니다.

| 에이전트 | 새 세션 | 마지막 세션 | 특정 세션 |
|---|---|---|---|
| Claude | `claude` | `claude --continue` | `claude --resume {sessionId}` |
| Gemini | `gemini` | `gemini --resume` | — |
| Codex | `codex` | `codex resume --last` | — |
| Antigravity | `agy` | `agy --continue` | `agy --conversation {sessionId}` |

배열에 항목을 추가하면 어떤 CLI든 등록할 수 있고, 알려진 id는 빠진 필드가 자동으로 채워집니다. 네 에이전트 모두 알림을 지원하며, 직접 추가한 에이전트는 완료 시 `http://127.0.0.1:43917/hook/stop?agent=<id>`로 `{"cwd": "..."}`를 POST하도록 연결하면 됩니다.

## 재시작 후 세션 복구

창을 완전히 껐다 켜면 터미널 프로세스는 죽지만 대화 기록은 남아 있습니다(`~/.claude/projects/<경로 인코딩>`).

- **⏱ 이어서 열기**로 마지막 대화를 복원합니다(`claude --continue`).
- 우클릭 → **Claude 세션 골라서 열기**로 저장된 세션을 미리보기와 함께 고르면, 각각 별도 터미널에서 병행 복원됩니다.

## 서비스·프로세스

- **서비스** 섹션은 등록된 프로젝트 소속으로 포트를 리슨 중인 프로세스를 프로젝트별로 묶어 보여주고, 개별·일괄 종료와 **서비스 재시작**(사용한 명령을 기억)을 제공합니다. 분리 실행했거나 다른 창에서 띄운 서버도 명령줄·조상 추적으로 잡습니다.
- 웹 서비스에는 **브라우저에서 열기** 버튼이 붙어 `http://localhost:<포트>`를 엽니다. PostgreSQL·MySQL·Redis·MongoDB·Node 인스펙터처럼 웹이 아닌 포트·프로세스에는 붙지 않고, 443·8443은 https로 엽니다. 웹 포트를 여러 개 리슨 중이면 어느 것을 열지 고르게 하며, 툴팁에도 클릭 가능한 링크로 나열됩니다.
- 프로젝트마다 **백그라운드 프로세스** 노드에서 에이전트 터미널 하위 프로세스를 확인할 수 있습니다. MCP·헬퍼는 기본 숨김이고 "N개 숨겨짐" 행으로 토글합니다.

## 프로젝트 파일 보기

프로젝트 행마다 **파일** 노드가 있고, 그 아래에 해당 프로젝트의 파일 트리가 펼쳐집니다.

- 디렉터리는 **펼칠 때 한 단계씩만** 읽습니다. 저장소가 아무리 커도 열어보기 전까지는 비용이 들지 않습니다.
- 각 행에 실제 파일 URI가 붙어 있어 **파일 아이콘 테마**와 **Git 상태 색상**이 Explorer와 똑같이 적용됩니다.
- 파일을 클릭하면 미리보기 탭으로 열립니다. `projectHub.switchOnRowClick`이 켜져 있으면(기본) 그 프로젝트로 전환한 뒤 열고, 끄면 Explorer를 그대로 둔 채 파일만 엽니다.
- 파일·폴더 우클릭 → **탐색기에서 보기**, **경로 복사**
- `projectHub.fileTreeExclude`로 보이지 않게 할 이름을 지정합니다 (기본: `.git`, `node_modules` 등). glob이 아니라 이름 그대로 비교합니다.
- 트리는 펼칠 때 읽으므로, VS Code 밖에서 만든 파일은 **Project Hub: 새로 고침**을 누르거나 접었다 펴면 반영됩니다.

## 터미널 배치

- **그리드**: ⫽ 버튼으로 에이전트 터미널을 에디터 2열 그리드에 배치합니다(활성 프로젝트만 / 전체 선택). 활성 프로젝트 그리드는 전환을 따라가며, 이전 터미널은 세션을 유지한 채 패널로 복귀합니다.
- `projectHub.terminalsInEditor`를 켜면 처음부터 에디터 탭으로 열립니다.
- 아무 터미널이나 우클릭 → **이 터미널을 프로젝트에 연결**로 직접 연 터미널을 편입할 수 있습니다.

## 브리핑·사용량

- **브리핑**: 완료된 작업과 확인 요청을 카드 피드로 보여줍니다. *더 보기*로 전문을 펼치고, 프로젝트명을 클릭하면 전환됩니다.
- **사용량**: Claude 세션이 있는 프로젝트에 누적·오늘 예상 비용이 표시되고, 툴팁에 모델별 분해가 나옵니다. 정가 기준 추정치(캐시 쓰기 1.25×, 읽기 0.1×)이며 구독 플랜이라면 실제 청구액이 아니라 API 환산 추정치입니다.

## 명령

명령 팔레트(`Ctrl+Shift+P`)에서 실행합니다.

| 명령 | 설명 |
|---|---|
| Project Hub: 프로젝트 추가 | 기존 폴더를 하나 이상 등록 |
| Project Hub: 새 프로젝트 만들기 | 폴더를 만들어 등록하고 전환 |
| Project Hub: 현재 폴더를 프로젝트로 추가 | 지금 열려 있는 폴더를 등록 |
| Project Hub: 프로젝트 빠른 전환 | 프로젝트 검색 전환 (상태 표시줄에서도 가능) |
| Project Hub: 에이전트 터미널 그리드 배치 | 에디터 2열 그리드 |
| Project Hub: 이 터미널을 프로젝트에 연결 | 직접 연 터미널 편입 |
| Project Hub: 완료 알림 설정 | 전역 hook 재설치 |
| Project Hub: 새로 고침 | 프로세스·사용량·트리 재조회 |

프로젝트 행 우클릭으로 이어서 열기, 세션 고르기, 에이전트 지정 실행, 지시 보내기, 식별 색상 지정, 리스트에서 제거를 쓸 수 있습니다.

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `projectHub.port` | `43917` | 알림 수신 로컬 HTTP 포트 (변경 시 hook 재설치 필요) |
| `projectHub.agents` | Claude/Gemini/Codex/Antigravity | 에이전트 목록 |
| `projectHub.defaultAgent` | `claude` | 자동 시작·기본 터미널 버튼에 쓸 에이전트 |
| `projectHub.focusClaudeTerminalOnSwitch` | `true` | 전환 시 해당 프로젝트 터미널 표시 |
| `projectHub.switchOnRowClick` | `true` | 에이전트·사용량·서비스 행 클릭 시 먼저 그 프로젝트로 전환 |
| `projectHub.autoStartClaudeOnSwitch` | `true` | 터미널이 없으면 기본 에이전트 자동 시작 |
| `projectHub.autoInstallHooks` | `true` | 알림 hook 자동 설치 |
| `projectHub.restoreEditorsOnSwitch` | `true` | 프로젝트별 에디터 탭 저장·복원 |
| `projectHub.terminalsInEditor` | `false` | 에이전트 터미널을 에디터 탭으로 열기 |
| `projectHub.fileTreeExclude` | `.git`, `node_modules`, `.venv`, `__pycache__`, `dist`, `out`, `.next` | 파일 트리에서 숨길 이름 (glob 아님) |
| `projectHub.showAllProcesses` | `false` | MCP·헬퍼까지 프로세스 목록에 표시 |
| `projectHub.windowColor` | `false` | 타이틀 바를 프로젝트 색으로 물들이기 |
| `projectHub.notifyForActiveProject` | `true` | 활성 프로젝트도 알림 (창이 포커스를 잃었을 때) |
| `projectHub.notificationTimeout` | `10` | N초 뒤 토스트 자동 숨김 (0이면 유지) |

## 동작 원리

- **리로드 없는 전환**: `openFolder`로 폴더를 통째로 바꾸면 창이 리로드되고 터미널이 전부 죽습니다. 대신 허브 워크스페이스(`.code-workspace`) 안에서 `updateWorkspaceFolders`로 폴더만 교체하므로 Explorer는 바뀌고 세션은 살아남습니다.
- **앵커 폴더(`⌂ Hub`)**: 첫 워크스페이스 폴더가 바뀌면 모든 확장이 재시작되므로, 작은 고정 폴더가 그 자리를 영구히 차지하고 프로젝트는 두 번째 자리에서만 교체됩니다.
- **세션 격리**: 각 에이전트가 프로젝트를 작업 디렉터리로 하는 전용 터미널에서 실행됩니다. CLI들이 cwd로 세션을 구분하므로 프로젝트끼리 세션을 공유하지 않습니다.
- **알림**: hook은 사용자 전역 설정에 한 번만 설치됩니다 — Claude `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Gemini `~/.gemini/settings.json`, Antigravity `~/.gemini/antigravity-cli/hooks.json`. 이벤트마다 로컬 HTTP 서버로 POST하고, 페이로드의 작업 디렉터리로 프로젝트를 식별합니다. **저장소 안에는 아무것도 쓰지 않습니다.**
- **데이터 위치**: 프로젝트 목록·브리핑 기록·저장된 재시작 명령은 `~/.project-hub/`에 있습니다. 토큰 사용량은 에이전트 CLI의 세션 파일에서 **읽기만** 합니다.

## 문제 해결

**알림이 오지 않습니다.**
**Project Hub: 완료 알림 설정**으로 hook을 다시 설치한 뒤, 실행 중이던 에이전트 세션을 재시작하세요. hook은 세션 시작 시점에 반영됩니다. `projectHub.port`를 바꿨다면 반드시 재설치해야 합니다.

**"포트가 이미 사용 중" 경고가 뜹니다.**
다른 창이나 프로그램이 포트를 쥐고 있습니다. 허브 워크스페이스 창이 우선 소유하고 창이 바뀌면 자동 인계되므로, 다른 VS Code 창을 닫으면 대개 해결됩니다. 다른 프로그램이 원인이면 `projectHub.port`를 바꾸고 hook을 재설치하세요.

**전환할 때마다 모든 확장이 재시작됩니다.**
`⌂ Hub` 앵커 폴더가 워크스페이스에서 제거된 상태입니다. 프로젝트를 한 번 전환하면 첫 자리에 다시 만들어집니다.

**dev 서버가 도는데 서비스 섹션이 비어 있습니다.**
서비스 탐지는 Windows 전용입니다. Windows에서도 명령줄과 조상 프로세스로 귀속을 판단하므로, 프로젝트 경로가 전혀 드러나지 않게 실행된 서버는 누락될 수 있습니다. 에이전트 터미널에서 띄운 것이라면 **백그라운드 프로세스**에는 나타납니다.

**프로젝트 하위 행을 클릭했는데 Explorer가 이전 프로젝트를 그대로 보여줍니다.**
에이전트·사용량·서비스 행을 클릭하면 기본적으로 그 프로젝트로 전환됩니다. 전환되지 않는다면 `projectHub.switchOnRowClick`이 꺼져 있는 것입니다. 이 설정은 Explorer를 그대로 둔 채 다른 프로젝트의 터미널만 확인하고 싶을 때를 위한 것입니다. 프로젝트 행 본체는 설정과 무관하게 항상 전환합니다.

**hook이 에이전트 작업을 막지는 않나요?**
막지 않습니다. `curl`에 3초 타임아웃이 걸려 있고, 서버가 꺼져 있으면 조용히 실패합니다.

## 알려진 제약

- 서비스·백그라운드 프로세스는 PowerShell이 필요해 Windows 전용입니다. 그 외 기능은 크로스 플랫폼입니다.
- Codex `resume --last`의 cwd 필터는 2026년 이후 CLI가 필요합니다.
- Antigravity hook 이벤트는 현재 공개 문서 기준입니다. 알림이 오지 않으면 제보해 주세요.
- 사용량 수치는 정가 기준 추정치이며 실제 청구 데이터가 아닙니다.

## 라이선스

MIT
