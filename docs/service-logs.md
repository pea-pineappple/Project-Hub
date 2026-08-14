# 서비스 로그 보기 — 설계 검토

> 상태: **검토 완료, 구현 보류.** 방향 결정 후 착수.
> 작성: 2026-08-12 (v0.12.0 기준)

## 질문

서비스 뷰에서 백그라운드 서비스를 중지·재시작할 수 있는데, **그 프로세스의 로그도 볼 수 있는가?**

## 결론 요약

**이미 떠 있는 프로세스의 지난 출력은 되살릴 수 없다.** OS 차원의 제약이다.
로그를 보려면 **우리가 띄운 서비스**여야 하고, 기존 서비스는 한 번 재시작해야 로그가 생긴다.

다만 실용적인 길이 셋 있고, 그중 A는 비용이 작으면서 지금 있는 버그도 같이 잡는다.

## 근본 제약

프로세스의 stdout/stderr는 실행 시점에 특정 파이프·콘솔에 연결되고, **그 반대편을 쥔 쪽만** 읽을 수 있다. 나중에 끼어들 수 없다.

- Windows `AttachConsole` + `ReadConsoleOutput`으로 남의 콘솔 화면 버퍼를 읽는 방법이 이론상 있으나 —
  네이티브 P/Invoke 필요(이 프로젝트는 네이티브 의존성 0), 프로세스당 콘솔 1개 제약,
  VS Code pty로 실행된 프로세스엔 애초에 해당 없음. **현실성 없음.**
- **VS Code에 터미널 스크롤백을 읽는 API가 없다.** `Terminal`에 버퍼 접근 수단이 없다.
  (`selectAll` → `copySelection`으로 클립보드를 경유하는 편법은 클립보드를 덮어쓰고 포커스가 필요해 제품에 못 넣는다.)

여기에 이 확장 특유의 사정이 겹친다. `getListeningServicesByProject`(`src/processTree.ts:203`)는
**시스템 전체**의 리슨 프로세스를 스캔해 명령줄·조상 경로로 프로젝트에 귀속시킨다.
즉 다른 VS Code 창이나 `Start-Process`로 분리 실행된 서비스도 목록에 잡히는데,
그런 건 우리가 출력을 가져본 적조차 없다.

## 먼저 고칠 것 — `revealServiceTerminal`이 엉뚱한 터미널을 연다

서비스 행 클릭은 `terminals.findForProject(project)`를 호출한다. 이 함수의 우선순위는
(`src/terminalManager.ts:204`):

1. 기본 에이전트의 관리 터미널
2. 다른 에이전트의 관리 터미널
3. shellIntegration cwd가 프로젝트 안인 터미널
4. 생성 시 cwd가 프로젝트 안인 터미널

**프로젝트에 Claude 터미널이 있으면 1번에서 걸려서, `restartService`가 만들어 둔
`service · {프로젝트} · :{포트}` 터미널(`src/extension.ts:1259` 부근)에 도달하지 못한다.**
로그 기능과 무관하게 지금 손볼 가치가 있다.

## 방향

### A. 그 서비스가 실제로 돌고 있는 터미널로 정확히 보내기

PID 조상 체인을 타고 올라가 어느 터미널 셸이 조상인지 찾아 **그 터미널**을 연다.
재료는 이미 있다 — `TerminalManager.getManagedPids()`가 셸 PID를, `processTree`가 부모 맵을 준다.
여기에 `service · … · :{포트}` 이름 매칭을 먼저 시도하면 재시작한 서비스는 확실히 잡힌다.

- **얻는 것**: 스크롤백이 터미널에 그대로 있으니 사실상 "로그 보기"가 된다
- **한계**: 이 창의 터미널에서 띄운 서비스만. 분리 실행·다른 창은 불가
- **비용**: 작음. 새 의존성·새 UI 없음

### B. 재시작할 때부터 우리가 출력을 잡기

`restartService`는 이미 명령을 물어보고 `~/.project-hub/services.json`에 저장한다
(`src/serviceCommands.ts`). 실행 방식만 바꾸면 진짜 로그 기능이 된다.

