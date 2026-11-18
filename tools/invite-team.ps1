# 批量把 6 人团队拉进仓库（管理员用）——给出 Write 权限，让他们能推分支
#
# 用法：
#   1. 把下面 $Users 换成 5 位队友的真实 GitHub 用户名
#   2. 在仓库根目录执行：powershell -ExecutionPolicy Bypass -File tools\invite-team.ps1
#
# 依赖本机 Git 凭据管理器里已登录的 GitHub 账号（git push 能成功就说明没问题）。

param(
  [string]$Owner = "joe9997",
  [string]$Repo  = "KNOWLEDGE-SPACE",
  [string[]]$Users = @(
    # "teammate-1",
    # "teammate-2",
    # "teammate-3",
    # "teammate-4",
    # "teammate-5"
  )
)

$ErrorActionPreference = "Stop"

# --- 找 git-credential-manager ---
$cmd = Get-Command git-credential-manager -ErrorAction SilentlyContinue
$gcm = if ($cmd) { $cmd.Source } else { $null }
if (-not $gcm) {
  $candidates = @(
    "C:\Program Files\Git\ucrt64\bin\git-credential-manager.exe",
    "C:\Program Files\Git\mingw64\bin\git-credential-manager.exe",
    "$env:LOCALAPPDATA\Programs\Git\ucrt64\bin\git-credential-manager.exe"
  )
  $gcm = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $gcm) { throw "找不到 git-credential-manager，请先安装 Git for Windows 并 push 成功过一次" }

# --- 取 token ---
$out = "protocol=https`nhost=github.com`n`n" | & $gcm get 2>$null
$token = ($out | Where-Object { $_ -like "password=*" }) -replace "^password=", ""
if (-not $token) { throw "取不到 GitHub 凭据，请先随便 push 一次让凭据管理器登录" }

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = "application/vnd.github+json"
  "User-Agent"           = "knowledge-space-admin"
  "X-GitHub-Api-Version" = "2022-11-28"
}

if (-not $Users -or $Users.Count -eq 0) {
  Write-Host "== 还没有填写用户名 ==" -ForegroundColor Yellow
  Write-Host "打开本文件，把 `$Users 里的注释去掉，填上 5 位队友的 GitHub 用户名后重跑。"
  Write-Host "`n当前协作者："
  $cols = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/collaborators" -Headers $headers
  $cols | ForEach-Object { Write-Host ("  - {0}" -f $_.login) }
  return
}

Write-Host "邀请 $($Users.Count) 人进入 $Owner/$Repo（Write 权限）`n"

foreach ($u in $Users) {
  try {
    $res = Invoke-RestMethod -Method Put `
      -Uri "https://api.github.com/repos/$Owner/$Repo/collaborators/$u" `
      -Headers $headers -ContentType "application/json" `
      -Body '{"permission":"push"}' -TimeoutSec 30
    Write-Host ("  [已发送邀请] {0}  （对方需在 GitHub 通知里点 Accept）" -f $u) -ForegroundColor Green
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    switch ($code) {
      404 { Write-Host ("  [失败] {0} —— 用户名不存在" -f $u) -ForegroundColor Red }
      403 { Write-Host ("  [失败] {0} —— 无权限（你可能不是管理员，或已达协作者上限）" -f $u) -ForegroundColor Red }
      422 { Write-Host ("  [跳过] {0} —— 已经是协作者" -f $u) -ForegroundColor Yellow }
      default { Write-Host ("  [失败] {0} —— HTTP {1}" -f $u, $code) -ForegroundColor Red }
    }
  }
}

Write-Host "`n当前协作者："
$cols = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/collaborators" -Headers $headers
$cols | ForEach-Object { Write-Host ("  - {0}" -f $_.login) }
