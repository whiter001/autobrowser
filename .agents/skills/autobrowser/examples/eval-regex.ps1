# 用法：
#   pwsh -NoProfile -File example/eval-regex.ps1                 # 操作当前目标标签
#   pwsh -NoProfile -File example/eval-regex.ps1 -Tab t123       # 操作指定标签
#   $env:AUTOBROWSER_WORKSPACE='my-task'; pwsh -File example/eval-regex.ps1 -Tab t123
# Windows PowerShell 5.1 可将 pwsh 换成 powershell；脚本会设置 UTF-8 输出编码。
# 复杂源码放在单引号 here-string 中，PowerShell 不做变量展开或二次转义。
param([string]$Tab)

$OutputEncoding = [System.Text.UTF8Encoding]::new()
$Cli = if ($env:OS -eq 'Windows_NT') { 'autobrowser.exe' } else { 'autobrowser' }
$CliArgs = @()
if ($Tab) { $CliArgs += @('--tab', $Tab) }

@'
const lines = document.body.innerText.split('\n')
const patterns = {
  quotes: /Order\s+#([A-Z])-(\d{3})\s+quote\s+"double"\s+'single'/i,
  windowsPath: /C:\\temp\\new-file\.json/i,
  api: /\/api\/v\d+\/items\?id=\d+/,
  price: /(?=.*\bUSD\b)(?=.*\d+\.\d{2}).*/,
  unicode: /反脆弱/u,
}

return Object.fromEntries(
  Object.entries(patterns).map(([name, pattern]) => [
    name,
    lines.filter((line) => pattern.test(line)),
  ]),
)
'@ | & $Cli @CliArgs eval --stdin
