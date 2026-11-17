#!/usr/bin/env bash
# 用法：
#   bash example/eval-regex.sh                 # 操作当前目标标签
#   bash example/eval-regex.sh t123            # 操作指定标签
#   AUTOBROWSER_WORKSPACE=my-task bash example/eval-regex.sh t123
# 可用 AUTOBROWSER_BIN 覆盖 CLI 路径；复杂源码放在 <<'JS' 中，shell 不做二次转义。
set -euo pipefail

TAB="${1:-}"
CLI="${AUTOBROWSER_BIN:-autobrowser}"
ARGS=()
if [[ -n "$TAB" ]]; then
  ARGS=(--tab "$TAB")
fi

"$CLI" "${ARGS[@]}" eval --stdin <<'JS'
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
JS
