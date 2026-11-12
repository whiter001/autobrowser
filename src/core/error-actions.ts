/**
 * 错误码 → 下一步动作的唯一事实来源。
 *
 * 各域原本各自设 suggestedAction，漏设时 agent 只看到一句报错，只能靠猜或换方案；
 * 这里给每个已知错误码一份默认动作，relay 转发扩展错误时兜底补全，
 * 各域自己写的更具体建议仍优先。
 */
export interface ErrorAction {
  /** true 表示"等一会/检查后再试"通常有意义；false 表示重试同一命令只会得到同样结果 */
  retryable: boolean
  action: string
}

const GENERIC_ACTION: ErrorAction = {
  retryable: false,
  action:
    "Inspect 'status', 'command list' and the current page state before retrying, and keep using autobrowser rather than switching to another automation framework.",
}

export const ERROR_ACTIONS: Record<string, ErrorAction> = {
  AMBIGUOUS_TARGET: {
    retryable: false,
    action:
      'Narrow the locator or pass an explicit position (first|last|nth=N); re-running the same command hits the same ambiguity.',
  },
  BATCH_STEP_FAILED: {
    retryable: false,
    action:
      'Inspect the failed step in the response; the batch stopped there unless continueOnError was set.',
  },
  BROWSER_CAPABILITY_UNSUPPORTED: {
    retryable: false,
    action:
      'Use a Chromium target or a command the current engine supports; capability rejection is not transient.',
  },
  CLI_ERROR: {
    retryable: false,
    action:
      "Inspect 'status' and the current page state before retrying; keep using autobrowser rather than switching to another automation framework.",
  },
  CLI_INVALID_ARGUMENT: {
    retryable: false,
    action:
      "Run 'autobrowser help' to see the supported commands and global flags, then run the command again with a corrected value.",
  },
  CLI_UNKNOWN_COMMAND: {
    retryable: false,
    action:
      "Run 'autobrowser help' to list the available commands, then retry with an exact command name.",
  },
  CDP_COMMAND_FAILED: {
    retryable: false,
    action:
      'Inspect the Playwright script and current page state; fix the failing browser operation before retrying.',
  },
  COLLECT_TASK_FAILED: {
    retryable: true,
    action:
      "Use the checkpoint in the response with 'collect resume <checkpoint.json>' instead of restarting from the first page.",
  },
  COMMAND_CANCELLED: {
    retryable: false,
    action:
      "Run 'command list' to see what is still queued; the cancelled command may have partially run.",
  },
  COMMAND_EXECUTION_UNKNOWN: {
    retryable: false,
    action:
      "Reconnect, then inspect 'status', 'command list' and the page before retrying; never replay side-effecting commands blindly.",
  },
  COMMAND_TIMEOUT: {
    retryable: true,
    action:
      "Run 'status' then 'command list'; the browser operation may still be finishing. Verify the page before retrying.",
  },
  EVALUATION_TIMEOUT: {
    retryable: false,
    action:
      "Pass '--timeout-ms' only for a script known to be long-running; otherwise simplify the script.",
  },
  ELEMENT_NOT_FOUND: {
    retryable: true,
    action:
      "Check the selector and selected frame, or use 'wait <selector> --timeout-ms <ms>' if the element has not rendered yet.",
  },
  EVAL_RESULT_TOO_LARGE: {
    retryable: false,
    action: "Set '--max-result-bytes', or narrow the script so it returns less data.",
  },
  EXTENSION_DISCONNECTED: {
    retryable: true,
    action:
      "Wait for the extension to reconnect ('status'), then confirm the target with 'tab list' before retrying.",
  },
  FILE_UPLOAD_ERROR: {
    retryable: false,
    action: 'Check the file path, size limits and that the target input accepts uploads.',
  },
  INVALID_ACTION: {
    retryable: false,
    action: "See 'autobrowser help <command>' for supported actions.",
  },
  INVALID_COMMAND_ARGS: {
    retryable: false,
    action: "See 'autobrowser help <command>' for supported options and value ranges.",
  },
  INVALID_CURSOR: {
    retryable: false,
    action:
      'Restart the list query without cursor or with the original filters, then use its nextCursor.',
  },
  INVALID_DEVICE_PRESET: {
    retryable: false,
    action: "Use a documented device preset, or 'set device --reset' to clear overrides.",
  },
  MODAL_OPEN: {
    retryable: false,
    action: "Handle the dialog first: 'dialog status', 'dialog accept' or 'dialog dismiss'.",
  },
  NETWORK_DATA_NOT_FOUND: {
    retryable: false,
    action: 'Check the request chain with network requests first; do not fabricate DOM results.',
  },
  NOT_FOUND: {
    retryable: false,
    action: "Refresh 'snapshot' or 'tab list' to confirm what currently exists.",
  },
  PAGE_SCRIPT_ACTIVE: {
    retryable: true,
    action:
      'Wait for the Playwright script to finish, or target a different tab with --tab before retrying.',
  },
  PAGE_EVALUATION_EXCEPTION: {
    retryable: false,
    action:
      "Inspect the script with 'console' / 'errors' and the page state; fix the script instead of switching frameworks.",
  },
  RESPONSE_TOO_LARGE: {
    retryable: false,
    action:
      'Reduce the result size (limit, page size, or narrower output) instead of retrying unchanged.',
  },
  SESSION_DATA_LOCKED: {
    retryable: true,
    action: 'Close the browser using that profile, then retry; do not force-delete the directory.',
  },
  STALE_CURSOR: {
    retryable: false,
    action:
      'Restart the list query without cursor; the previous continuation point no longer exists.',
  },
  STALE_ELEMENT_REF: {
    retryable: false,
    action: "Run 'snapshot' again; the page moved to a new epoch.",
  },
  STALE_REQUEST_REF: {
    retryable: false,
    action: 'Run network requests again and use a ref from the current result.',
  },
  STALE_FEED_STATE: {
    retryable: false,
    action:
      'The page navigated during collection: re-run it on the current page and do not merge old cards.',
  },
  STALE_FRAME_REF: {
    retryable: false,
    action: "Run 'snapshot' again; the frame list changed with the page epoch.",
  },
  STALE_MEDIA_STATE: {
    retryable: false,
    action: "Re-run 'media list' on the current page and use the returned index/epoch.",
  },
  STALE_REFERENCE: { retryable: false, action: "Run 'snapshot' to get fresh references." },
  STALE_TAB_HANDLE: {
    retryable: false,
    action: "Run 'tab list' to see live handles; a closed tab cannot be recovered.",
  },
  TAB_BUSY: {
    retryable: true,
    action:
      "Choose an attachable tab from 'tab list', or ask the owning workspace to detach it; do not force ownership.",
  },
  TAB_NOT_ATTACHED: {
    retryable: false,
    action: "Run 'tab attach <tN>' from the current workspace before operating this tab.",
  },
  WORKSPACE_IDENTITY_UNAVAILABLE: {
    retryable: false,
    action:
      'Set AUTOBROWSER_CALLER_ID to a stable caller identity, or pass --workspace <id> explicitly.',
  },
  WORKSPACE_READONLY: {
    retryable: false,
    action: 'Use an observation command, or reattach the tab without readonly mode.',
  },
  WORKSPACE_REQUIRED: {
    retryable: false,
    action: 'Set AUTOBROWSER_WORKSPACE=auto or pass --workspace <id>.',
  },
  WORKSPACE_TARGET_REQUIRED: {
    retryable: false,
    action: "Run 'tab attach <tN>' to reuse a page or 'tab new [url]' to create one.",
  },
  UNAUTHORIZED: {
    retryable: false,
    action: "Run 'autobrowser connect' so the CLI and relay share the current token.",
  },
  WAIT_NOT_CONFIRMED: {
    retryable: true,
    action:
      'The condition may still become true: check the page, then retry with a longer timeout only if it is genuinely slow.',
  },
  WEBMCP_AMBIGUOUS_TOOL: {
    retryable: false,
    action:
      "Pick a tool by frame id from 'webmcp list' with --frame; do not guess between same-named tools.",
  },
  WEBMCP_UNSUPPORTED: {
    retryable: false,
    action:
      'Use a browser/frame that supports WebMCP; autobrowser will not fall back to arbitrary eval.',
  },
}

/** 未知错误码也要给出"先查状态再决定"的通用动作，不能让 agent 只看到一句报错 */
export function describeErrorCode(code: string | null | undefined): ErrorAction | null {
  if (typeof code !== 'string' || !code) {
    return null
  }
  return ERROR_ACTIONS[code] || GENERIC_ACTION
}
