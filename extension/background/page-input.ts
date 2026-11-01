import { createPageInputContext } from './page-input-context.js'
import type { PageInputDependencies } from './page-input-context.js'
import { createElementCommands } from './page-input-element.js'
import { createEvalCommands } from './page-input-eval.js'
import { createKeyboardCommands } from './page-input-keyboard.js'
import { createNavigationCommands } from './page-input-navigation.js'
import { createPointerCommands } from './page-input-pointer.js'

export type { FillFormField } from './page-input-context.js'

// 多步骤动作把执行上下文按可选末位参数传下来，在每个 await 之后、发出下一个 CDP 副作用
// 之前检查取消；keyUp/mouseReleased 这类收尾清理不传 context。
export function createPageInputDomain(dependencies: PageInputDependencies) {
  // 共享上下文：依赖、页面求值入口和等待工具在这里统一注入，
  // 各子域命令再通过依赖注入拿到彼此的能力，避免模块之间互相 import
  const context = createPageInputContext(dependencies)
  const navigation = createNavigationCommands(context)
  const element = createElementCommands(context)
  const pointer = createPointerCommands(context, navigation)
  const keyboard = createKeyboardCommands(context, element)
  const evalTools = createEvalCommands(context)

  return {
    checkElement: element.checkElement,
    checkIsState: element.checkIsState,
    clickSelector: pointer.clickSelector,
    doubleClickSelector: pointer.doubleClickSelector,
    evaluateScript: evalTools.evaluateScript,
    fillElement: element.fillElement,
    fillFields: element.fillFields,
    fillSelector: element.fillSelector,
    focusElement: element.focusElement,
    getAttribute: element.getAttribute,
    generateLocator: evalTools.generateLocator,
    highlightElement: evalTools.highlightElement,
    hoverElement: pointer.hoverElement,
    insertTextOnce: keyboard.insertTextOnce,
    insertTextSequentially: keyboard.insertTextSequentially,
    keyDownOnly: keyboard.keyDownOnly,
    keyUpOnly: keyboard.keyUpOnly,
    navigateBack: navigation.navigateBack,
    navigateForward: navigation.navigateForward,
    navigateTo: navigation.navigateTo,
    pressKey: keyboard.pressKey,
    reloadPage: navigation.reloadPage,
    scrollElement: element.scrollElement,
    scrollIntoViewSelector: element.scrollIntoViewSelector,
    selectOption: element.selectOption,
    switchToFrame: navigation.switchToFrame,
    typeIntoSelector: keyboard.typeIntoSelector,
    uploadFiles: element.uploadFiles,
    dragElement: pointer.dragElement,
    dropData: pointer.dropData,
    mouseMove: pointer.mouseMove,
    mouseButton: pointer.mouseButton,
    mouseWheel: pointer.mouseWheel,
  }
}
