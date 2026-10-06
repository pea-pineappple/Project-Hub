# Project Hub — Multi-Project & Agent Workspace

**One VS Code window, many projects, isolated AI agent sessions.**

Switch projects from a sidebar list without reloading the window — terminals and your Claude / Codex / Gemini / Antigravity / OpenCode sessions keep running in the background, and a notification (with a one-click **Switch to Project** button) tells you when an agent finishes or needs your input. Projects on your other PCs and SSH servers show up in the same list.

*Formerly "Project Hub for Claude Code" — it started as a Claude Code helper and grew into a multi-project, multi-agent workspace. Data from earlier versions carries over automatically.*

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

**Project terminal grid** — on each switch, only the active project's agent terminals are shown, in a 2-column editor grid. Other projects' terminals wait in the closed panel, still running. A one-click *all projects* view puts each project in its own cell with its terminals as tabs.

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

**From the VS Code Marketplace (recommended)**

1. In VS Code, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **Project Hub** and click **Install** — or open it directly: [PecuniaEstAI.projecthub](https://marketplace.visualstudio.com/items?itemName=PecuniaEstAI.projecthub).

**Offline / manual install (.vsix)**

```bash
code --install-extension projecthub-<version>.vsix
```

Or: Extensions view → `...` menu (top right) → **Install from VSIX…** → pick the file.

Reload the window when prompted. The **Project Hub** icon appears in the activity bar.

**Upgrading from "Project Hub for Claude Code" (`pecuniaestai.claude-project-hub`)**: the extension ID changed to `pecuniaestai.projecthub`, so VS Code treats it as a new extension. Install the new one, then uninstall the old one — Project Hub warns while both are installed. Your project list (`~/.project-hub/`) and avatars carry over, and the hub workspace offers a one-time migration. Per-project editor tabs, session names, and the PC/server list start fresh (the list refills as you open windows).

> Upgrading: update from the Marketplace (Extensions view → filter **Installed** → **Update**), or install the newer `.vsix` the same way — VS Code replaces the previous version in place. Your project list, colours, and briefing history live outside the extension (in `~/.project-hub/`), so they survive upgrades and reinstalls.

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
| OpenCode | `opencode` | `opencode --continue` | `opencode --session {sessionId}` |
| Terminal | *(shell only)* | — | — |

- Add any CLI by appending to the array — known ids auto-fill missing fields.
- `projectHub.defaultAgent` controls auto-start on switch and the default terminal button.
- Notifications work out of the box for Claude, Codex, Gemini, and Antigravity. OpenCode (plugin-based, no hooks) and the plain Terminal entry have none. Custom agents can be wired manually by POSTing `{"cwd": "..."}` to `http://127.0.0.1:43917/hook/stop?agent=<id>`.

## Sessions after a VS Code restart

Terminal processes die on a full restart, but conversation history is preserved (e.g. `~/.claude/projects/<encoded path>`).

- **⏱ Resume** restores the last conversation (`claude --continue`).
- Right-click → **Open a Claude Session** lists saved sessions with previews. Each opens in its own terminal (`claude --resume <id>`), so several sessions can run in parallel.
- **Automatic re-run**: VS Code restores agent terminals as plain shells. A few seconds after startup, Project Hub re-runs the agent in each of them — the last session for a default terminal, that session for a Claude session terminal. Only shells started fresh by this launch are touched; after a window reload, or in a terminal where you quit the agent yourself, nothing is sent. Turn off with `projectHub.resumeAgentsOnRestart`.

## Remote (SSH)

Under Remote-SSH the extension runs on the remote host, so agent terminals, the project list (`~/.project-hub/`) and notification hooks all live there. Install the extension in the remote window — from the Marketplace (Extensions view → search **Project Hub** → **Install in SSH: …**), or from a VSIX if the remote has no network access — and put the agent CLIs on the remote `PATH`.

> **Set up an SSH key first.** With password login, Remote-SSH asks for the password **several times per connection** (host check, server install check, the connection itself), and again on every new window, reload, or reconnect — Project Hub opens a new window whenever you click a project on another device, so this adds up fast. Remote-SSH cannot store passwords.
>
> - **Automatic**: in a local window, run **Project Hub: Set Up SSH Key for a Server** (or right-click a server group in the list). It creates `~/.ssh/id_ed25519` if you have none, opens a terminal where you type the server password **once**, adds the public key to the server's `~/.ssh/authorized_keys`, and checks that key login works. Clicking a project on a server without key login offers this first.
> - **Manual** (PowerShell): `ssh-keygen -t ed25519`, then
>   `type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@server "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`
> - If key login still fails, the server may disallow it — ask its admin to check `PubkeyAuthentication yes` in `/etc/ssh/sshd_config`.

A dropped connection keeps remote terminals alive only for a while; a remote server restart or update ends them. So in a remote window Project Hub always tries to keep agents running on its own:

- **tmux installed**: each agent runs in `tmux new-session -A -s ph-<project>-<hash>-<agent>` (mouse scrolling on). On reconnect, Project Hub opens a terminal for each of its live tmux sessions and attaches — the agent never stopped.
- **tmux missing**: agents run in plain terminals as before, with a one-time notice (*Don't Show Again* available). tmux is checked on every launch, so installing it later takes effect immediately.
- Local windows are unaffected. Services, Background Processes, and restart revive are Windows-only and stay empty on a Linux remote.

**One list across PCs and servers.** A VS Code window connects to one place only, so each PC and server keeps its own project list, and switching stays within that place. Every window also shares its list with the others:

- The view title shows where this window is connected, e.g. `Local · TECH-DEV-1` or `SSH · dev-linux-01`.
- Once another PC or server is known, the list becomes **device → projects**: this window's device comes first (expanded, marked *this window*), the others follow at the same level (`device-desktop` icon for a PC, `remote` icon for an SSH server). With a single device the projects are listed directly. A server shows up once you have opened a window on it with Project Hub installed.
- Clicking a project in another group opens a window connected there and switches it to that project. If that window is already open, VS Code moves to it instead. It is always a separate window.
- Right-click a group → **Hide This PC/Server from the List**; it reappears the next time a window opens there.
- SSH groups reconnect as `user@<server IP>`. A non-standard port or key must be set in `~/.ssh/config` under that IP.

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

VS Code offers no way to filter the terminal tab list by project, so Project Hub shows only the active project's terminals by moving them into the editor area.

- **Project grid** (`projectHub.projectTerminalGrid`, on by default): on every switch, the active project's agent terminals fill the editor area in a 2-column grid (one terminal per cell, up to 6). Other projects' terminals go back to the closed panel with sessions intact. Opening another agent for the active project rebuilds the grid. Open files stay as background tabs in the first cell.
- **⫽ button**: arrange on demand. *All projects* gives each project one cell with its terminals as tabs; *active project only* gives each terminal its own cell. With the project grid on, the next switch or new agent returns to the active-project grid.
- With the project grid off: `projectHub.splitAgentTerminals` opens a project's next agent split beside its existing terminal, and `projectHub.terminalsInEditor` opens agent terminals as editor tabs.
- VS Code auto-locks editor groups that contain only a terminal (`workbench.editor.autoLockGroups`), so files you open go to another group. Project Hub unlocks and closes empty groups before each rearrangement.
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
| Project Hub: Set Up SSH Key for a Server | Register an SSH key with one password entry (local window) |
| Project Hub: Attach This Terminal to a Project | Adopt a terminal you opened yourself |
| Project Hub: Set Up Completion Notifications | (Re)install the global hooks |
| Project Hub: Refresh | Re-query processes, usage, and the tree |

Right-click a project row for per-project actions: resume, pick a session, open with a specific agent, send an instruction, set an identification colour, remove from the list.

## Settings

| Setting | Default | Description |
|---|---|---|
| `projectHub.port` | `43917` | Local HTTP port for notifications (reinstall hooks after changing) |
| `projectHub.agents` | Claude/Gemini/Codex/Antigravity/OpenCode/Terminal | Agent list (id, label, command, resumeCommand, resumeSessionCommand) |
| `projectHub.defaultAgent` | `claude` | Agent used for auto-start and the default terminal button |
| `projectHub.focusClaudeTerminalOnSwitch` | `true` | Reveal the project's terminal on switch |
| `projectHub.switchOnRowClick` | `true` | Clicking an agent, usage, or service row switches to that project first |
| `projectHub.autoStartClaudeOnSwitch` | `true` | Auto-start the default agent if the project has no terminal |
| `projectHub.autoInstallHooks` | `true` | Install notification hooks automatically |
| `projectHub.restoreEditorsOnSwitch` | `true` | Save and restore editor tabs per project |
| `projectHub.projectTerminalGrid` | `true` | Show only the active project's agent terminals, in an editor grid |
| `projectHub.resumeAgentsOnRestart` | `true` | Re-run agents in terminals restored after a full VS Code restart |
| `projectHub.splitAgentTerminals` | `true` | Open a project's next agent split beside its existing terminal (project grid off only) |
| `projectHub.terminalsInEditor` | `false` | Open agent terminals as editor tabs (project grid off only) |
| `projectHub.fileTreeExclude` | `.git`, `node_modules`, `.venv`, `__pycache__`, `dist`, `out`, `.next` | Names hidden in the Files tree (exact name, not a glob) |
| `projectHub.showAllProcesses` | `false` | Show MCP servers and helpers in the process list |
| `projectHub.windowColor` | `false` | Tint the title bar with the project colour |
| `projectHub.notifyForActiveProject` | `true` | Notify for the active project too (when unfocused) |
| `projectHub.notificationTimeout` | `10` | Auto-hide toasts after N seconds (0 = keep) |

## How it works

- **No-reload switching**: replacing the whole folder (`openFolder`) reloads the window and kills every terminal. Project Hub instead swaps folders inside a hub workspace (`.code-workspace`) via `updateWorkspaceFolders`, so the Explorer switches while terminals and agent sessions stay alive.
- **Anchor folder (`⌂ Hub`)**: VS Code restarts all extensions when the first workspace folder changes. A small pinned folder occupies that slot permanently; projects swap in the second slot only.
- **Session isolation**: each agent runs in a dedicated terminal with the project as its working directory. The CLIs scope sessions by cwd, so projects never share a session.
- **Notifications**: hooks are installed once, in user-global config — Claude `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Gemini `~/.gemini/settings.json`, Antigravity `~/.gemini/antigravity-cli/hooks.json`. On each event the hook POSTs to a local HTTP server; the payload's working directory identifies the project. Nothing is written into your repositories. On Windows the command is `curl.exe … -d '@-'`, which means the same in Git Bash (Claude) and PowerShell (Gemini runs hooks with `powershell -Command`, where plain `curl` is an alias for `Invoke-WebRequest`).
- **Where your data lives**: project list, briefing history, and saved restart commands are in `~/.project-hub/`. Token usage is read (never written) from the agent CLIs' own session files.

## Troubleshooting

**No notifications arrive.**
Run **Project Hub: Set Up Completion Notifications** to reinstall the hooks, then restart any running agent sessions — a session picks up hooks at start. If you changed `projectHub.port`, the hooks must be reinstalled to match.

**Gemini never notifies on Windows (before 0.18.4).**
Gemini runs hooks through PowerShell, and the old `curl … -d @-` command failed there. 0.18.4 switches to `curl.exe … -d '@-'` and reinstalls outdated hooks the next time you open the agent from Project Hub (or run **Set Up Completion Notifications**). Restart running Gemini sessions afterwards.

**Clicking a *waiting* / *done* row opened the same session in a second terminal (before 0.18.4).**
Switching to the project cleared those statuses before the row checked whether the session was alive, so it was resumed again with `--resume`. Fixed: liveness is checked before switching, and an existing terminal of that agent is shown instead. If two terminals still share one conversation, quit one of them with `/exit`.

**"Port is already in use" warning.**
Another window or program holds the port. The hub-workspace window owns it by preference and other windows hand it over automatically, so closing the other VS Code window usually resolves it. If a different program holds it, change `projectHub.port` and reinstall the hooks.

**Every switch restarts all extensions.**
The `⌂ Hub` anchor folder was removed from the workspace. Switch projects once and it is recreated in the first slot.

**A project's Services section is empty although a dev server is running.**
Service detection is Windows-only. On Windows, servers are matched by command line and process ancestry — a server launched in a way that never mentions the project path may not be attributed. It will still appear under **Background Processes** if it was started from an agent terminal.

**I clicked a row under a project, but the Explorer still shows the previous project.**
Clicking an agent, usage, or service row switches to that project by default. If it doesn't, `projectHub.switchOnRowClick` is off — that setting exists so you can look at another project's terminal without moving the Explorer. The project row itself always switches.

**An agent exits by itself in a Python project; the terminal shows `Activate.ps1` / `deactivate` lines.**
The Python Environments extension activates virtual environments by typing commands into terminals. When a project switch changes the workspace folders, it re-types `deactivate` and the activate command into terminals where an agent is already running, and the agent exits. Stop it from typing into terminals in your user settings:

```json
"python-envs.terminal.autoActivationType": "off"
```

`shellStartup` also avoids typed commands, but edits your PowerShell profile. Agents normally find the project's `.venv` on their own.

**The first character of the agent command is missing (`laude --continue`).**
Fixed in 0.15.4: commands are sent once the shell reports it is ready (shell integration), or after 4 seconds for shells without it.

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

**Project Hub — 여러 프로젝트와 에이전트를 한 작업 공간에서.**

사이드바에서 창 리로드 없이 프로젝트를 전환하고, Claude / Codex / Gemini / Antigravity / OpenCode 세션을 프로젝트별로 격리해 실행합니다. 백그라운드 작업이 끝나면 알림이 오고, **프로젝트로 전환** 버튼 한 번으로 돌아갑니다. 다른 PC와 SSH 서버의 프로젝트도 같은 목록에 보입니다.

*이전 이름은 "Project Hub for Claude Code"입니다. Claude Code 보조 도구로 시작해 여러 프로젝트·여러 에이전트 작업 공간으로 커졌습니다. 이전 버전의 데이터는 자동으로 이어집니다.*

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
- **프로젝트 터미널 그리드** — 전환할 때마다 활성 프로젝트의 에이전트 터미널만 에디터 2열 그리드로 보여 줍니다. 다른 프로젝트 터미널은 닫힌 패널에서 계속 실행됩니다. *전체 프로젝트* 보기는 프로젝트마다 한 칸, 그 안의 터미널은 탭으로 합쳐 보여 줍니다.
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

**VS Code 마켓플레이스에서 (권장)**

1. VS Code에서 확장 뷰를 엽니다 (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. **Project Hub**를 검색해서 **설치**를 누르거나, 바로가기: [PecuniaEstAI.projecthub](https://marketplace.visualstudio.com/items?itemName=PecuniaEstAI.projecthub)

**오프라인/수동 설치 (.vsix)**

```bash
code --install-extension projecthub-<version>.vsix
```

또는: 확장 뷰 → 우측 상단 `...` → **VSIX에서 설치…** → 파일 선택

안내가 뜨면 창을 다시 로드하세요. 액티비티 바에 **Project Hub** 아이콘이 생깁니다.

**"Project Hub for Claude Code"(`pecuniaestai.claude-project-hub`)에서 업그레이드할 때**: 확장 ID가 `pecuniaestai.projecthub`로 바뀌어 VS Code는 새 확장으로 취급합니다. 새 버전을 설치한 뒤 이전 확장을 제거하세요. 둘 다 설치되어 있으면 Project Hub가 경고합니다. 프로젝트 목록(`~/.project-hub/`)과 아바타는 그대로 이어지고, 허브 워크스페이스는 한 번 이전 안내가 뜹니다. 프로젝트별 편집기 탭, 세션 이름, PC·서버 목록은 새로 시작합니다(PC·서버 목록은 창을 열 때마다 다시 채워집니다).

> 업그레이드는 마켓플레이스에서(확장 뷰 → **설치됨** 필터 → **업데이트**) 하거나, 새 `.vsix`를 같은 방법으로 설치하면 이전 버전을 대체합니다. 프로젝트 목록·색상·브리핑 기록은 확장 바깥(`~/.project-hub/`)에 있어서 업그레이드나 재설치 후에도 유지됩니다.

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
| OpenCode | `opencode` | `opencode --continue` | `opencode --session {sessionId}` |
| Terminal | *(셸만 열기)* | — | — |

배열에 항목을 추가하면 어떤 CLI든 등록할 수 있고, 알려진 id는 빠진 필드가 자동으로 채워집니다. Claude·Gemini·Codex·Antigravity는 알림을 지원하고, OpenCode(hook이 아닌 플러그인 방식)와 Terminal 항목은 알림이 없습니다. 직접 추가한 에이전트는 완료 시 `http://127.0.0.1:43917/hook/stop?agent=<id>`로 `{"cwd": "..."}`를 POST하도록 연결하면 됩니다.

## 재시작 후 세션 복구

창을 완전히 껐다 켜면 터미널 프로세스는 죽지만 대화 기록은 남아 있습니다(`~/.claude/projects/<경로 인코딩>`).

- **⏱ 이어서 열기**로 마지막 대화를 복원합니다(`claude --continue`).
- 우클릭 → **Claude 세션 골라서 열기**로 저장된 세션을 미리보기와 함께 고르면, 각각 별도 터미널에서 병행 복원됩니다.
- **자동 재실행**: VS Code는 에이전트 터미널을 셸만 남은 채 복원합니다. 시작 몇 초 뒤 Project Hub가 각 터미널에서 에이전트를 다시 실행합니다 — 기본 터미널은 마지막 세션, Claude 세션 터미널은 그 세션. 이번 실행에서 새로 뜬 셸만 대상이며, 창 리로드 후나 직접 에이전트를 종료해 둔 터미널에는 아무것도 보내지 않습니다. `projectHub.resumeAgentsOnRestart`로 끌 수 있습니다.

## 원격 (SSH)

Remote-SSH에서는 확장이 원격 서버에서 실행되므로 에이전트 터미널, 프로젝트 목록(`~/.project-hub/`), 알림 hook이 모두 원격에 있습니다. 원격 창에 확장을 설치하세요 — 마켓플레이스에서(확장 뷰 → **Project Hub** 검색 → **SSH: …에 설치**) 하거나, 원격이 네트워크에서 격리돼 있으면 VSIX로 — 그리고 에이전트 CLI를 원격 `PATH`에 두세요.

> **SSH 키를 먼저 설정하세요.** 비밀번호 로그인이면 Remote-SSH는 **연결 한 번에 비밀번호를 여러 번**(서버 확인, 원격 서버 설치 확인, 실제 연결) 묻고, 새 창·새로고침·재연결 때마다 다시 묻습니다. Project Hub는 다른 장비의 프로젝트를 누르면 새 창을 열기 때문에 횟수가 금방 늘어납니다. Remote-SSH는 비밀번호를 저장하지 못합니다.
>
> - **자동**: 로컬 창에서 **Project Hub: 서버에 SSH 키 설정**을 실행하세요(목록의 서버 그룹 우클릭으로도 가능). 키(`~/.ssh/id_ed25519`)가 없으면 만들고, 터미널에서 서버 비밀번호를 **한 번만** 입력받아 서버의 `~/.ssh/authorized_keys`에 공개키를 등록한 뒤, 키 로그인이 되는지 확인합니다. 키 로그인이 안 되는 서버의 프로젝트를 누르면 이 설정을 먼저 권합니다.
> - **수동** (PowerShell): `ssh-keygen -t ed25519` 후
>   `type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@서버 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`
> - 그래도 키 로그인이 안 되면 서버가 막아 둔 것일 수 있습니다. 관리자에게 `/etc/ssh/sshd_config`의 `PubkeyAuthentication yes`를 확인해 달라고 하세요.

연결이 끊겨도 원격 터미널은 한동안만 유지되고, 원격 서버가 재시작·업데이트되면 종료됩니다. 그래서 원격 창에서는 Project Hub가 항상 에이전트를 계속 돌리도록 처리합니다.

- **tmux 있음**: 에이전트를 `tmux new-session -A -s ph-<프로젝트>-<해시>-<에이전트>`로 실행합니다(마우스 스크롤 켜짐). 다시 연결하면 Project Hub가 살아 있는 자기 tmux 세션마다 터미널을 열어 붙습니다 — 에이전트는 멈춘 적이 없습니다.
- **tmux 없음**: 전처럼 일반 터미널로 실행하고 안내를 한 번 띄웁니다(*다시 표시 안 함* 가능). 실행할 때마다 tmux를 확인하므로 나중에 설치하면 바로 적용됩니다.
- 로컬 창에는 영향이 없습니다. 서비스, 백그라운드 프로세스, 재시작 후 자동 재실행은 Windows 전용이라 Linux 원격에서는 비어 있습니다.

**여러 PC·서버를 한 목록에서.** VS Code 창 하나는 한 곳에만 연결되므로, PC·서버마다 프로젝트 목록이 따로 있고 전환도 그 안에서만 됩니다. 대신 모든 창이 자기 목록을 서로 공유합니다.

- 목록 제목 옆에 이 창이 연결된 곳이 표시됩니다(예: `로컬 · TECH-DEV-1`, `SSH · dev-linux-01`).
- 다른 PC·서버가 하나라도 있으면 목록이 **장비 → 프로젝트** 구조가 됩니다. 이 창의 장비가 맨 위(펼침, *현재 창* 표시)에, 다른 장비는 같은 계층에 이어집니다(PC는 모니터 아이콘, SSH 서버는 원격 아이콘). 장비가 하나뿐이면 프로젝트가 바로 나옵니다. 서버는 Project Hub가 설치된 창으로 한 번 접속하면 나타납니다.
- 다른 그룹의 프로젝트를 누르면 그곳에 연결된 창을 열고 그 프로젝트로 전환합니다. 그 창이 이미 열려 있으면 새 창 대신 그 창으로 이동합니다. 항상 별도 창입니다.
- 그룹을 우클릭 → **이 PC/서버를 목록에서 숨기기**. 그곳에서 창을 다시 열면 다시 나타납니다.
- SSH 그룹은 `사용자@서버IP`로 다시 접속합니다. 22가 아닌 포트나 키는 `~/.ssh/config`에 그 IP 항목으로 설정하세요.

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

VS Code는 터미널 탭 목록을 프로젝트별로 거르는 기능을 제공하지 않으므로, Project Hub는 활성 프로젝트 터미널을 에디터 영역으로 옮겨서 그것만 보이게 합니다.

- **프로젝트 그리드** (`projectHub.projectTerminalGrid`, 기본 켜짐): 전환할 때마다 활성 프로젝트의 에이전트 터미널이 에디터 영역을 2열 그리드로 채웁니다(터미널마다 한 칸, 최대 6칸). 다른 프로젝트 터미널은 세션을 유지한 채 닫힌 패널로 돌아갑니다. 활성 프로젝트에 에이전트를 새로 열면 그리드를 다시 짭니다. 열려 있던 파일은 첫 칸의 뒤쪽 탭으로 남습니다.
- **⫽ 버튼**: 원할 때 배치합니다. *전체 프로젝트*는 프로젝트마다 한 칸, 그 프로젝트 터미널은 칸 안의 탭으로 합칩니다. *활성 프로젝트만*은 터미널마다 한 칸입니다. 프로젝트 그리드가 켜져 있으면 다음 전환이나 에이전트 추가 시 활성 프로젝트 그리드로 돌아갑니다.
- 프로젝트 그리드를 끈 경우: `projectHub.splitAgentTerminals`는 프로젝트의 다음 에이전트를 기존 터미널 옆에 분할해 열고, `projectHub.terminalsInEditor`는 에이전트 터미널을 에디터 탭으로 엽니다.
- VS Code는 터미널만 든 에디터 그룹을 자동으로 잠그므로(`workbench.editor.autoLockGroups`) 파일은 다른 그룹에 열립니다. Project Hub는 다시 배치하기 전에 잠금을 풀고 빈 그룹을 닫습니다.
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
| Project Hub: 서버에 SSH 키 설정 | 비밀번호 1회 입력으로 SSH 키 등록 (로컬 창) |
| Project Hub: 이 터미널을 프로젝트에 연결 | 직접 연 터미널 편입 |
| Project Hub: 완료 알림 설정 | 전역 hook 재설치 |
| Project Hub: 새로 고침 | 프로세스·사용량·트리 재조회 |

프로젝트 행 우클릭으로 이어서 열기, 세션 고르기, 에이전트 지정 실행, 지시 보내기, 식별 색상 지정, 리스트에서 제거를 쓸 수 있습니다.

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `projectHub.port` | `43917` | 알림 수신 로컬 HTTP 포트 (변경 시 hook 재설치 필요) |
| `projectHub.agents` | Claude/Gemini/Codex/Antigravity/OpenCode/Terminal | 에이전트 목록 |
| `projectHub.defaultAgent` | `claude` | 자동 시작·기본 터미널 버튼에 쓸 에이전트 |
| `projectHub.focusClaudeTerminalOnSwitch` | `true` | 전환 시 해당 프로젝트 터미널 표시 |
| `projectHub.switchOnRowClick` | `true` | 에이전트·사용량·서비스 행 클릭 시 먼저 그 프로젝트로 전환 |
| `projectHub.autoStartClaudeOnSwitch` | `true` | 터미널이 없으면 기본 에이전트 자동 시작 |
| `projectHub.autoInstallHooks` | `true` | 알림 hook 자동 설치 |
| `projectHub.restoreEditorsOnSwitch` | `true` | 프로젝트별 에디터 탭 저장·복원 |
| `projectHub.projectTerminalGrid` | `true` | 활성 프로젝트의 에이전트 터미널만 에디터 그리드로 표시 |
| `projectHub.resumeAgentsOnRestart` | `true` | VS Code 완전 재시작 후 복원된 터미널에서 에이전트 재실행 |
| `projectHub.splitAgentTerminals` | `true` | 프로젝트의 다음 에이전트를 기존 터미널 옆에 분할해 열기 (프로젝트 그리드를 끈 경우만) |
| `projectHub.terminalsInEditor` | `false` | 에이전트 터미널을 에디터 탭으로 열기 (프로젝트 그리드를 끈 경우만) |
| `projectHub.fileTreeExclude` | `.git`, `node_modules`, `.venv`, `__pycache__`, `dist`, `out`, `.next` | 파일 트리에서 숨길 이름 (glob 아님) |
| `projectHub.showAllProcesses` | `false` | MCP·헬퍼까지 프로세스 목록에 표시 |
| `projectHub.windowColor` | `false` | 타이틀 바를 프로젝트 색으로 물들이기 |
| `projectHub.notifyForActiveProject` | `true` | 활성 프로젝트도 알림 (창이 포커스를 잃었을 때) |
| `projectHub.notificationTimeout` | `10` | N초 뒤 토스트 자동 숨김 (0이면 유지) |

## 동작 원리

- **리로드 없는 전환**: `openFolder`로 폴더를 통째로 바꾸면 창이 리로드되고 터미널이 전부 죽습니다. 대신 허브 워크스페이스(`.code-workspace`) 안에서 `updateWorkspaceFolders`로 폴더만 교체하므로 Explorer는 바뀌고 세션은 살아남습니다.
- **앵커 폴더(`⌂ Hub`)**: 첫 워크스페이스 폴더가 바뀌면 모든 확장이 재시작되므로, 작은 고정 폴더가 그 자리를 영구히 차지하고 프로젝트는 두 번째 자리에서만 교체됩니다.
- **세션 격리**: 각 에이전트가 프로젝트를 작업 디렉터리로 하는 전용 터미널에서 실행됩니다. CLI들이 cwd로 세션을 구분하므로 프로젝트끼리 세션을 공유하지 않습니다.
- **알림**: hook은 사용자 전역 설정에 한 번만 설치됩니다 — Claude `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Gemini `~/.gemini/settings.json`, Antigravity `~/.gemini/antigravity-cli/hooks.json`. 이벤트마다 로컬 HTTP 서버로 POST하고, 페이로드의 작업 디렉터리로 프로젝트를 식별합니다. **저장소 안에는 아무것도 쓰지 않습니다.** Windows에서는 명령이 `curl.exe … -d '@-'`인데, Git Bash(Claude)와 PowerShell 양쪽에서 같은 의미로 동작합니다(Gemini는 hook을 `powershell -Command`로 실행하며, 거기서 그냥 `curl`은 `Invoke-WebRequest`의 별칭입니다).
- **데이터 위치**: 프로젝트 목록·브리핑 기록·저장된 재시작 명령은 `~/.project-hub/`에 있습니다. 토큰 사용량은 에이전트 CLI의 세션 파일에서 **읽기만** 합니다.

## 문제 해결

**알림이 오지 않습니다.**
**Project Hub: 완료 알림 설정**으로 hook을 다시 설치한 뒤, 실행 중이던 에이전트 세션을 재시작하세요. hook은 세션 시작 시점에 반영됩니다. `projectHub.port`를 바꿨다면 반드시 재설치해야 합니다.

**Windows에서 Gemini 알림이 전혀 오지 않습니다 (0.18.4 이전).**
Gemini는 hook을 PowerShell로 실행하는데, 예전 `curl … -d @-` 명령이 거기서 실패했습니다. 0.18.4부터 `curl.exe … -d '@-'`를 쓰며, Project Hub에서 에이전트를 다음에 열 때(또는 **완료 알림 설정** 실행 시) 옛 hook을 자동으로 다시 설치합니다. 이후 실행 중인 Gemini 세션을 재시작하세요.

**응답 대기·완료 행을 누르면 같은 세션이 터미널에 하나 더 열립니다 (0.18.4 이전).**
프로젝트로 전환하면서 그 상태가 먼저 지워져, 세션이 종료된 것으로 오판하고 `--resume`으로 다시 열었습니다. 이제 전환 전에 판단하고, 그 에이전트 터미널이 살아 있으면 그 터미널을 보여 줍니다. 이미 두 터미널이 한 대화를 쓰고 있다면 하나에서 `/exit`로 종료하세요.

**"포트가 이미 사용 중" 경고가 뜹니다.**
다른 창이나 프로그램이 포트를 쥐고 있습니다. 허브 워크스페이스 창이 우선 소유하고 창이 바뀌면 자동 인계되므로, 다른 VS Code 창을 닫으면 대개 해결됩니다. 다른 프로그램이 원인이면 `projectHub.port`를 바꾸고 hook을 재설치하세요.

**전환할 때마다 모든 확장이 재시작됩니다.**
`⌂ Hub` 앵커 폴더가 워크스페이스에서 제거된 상태입니다. 프로젝트를 한 번 전환하면 첫 자리에 다시 만들어집니다.

**dev 서버가 도는데 서비스 섹션이 비어 있습니다.**
서비스 탐지는 Windows 전용입니다. Windows에서도 명령줄과 조상 프로세스로 귀속을 판단하므로, 프로젝트 경로가 전혀 드러나지 않게 실행된 서버는 누락될 수 있습니다. 에이전트 터미널에서 띄운 것이라면 **백그라운드 프로세스**에는 나타납니다.

**프로젝트 하위 행을 클릭했는데 Explorer가 이전 프로젝트를 그대로 보여줍니다.**
에이전트·사용량·서비스 행을 클릭하면 기본적으로 그 프로젝트로 전환됩니다. 전환되지 않는다면 `projectHub.switchOnRowClick`이 꺼져 있는 것입니다. 이 설정은 Explorer를 그대로 둔 채 다른 프로젝트의 터미널만 확인하고 싶을 때를 위한 것입니다. 프로젝트 행 본체는 설정과 무관하게 항상 전환합니다.

**Python 프로젝트에서 에이전트가 저절로 종료되고, 터미널에 `Activate.ps1` / `deactivate` 줄이 보입니다.**
Python Environments 확장은 터미널에 명령을 입력하는 방식으로 가상환경을 켭니다. 프로젝트 전환으로 워크스페이스 폴더가 바뀌면, 이미 에이전트가 실행 중인 터미널에 `deactivate`와 activate 명령을 다시 입력하고, 에이전트는 그 입력을 받아 종료됩니다. 사용자 설정에서 터미널에 명령을 입력하지 않게 하세요.

```json
"python-envs.terminal.autoActivationType": "off"
```

`shellStartup`도 명령 입력을 피하지만 PowerShell 프로필을 수정합니다. 에이전트는 보통 프로젝트의 `.venv`를 스스로 찾아 씁니다.

**에이전트 명령의 첫 글자가 잘립니다 (`laude --continue`).**
0.15.4에서 고쳤습니다. 셸이 준비됐다고 알린 뒤(shell integration) 명령을 보내고, 그 기능이 없는 셸은 4초 뒤에 보냅니다.

**hook이 에이전트 작업을 막지는 않나요?**
막지 않습니다. `curl`에 3초 타임아웃이 걸려 있고, 서버가 꺼져 있으면 조용히 실패합니다.

## 알려진 제약

- 서비스·백그라운드 프로세스는 PowerShell이 필요해 Windows 전용입니다. 그 외 기능은 크로스 플랫폼입니다.
- Codex `resume --last`의 cwd 필터는 2026년 이후 CLI가 필요합니다.
- Antigravity hook 이벤트는 현재 공개 문서 기준입니다. 알림이 오지 않으면 제보해 주세요.
- 사용량 수치는 정가 기준 추정치이며 실제 청구 데이터가 아닙니다.

## 라이선스

MIT
