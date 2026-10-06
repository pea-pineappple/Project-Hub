<#
.SYNOPSIS
  PC 이전 시 프로젝트 경로가 바뀐 경우 Claude 세션·설정의 경로를 일괄 변환한다.

.DESCRIPTION
  새 PC에서 ~\.claude, ~\.claude.json, ~\.project-hub 를 복사해 넣은 "다음"에 실행.
  하는 일:
    1. ~\.claude\projects\ 의 세션 폴더 이름을 새 경로 인코딩으로 변경
       (인코딩 규칙: 절대 경로의 영숫자 외 문자 -> '-')
    2. ~\.claude.json 안의 옛 경로 문자열을 새 경로로 치환 (프로젝트 신뢰/권한/히스토리 유지)
    3. ~\.project-hub\projects.json, briefing.json 경로 치환
    4. ~\.project-hub\services.json 키 치환 (소문자 정규화 유지)
    5. Antigravity 워크스페이스 캐시가 있으면 치환
  수정 전 각 파일은 <이름>.bak-migration 으로 백업된다.

.EXAMPLE
  .\migrate-claude-paths.ps1 -OldRoot "C:\Project\project" -NewRoot "D:\dev\project"
  .\migrate-claude-paths.ps1 -OldRoot "C:\Project\project" -NewRoot "D:\dev\project" -DryRun
#>
param(
    [Parameter(Mandatory = $true)][string]$OldRoot,
    [Parameter(Mandatory = $true)][string]$NewRoot,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Encode-Path([string]$p) {
    return ($p -replace '[^a-zA-Z0-9]', '-')
}

$oldEnc = Encode-Path $OldRoot
$newEnc = Encode-Path $NewRoot
Write-Host "경로 변환: $OldRoot -> $NewRoot"
Write-Host "인코딩:   $oldEnc -> $newEnc"
if ($DryRun) { Write-Host "[DRY RUN] 실제 변경 없음" -ForegroundColor Yellow }
Write-Host ""

# ── 1. 세션 폴더 이름 변경 ─────────────────────────────────────
$projectsDir = Join-Path $env:USERPROFILE ".claude\projects"
if (Test-Path $projectsDir) {
    $renamed = 0
    foreach ($dir in Get-ChildItem $projectsDir -Directory) {
        if ($dir.Name.ToLower().StartsWith($oldEnc.ToLower())) {
            $newName = $newEnc + $dir.Name.Substring($oldEnc.Length)
            if ($newName -eq $dir.Name) { continue }
            $target = Join-Path $projectsDir $newName
            if (Test-Path $target) {
                # 같은 프로젝트의 대소문자 변형(C--/c--)이 이미 변환된 경우 → 내용 병합
                Write-Host "세션 폴더 병합: $($dir.Name) -> $newName"
                if (-not $DryRun) {
                    foreach ($item in Get-ChildItem $dir.FullName -Force) {
                        $dst = Join-Path $target $item.Name
                        if (-not (Test-Path $dst)) { Move-Item $item.FullName $dst }
                    }
                    if (-not (Get-ChildItem $dir.FullName -Force)) { Remove-Item $dir.FullName }
                }
                $renamed++
                continue
            }
            Write-Host "세션 폴더: $($dir.Name) -> $newName"
            if (-not $DryRun) { Rename-Item $dir.FullName $newName }
            $renamed++
        }
    }
    Write-Host "세션 폴더 $renamed 개 변경`n"
} else {
    Write-Warning "$projectsDir 없음 — .claude 복사가 먼저인지 확인하세요"
}

# ── 2~3. 텍스트 치환 (JSON 이스케이프/일반/슬래시 변형 모두, 대소문자 무시) ──
function Replace-InFile([string]$file) {
    if (-not (Test-Path $file)) { return }
    $raw = Get-Content $file -Raw
    $variants = @(
        @{ old = $OldRoot.Replace('\', '\\'); new = $NewRoot.Replace('\', '\\') },  # JSON 이스케이프
        @{ old = $OldRoot.Replace('\', '/');  new = $NewRoot.Replace('\', '/') },   # 슬래시 표기
        @{ old = $OldRoot;                    new = $NewRoot }                       # 일반
    )
    $updated = $raw
    foreach ($v in $variants) {
        $updated = [regex]::Replace($updated, [regex]::Escape($v.old), { param($m) $v.new },
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
    if ($updated -ne $raw) {
        $count = ([regex]::Matches($raw, [regex]::Escape($OldRoot.Replace('\', '\\')),
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)).Count
        Write-Host "치환: $file"
        if (-not $DryRun) {
            Copy-Item $file "$file.bak-migration" -Force
            Set-Content $file $updated -NoNewline -Encoding utf8
        }
    }
}

Replace-InFile (Join-Path $env:USERPROFILE ".claude.json")
Replace-InFile (Join-Path $env:USERPROFILE ".project-hub\projects.json")
Replace-InFile (Join-Path $env:USERPROFILE ".project-hub\briefing.json")
Replace-InFile (Join-Path $env:USERPROFILE ".gemini\antigravity-cli\cache\last_conversations.json")

# ── 4. services.json — 키가 소문자 정규화 경로라 별도 처리 ─────────
$servicesFile = Join-Path $env:USERPROFILE ".project-hub\services.json"
if (Test-Path $servicesFile) {
    $data = Get-Content $servicesFile -Raw | ConvertFrom-Json
    $oldLower = $OldRoot.ToLower().TrimEnd('\')
    $newLower = $NewRoot.ToLower().TrimEnd('\')
    $rebuilt = [ordered]@{}
    $changed = $false
    foreach ($prop in $data.PSObject.Properties) {
        $key = $prop.Name
        if ($key.ToLower().StartsWith($oldLower)) {
            $key = $newLower + $key.Substring($oldLower.Length)
            $changed = $true
        }
        $rebuilt[$key] = $prop.Value
    }
    if ($changed) {
        Write-Host "치환: $servicesFile (키 소문자 정규화 유지)"
        if (-not $DryRun) {
            Copy-Item $servicesFile "$servicesFile.bak-migration" -Force
            ($rebuilt | ConvertTo-Json -Depth 5) + "`n" | Set-Content $servicesFile -NoNewline -Encoding utf8
        }
    }
}

Write-Host ""
Write-Host "완료. 확인 방법:" -ForegroundColor Green
Write-Host "  1) 새 경로의 프로젝트 폴더에서 'claude --continue' -> 마지막 대화가 이어지는지"
Write-Host "  2) VS Code Project Hub 리스트에 프로젝트가 보이고 클릭 전환이 되는지"
Write-Host "참고: Codex 세션의 cwd 필터(resume --last)는 옛 경로 기준이라 이전되지 않을 수 있습니다."
