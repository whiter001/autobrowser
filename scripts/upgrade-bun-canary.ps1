#Requires -Version 5.1
<#
.SYNOPSIS
    把本机 bun 升级到 GitHub canary 滚动标签的最新构建（当前为 1.4.5-canary.x）。

.DESCRIPTION
    为什么不用 `bun upgrade --canary`：
    国内直连 GitHub release 资源会被限速到接近 0 字节（实测 25 秒下载 0 字节），
    官方升级命令会长时间挂起无输出。本脚本改成三段式：
        1. 用 GitHub release API 取元信息（资产 URL + 官方 sha256）
        2. 依次尝试镜像 CDN 下载，任一镜像拿到与官方 digest 一致的文件即成功
        3. 备份旧版本后原地替换，并回读 --version/--revision 做安装后校验

    校验依据刻意用 release API 的 asset.digest，而不是 SHASUMS256.txt：
    canary 是滚动标签，资产会被新构建覆盖，但同标签下的 SHASUMS256.txt 未必同步更新。
    实测遇到过 sums 仍指向上一个构建、资产已经是新构建的情况——按 sums 校验会误判下载失败。

    另注：npm/阿里镜像（npmmirror）的 bun canary 包落后 GitHub canary 一个构建，
    且包名版本号（如 1.4.4-canary.20261113.1）与二进制内部版本号不一致，
    想判断新旧只能看二进制 --revision 里的 commit，不要按包名判断。

.EXAMPLE
    pwsh -File scripts/upgrade-bun-canary.ps1
    pwsh -File scripts/upgrade-bun-canary.ps1 -Channel latest
    pwsh -File scripts/upgrade-bun-canary.ps1 -Force
#>
[CmdletBinding()]
param(
    # canary = GitHub 滚动标签的最新构建；latest = 最新稳定版
    [ValidateSet('canary', 'latest')]
    [string]$Channel = 'canary',

    # 已是目标 commit 时也强制重装（用于修复损坏的安装）
    [switch]$Force,

    # 老 CPU（无 AVX2）需要 baseline 构建
    [switch]$Baseline,

    # 镜像按顺序尝试，直连 GitHub 作为最后兜底
    [string[]]$Mirror = @(
        'https://ghfast.top',
        'https://gh-proxy.com',
        'https://ghproxy.net'
    ),

    # 单个下载源的超时秒数
    [int]$DownloadTimeoutSec = 900,

    # 覆盖默认安装目录（默认 Windows: %USERPROFILE%\.bun\bin，其他: ~/.bun/bin）
    [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest 在 PowerShell 7 下会打印大量进度噪声

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "    [OK] $Message" -ForegroundColor Green }
function Write-Info { param([string]$Message) Write-Host "    $Message" -ForegroundColor Gray }

# 依据当前 OS/架构推导官方发布资产名；baseline 变体插在 .zip 之前
function Get-PlatformAssetName {
    param([bool]$UseBaseline)

    if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
        $os = 'windows'
    }
    elseif ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)) {
        $os = 'darwin'
    }
    else {
        $os = 'linux'
    }

    $arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
        'X64' { 'x64' }
        'Arm64' { 'aarch64' }
        default { throw "不支持的架构: $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)" }
    }

    $suffix = if ($UseBaseline) { '-baseline' } else { '' }
    return "bun-$os-$arch$suffix.zip"
}

# 从 release body / name 里解析该构建对应的 commit，用于「是否已是最新」的判断
function Get-ReleaseCommit {
    param($Release)

    # 正文里的 commit 更准：滚动标签的 name 字段偶尔与正文不同步
    if ($Release.body -and $Release.body -match 'commit:\s*([0-9a-f]{7,40})') {
        return $Matches[1].ToLower()
    }
    if ($Release.name -match '\(([0-9a-f]{7,40})\)') {
        return $Matches[1].ToLower()
    }
    return $null
}

