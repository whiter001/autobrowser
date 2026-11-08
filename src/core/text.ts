/**
 * 文本输入的公共清理。
 */

/**
 * 去掉文本开头的 UTF-8 BOM（U+FEFF）。
 *
 * Windows PowerShell 5 的 `>` 重定向、Set-Content、Out-File 默认写 UTF-8 with BOM，
 * 而 JSON.parse 不接受 U+FEFF，会报 Unrecognized token——报错信息里这个字符本身不可见，
 * 用户很难判断是编码问题还是自己的 JSON 写错了。
 * 命令体、脚本源码、配置文件都可能经过这条路径，所以在读取入口统一剥一次。
 */
export function stripBom(text: string): string {
  // 用转义写法而不是字面 BOM 字符：字面量在源码里是不可见空白，容易被 lint 误判
  return text.replace(/^\uFEFF+/, '')
}
