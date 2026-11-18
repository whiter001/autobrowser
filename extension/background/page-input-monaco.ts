// 页面求值在 isolated world，不能依赖应用暴露 window.monaco，也不能用只渲染视口的行校验完整模型。
export const MONACO_INPUT_HELPER_SOURCE = `
  function findMonacoInput(node) {
    const editor = node.closest?.('.monaco-editor');
    if (!editor) return null;
    const input = editor.querySelector('textarea.inputarea, [contenteditable="true"].native-edit-context');
    return { editor, input };
  }

  function hasMonacoInputFocus(input) {
    return !!input && input.ownerDocument.hasFocus() &&
      isDeepActiveElement(input.ownerDocument, input);
  }

  function focusMonacoInput(monaco) {
    const { input } = monaco;
    if (!input) return { focused: false };
    input.focus();
    return {
      focused: hasMonacoInputFocus(input),
      isMac: /^Mac/.test(input.ownerDocument.defaultView.navigator.platform),
      readOnly: input.readOnly === true || input.getAttribute('aria-readonly') === 'true',
    };
  }

  function copyMonacoSelection(input) {
    const data = new DataTransfer();
    // 只让编辑器填充内存中的 DataTransfer，不读写系统剪贴板。
    input.dispatchEvent(new ClipboardEvent('copy', {
      clipboardData: data, cancelable: true, bubbles: true,
    }));
    try {
      const metadata = JSON.parse(data.getData('vscode-editor-data'));
      if (metadata?.isFromEmptySelection === false && data.types.includes('text/plain')) {
        return data.getData('text/plain');
      }
    } catch {}
    // 默认复制当前行时也会返回文本（甚至包含额外换行），不能当作完整模型。
    return null;
  }
`