# 取官方 sha256：优先 release API 的 asset.digest，其次回退到 SHASUMS256.txt
function Get-ExpectedSha256 {
    param($Asset, $Release)

    if ($Asset.PSObject.Properties.Name -contains 'digest' -and $Asset.digest -match '^sha256:([0-9a-fA-F]{64})$') {
        return @{ Sha = $Matches[1].ToLower(); Source = 'release API asset.digest' }
    }

    # 老资产没有 digest 字段时才回退；注意 canary 标签下该文件可能滞后
    Write-Info "release API 未提供 digest，回退到 SHASUMS256.txt（可能滞后于资产）"
    $sumsUrl = "https://github.com/oven-sh/bun/releases/download/$($Release.tag_name)/SHASUMS256.txt"
    $tmp = New-TemporaryFile
    try {
        $urls = @($sumsUrl)
        foreach ($m in $Mirror) { $urls = @("$m/$sumsUrl") + $urls }
        foreach ($u in $urls) {
            try {
                Invoke-Download -Url $u -OutFile $tmp.FullName -TimeoutSec 60 | Out-Null
                # SHASUMS 每行是 "<sha256>  <文件名>"，文件名与哈希之间是两个空格
                $line = Get-Content $tmp.FullName | Where-Object { $_ -match "\s+$([regex]::Escape($Asset.name))$" } | Select-Object -First 1
                if ($line -and $line -match '^([0-9a-fA-F]{64})\s') {
                    return @{ Sha = $Matches[1].ToLower(); Source = 'SHASUMS256.txt' }
                }
            }
            catch { continue }
        }
    }
    finally {
        Remove-Item $tmp.FullName -Force -ErrorAction SilentlyContinue
    }
    throw "无法获取官方 sha256（asset.digest 与 SHASUMS256.txt 均不可用）"
}