| | 방식 | 얻는 것 | 잃는 것 |
|---|---|---|---|
| **B-1** | `child_process.spawn` + `LogOutputChannel` (+ 파일 저장) | 가장 단순. 검색·필터 되는 로그 뷰, 재시작해도 로그 보존 | 터미널이 없어짐. Ctrl+C·`r`·프롬프트 응답 등 **상호작용 불가**, 컬러 출력 깨짐 |
| **B-2** | 터미널 유지 + `2>&1 \| Tee-Object <파일>` | 터미널 그대로 + 파일 로그. 구현 최소 | 사용자 명령을 문자열로 감쌈 → 셸마다 문법 다름(PowerShell/cmd/bash), 따옴표 문제로 오래 고생할 가능성 높음. 진행바·컬러 뭉개짐 |
| **B-3** | `vscode.Pseudoterminal` + `spawn` | 터미널 UX 유지 + **모든 바이트를 우리가 소유** → 완전한 로그. 키 입력은 자식 stdin으로 전달 | 자식이 진짜 TTY가 아니라 파이프에 물림 → 많은 도구가 컬러를 끄고 TUI가 오작동. 진짜 TTY를 주려면 `node-pty`(네이티브 의존성) 필요 |

> **오해 주의**: "VS Code 닫으면 서비스가 죽는다"는 B-1의 단점이 아니다.
> 지금도 VS Code 터미널에서 돌리므로 똑같이 죽는다. 실질적 차이는 **상호작용성**이다.

### C. 서비스가 스스로 남기는 로그 파일 찾아주기

`logs/`, `*.log`, uvicorn `--log-file`, pm2 등을 탐색하고,
명령줄에 리다이렉션(`> foo.log`)이 있으면 `BgProcess.launchCommand`(`src/processTree.ts:15`)에서 파싱.

- **얻는 것**: 우리가 안 띄운 서비스에도 통할 수 있는 **유일한** 방법
- **한계**: 순수 휴리스틱. 없으면 없는 것

## 권장

**A + B-3.**

- A는 비용 대비 효과가 가장 좋고 위 papercut도 같이 해결된다. 실제로 "로그 보고 싶다" 상황의
  대부분이 A로 해결될 것으로 본다.
- B는 로그 기능을 정말 원한다면 B-3이 유일하게 "터미널도 되고 로그도 되는" 답이다.
  단 TTY가 아니라서 Vite·Next 같은 도구의 컬러·단축키가 죽을 수 있으므로,
  **기존 터미널 실행을 기본으로 두고 "로그 캡처하며 시작"을 별도 액션으로 분리**하는 게 안전하다.
- B-2는 구현이 제일 싸지만 남의 명령을 문자열로 감싸는 방식이라 권하지 않는다.

## UI 고려사항

로그가 없는 서비스 행에 "로그 보기"가 떠 있으면 눌렀을 때 아무것도 없어서 더 나쁘다.
`contextValue`를 `serviceRow` / `serviceRowWithLog`로 나눠 **우리가 로그를 가진 서비스에만**
메뉴가 뜨게 해야 한다 (`src/servicesTree.ts:68`).

## 착수 시 결정할 것

1. A만 할지, B까지 갈지
2. B로 간다면 B-1(단순·비상호작용) vs B-3(터미널 유지·TTY 아님)
3. 로그 파일 보존 위치·보존 기간 (`~/.project-hub/logs/<project>-<port>.log`, 롤링 여부)
4. C(로그 파일 탐색)를 옵션으로 넣을지

## 관련 코드

| 위치 | 역할 |
|---|---|
| `src/processTree.ts:203` `getListeningServicesByProject` | 리슨 프로세스 → 프로젝트 귀속 |
| `src/processTree.ts:15` `BgProcess.launchCommand` | 조상 체인에서 추정한 실행 명령 |
| `src/servicesTree.ts` | 서비스 뷰 트리 |
| `src/extension.ts` `projectHub.revealServiceTerminal` | 서비스 행 클릭 |
| `src/extension.ts` `projectHub.restartService` | 명령 입력 → kill → 새 터미널에서 재실행 |
| `src/serviceCommands.ts` | 포트별 재시작 명령 저장 |
