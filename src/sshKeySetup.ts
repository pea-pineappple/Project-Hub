import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';

/**
 * SSH 키 인증 설정.
 *
 * Remote-SSH는 비밀번호 인증이면 연결 한 번에 비밀번호를 여러 번 묻고(서버 확인·설치·실제 연결),
 * 창을 새로 열거나 다시 연결할 때마다 반복된다. 다른 장비의 프로젝트를 열면 창이 새로 뜨므로 더 잦다.
 * 키를 한 번 등록하면 이후 비밀번호를 묻지 않으므로, 비밀번호 1회 입력으로 등록까지 자동화한다.
 *
 * 로컬 창에서만 동작한다 — 원격 창의 확장은 서버에서 실행되므로 그 ssh는 서버에서 나간다.
 */

const NO_ASK_KEY = 'projectHub.sshKeyNoAsk';
const KEY_PATH = path.join(os.homedir(), '.ssh', 'id_ed25519');

let memento: vscode.Memento | undefined;

export function initSshKeySetup(context: vscode.ExtensionContext): void {
    memento = context.globalState;
}

/** 비밀번호 없이(키로) 접속되는지. BatchMode는 비밀번호를 묻지 않고 바로 실패한다 */
export function hasKeyAuth(target: string): Promise<boolean> {
    return new Promise(resolve => {
        execFile(
            'ssh',
            // 처음 보는 서버는 여기서 실패한다 — 지문 확인은 키 설정 터미널에서 사용자가 직접 한다
            ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', target, 'exit'],
            { timeout: 10000, windowsHide: true },
            err => resolve(!err)
        );
    });
}

/** ~/.ssh/config의 Host 항목들 (와일드카드 제외) — 대상 선택 목록용 */
function configHosts(): string[] {
    try {
        const text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
        return [
            ...new Set(
                text
                    .split(/\r?\n/)
                    .map(l => /^\s*Host\s+(.+)$/i.exec(l)?.[1] ?? '')
                    .flatMap(h => h.split(/\s+/))
                    .filter(h => h && !/[*?!]/.test(h))
            )
        ];
    } catch {
        return [];
    }
}

/** 이 PC에 키가 없으면 비밀번호 없는 ed25519 키를 만든다. 공개키 한 줄을 돌려준다 */
function ensureLocalKey(): string {
    if (!fs.existsSync(`${KEY_PATH}.pub`)) {
        fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
        execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-C', `${os.userInfo().username}@${os.hostname()}`, '-f', KEY_PATH], {
            windowsHide: true
        });
    }
    return fs.readFileSync(`${KEY_PATH}.pub`, 'utf8').trim();
}

/**
 * 대상 서버에 공개키를 등록한다. 비밀번호 입력이 필요하므로 터미널에서 ssh를 직접 실행한다
 * (셸을 거치지 않아 PowerShell/bash 문법 차이가 없다). 원격 명령은 같은 키를 두 번 넣지 않는다.
 */
export async function setupSshKey(target?: string): Promise<boolean> {
    if (vscode.env.remoteName) {
        vscode.window.showInformationMessage(
            vscode.l10n.t('Run this from a local (non-remote) window — SSH keys are set up from your PC to the server.')
        );
        return false;
    }
    if (!target) {
        const manual = vscode.l10n.t('Enter user@host…');
        const pick = await vscode.window.showQuickPick([...configHosts(), manual], {
            placeHolder: vscode.l10n.t('Server to set up an SSH key for (from ~/.ssh/config)')
        });
        if (!pick) {
            return false;
        }
        target =
            pick === manual
                ? await vscode.window.showInputBox({ prompt: vscode.l10n.t('Server to connect to'), placeHolder: 'user@10.0.0.5' })
                : pick;
        if (!target) {
            return false;
        }
    }

    let pubKey: string;
    try {
        pubKey = ensureLocalKey();
    } catch (e) {
        vscode.window.showErrorMessage(vscode.l10n.t('Could not create an SSH key: {0}', String(e)));
        return false;
    }

    const remoteCmd =
        `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && ` +
        `(grep -qxF '${pubKey}' ~/.ssh/authorized_keys || echo '${pubKey}' >> ~/.ssh/authorized_keys) && ` +
        `echo PROJECT_HUB_KEY_OK`;
    const terminal = vscode.window.createTerminal({
        name: `SSH key · ${target}`,
        shellPath: 'ssh',
        shellArgs: [target, remoteCmd],
        iconPath: new vscode.ThemeIcon('key'),
        message: vscode.l10n.t('Enter the server password once. Your public key ({0}) will be added to ~/.ssh/authorized_keys on {1}.', `${KEY_PATH}.pub`, target)
    });
    terminal.show(false);

    // 터미널이 끝날 때까지 기다린 뒤(비밀번호 입력 포함) 실제로 키 인증이 되는지 확인
    await new Promise<void>(resolve => {
        const sub = vscode.window.onDidCloseTerminal(t => {
            if (t === terminal) {
                sub.dispose();
                resolve();
            }
        });
    });
    const ok = await hasKeyAuth(target);
    if (ok) {
        vscode.window.showInformationMessage(vscode.l10n.t('SSH key is set up for {0}. Remote-SSH will no longer ask for a password.', target));
    } else {
        vscode.window.showWarningMessage(
            vscode.l10n.t('Key login to {0} still fails. The server may not allow public-key login — check PubkeyAuthentication in /etc/ssh/sshd_config.', target)
        );
    }
    return ok;
}

/**
 * 다른 SSH 서버의 창을 열기 전에: 키 인증이 안 되면 비밀번호를 여러 번 묻게 된다고 알리고 설정을 권한다.
 * 계속 진행해도 되면 true.
 */
export async function offerKeySetupBeforeOpen(target: string): Promise<boolean> {
    if (vscode.env.remoteName || memento?.get<string[]>(NO_ASK_KEY, [])?.includes(target)) {
        return true;
    }
    if (await hasKeyAuth(target)) {
        return true;
    }
    const setup = vscode.l10n.t('Set Up SSH Key');
    const open = vscode.l10n.t('Open Anyway');
    const never = vscode.l10n.t("Don't Ask for This Server");
    const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t(
            '{0} has no SSH key login, so Remote-SSH will ask for the password several times on every connection. Set up a key now? (password once)',
            target
        ),
        setup,
        open,
        never
    );
    if (pick === setup) {
        await setupSshKey(target);
        return true;
    }
    if (pick === never) {
        await memento?.update(NO_ASK_KEY, [...(memento.get<string[]>(NO_ASK_KEY, []) ?? []), target]);
        return true;
    }
    return pick === open;
}