# 用 curl 下载；--speed-limit/--speed-time 让「连上但不传数据」的挂起能被及时掐断并切下一个镜像
function Invoke-Download {
    param([string]$Url, [string]$OutFile, [int]$TimeoutSec)

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) { $curl = Get-Command curl -ErrorAction SilentlyContinue }

    if ($curl) {
        & $curl.Source -L --fail --silent --show-error `
            --retry 3 --retry-delay 3 --max-time $TimeoutSec `
            --speed-limit 10240 --speed-time 30 `
            -o $OutFile $Url
        if ($LASTEXITCODE -ne 0) { throw "curl 退出码 $LASTEXITCODE" }
        return
    }

    Invoke-WebRequest -Uri $Url -OutFile $OutFile -TimeoutSec $TimeoutSec
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLower()
}

# 读取已安装 bun 的 revision（形如 1.4.5-canary.1+9098897a1），取其中的 commit
function Get-InstalledCommit {
    param([string]$BunPath)

    if (-not (Test-Path $BunPath)) { return $null }
    try {
        $rev = (& $BunPath --revision 2>$null | Select-Object -First 1)
        if ($rev -and $rev -match '([0-9a-f]{7,40})$') { return $Matches[1].ToLower() }
    }
    catch { }
    return $null
}

# ---------------------------------------------------------------- 主流程

Write-Step "解析 $Channel 渠道的 release 元信息"

$apiUri = if ($Channel -eq 'canary') {
    'https://api.github.com/repos/oven-sh/bun/releases/tags/canary'
}
else {
    'https://api.github.com/repos/oven-sh/bun/releases/latest'
}

$headers = @{ 'User-Agent' = 'autobrowser-upgrade-bun'; 'Accept' = 'application/vnd.github+json' }
$release = Invoke-RestMethod -Uri $apiUri -Headers $headers -TimeoutSec 60

$assetName = Get-PlatformAssetName -UseBaseline $Baseline.IsPresent
$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if (-not $asset) {
    throw "release $($release.tag_name) 中没有资产 $assetName（该平台可能未发布）"
}

$releaseCommit = Get-ReleaseCommit -Release $release
Write-Ok "release : $($release.tag_name)"
Write-Info "资产    : $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)"
if ($releaseCommit) { Write-Info "commit  : $releaseCommit" }

if (-not $InstallDir) {
    $InstallDir = if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        Join-Path $env:USERPROFILE '.bun\bin'
    }
    else {
        Join-Path $env:HOME '.bun/bin'
    }
}
$bunExeName = if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) { 'bun.exe' } else { 'bun' }
$bunPath = Join-Path $InstallDir $bunExeName

$installedCommit = Get-InstalledCommit -BunPath $bunPath
if ($installedCommit) {
    Write-Info "本机已装 commit: $installedCommit"
}
else {
    Write-Info "本机未检测到可用的 bun 安装"
}

# 已是同一个 commit 就直接退出：canary 滚动标签每天可能多次重建，不必反复下载 80MB
if (-not $Force -and $installedCommit -and $releaseCommit) {
    if ($installedCommit -eq $releaseCommit -or $installedCommit.StartsWith($releaseCommit) -or $releaseCommit.StartsWith($installedCommit)) {
        Write-Ok "已经是最新构建（commit $installedCommit），无需升级。加 -Force 可强制重装。"
        exit 0
    }
}

Write-Step "获取官方 sha256 校验值"
$expected = Get-ExpectedSha256 -Asset $asset -Release $release
Write-Ok "expected sha256: $($expected.Sha)  (来源: $($expected.Source))"

Write-Step "下载（依次尝试镜像 CDN）"

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("bun-upgrade-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $workDir -Force | Out-Null
$zipPath = Join-Path $workDir $asset.name

try {
    # 直连放最后：能直连时它最权威，镜像只是为绕开限速而存在
    $urls = @()
    foreach ($m in $Mirror) { $urls += "$m/$($asset.browser_download_url)" }
    $urls += $asset.browser_download_url

    $downloaded = $false
    foreach ($u in $urls) {
        $host_ = ([uri]$u).Host
        Write-Info "尝试 $host_ ..."
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            Invoke-Download -Url $u -OutFile $zipPath -TimeoutSec $DownloadTimeoutSec
        }
        catch {
            Write-Warning "$host_ 下载失败: $($_.Exception.Message)"
            continue
        }
        $sw.Stop()
        $size = (Get-Item $zipPath).Length
        if ($size -ne $asset.size) {
            Write-Warning "$host_ 大小不符（$size != $($asset.size)），换下一个源"
            Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
            continue
        }
        $actual = Get-FileSha256 -Path $zipPath
        if ($actual -ne $expected.Sha) {
            # 镜像缓存旧构建时会出现这种情况，继续换源
            Write-Warning "$host_ sha256 不符（可能缓存了旧构建），换下一个源"
            Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
            continue
        }
        $kb = [math]::Round($size / 1KB / [math]::Max($sw.Elapsed.TotalSeconds, 0.001))
        Write-Ok "$host_ 下载并校验通过（$([math]::Round($size / 1MB, 1)) MB，$kb KB/s）"
        $downloaded = $true
        break
    }
    if (-not $downloaded) { throw "所有下载源均失败或校验不通过" }

    Write-Step "解压并安装"
    $extractDir = Join-Path $workDir 'extract'
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    if ($asset.name -like '*.zip') {
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    }
    else {
        throw "暂不支持非 zip 资产: $($asset.name)"
    }

    $newBin = Get-ChildItem $extractDir -Recurse -Filter $bunExeName -File | Select-Object -First 1
    if (-not $newBin) { throw "解压后未找到 $bunExeName" }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

    # 备份旧版本，方便回滚；备份名带版本号，同版本重复安装时覆盖，
    # 但跨版本会各留一份（每个约 100MB+），确认新版本稳定后可自行清理
    if (Test-Path $bunPath) {
        $oldVersion = try { (& $bunPath --version 2>$null | Select-Object -First 1) } catch { 'unknown' }
        if (-not $oldVersion) { $oldVersion = 'unknown' }
        $backup = Join-Path $InstallDir "bun-$oldVersion$(if ($bunExeName.EndsWith('.exe')) { '.exe' } else { '' }).bak"
        Copy-Item $bunPath $backup -Force
        Write-Ok "已备份旧版本 -> $(Split-Path $backup -Leaf)"
    }

    try {
        Copy-Item $newBin.FullName $bunPath -Force
    }
    catch {
        throw "替换 $bunPath 失败：$($_.Exception.Message)。请先关闭正在运行的 bun 进程（如 dev server / relay）再重试。"
    }

    # Windows 上 bunx.exe 是 bun.exe 的副本；其他平台 bunx 是指向 bun 的软链
    $bunxPath = Join-Path $InstallDir ($(if ($bunExeName.EndsWith('.exe')) { 'bunx.exe' } else { 'bunx' }))
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        Copy-Item $newBin.FullName $bunxPath -Force
    }
    else {
        if (Test-Path $bunxPath) { Remove-Item $bunxPath -Force }
        New-Item -ItemType SymbolicLink -Path $bunxPath -Target $bunPath | Out-Null
    }
    Write-Ok "已安装到 $bunPath"

    Write-Step "安装后校验"
    $newVersion = (& $bunPath --version | Select-Object -First 1)
    $newRevision = (& $bunPath --revision | Select-Object -First 1)
    Write-Ok "version : $newVersion"
    Write-Ok "revision: $newRevision"

    if ($releaseCommit) {
        $newCommit = Get-InstalledCommit -BunPath $bunPath
        if ($newCommit -and -not ($newCommit -eq $releaseCommit -or $newCommit.StartsWith($releaseCommit) -or $releaseCommit.StartsWith($newCommit))) {
            Write-Warning "commit 与目标不一致（期望 $releaseCommit，实际 $newCommit），可能命中了镜像缓存"
        }
        else {
            Write-Ok "commit 匹配目标构建 $releaseCommit"
        }
    }

    Write-Host ""
    Write-Host "升级完成：$newVersion ($newRevision)" -ForegroundColor Green
}
finally {
    Remove-Item $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
