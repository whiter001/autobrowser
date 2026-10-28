import type { CommandResponse } from './client.js'
import {
  createWebDriverClient,
  type WebDriverEngine,
  type WebDriverError,
} from '../core/webdriver.js'

interface WebDriverCommandOptions {
  engine: WebDriverEngine
  driverUrl: string
  homeDir: string
  fetchImpl?: typeof fetch
}

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'
const KEY_MAP: Record<string, string> = {
  Enter: '\ue007',
  Tab: '\ue004',
  Escape: '\ue00c',
  Backspace: '\ue003',
  Delete: '\ue017',
  ArrowUp: '\ue013',
  ArrowDown: '\ue015',
  ArrowLeft: '\ue012',
  ArrowRight: '\ue014',
  Home: '\ue011',
  End: '\ue010',
  PageUp: '\ue00e',
  PageDown: '\ue00f',
}

function unsupported(engine: string, command: string, detail?: string): CommandResponse {
  return {
    ok: false,
    error: {
      code: 'BROWSER_CAPABILITY_UNSUPPORTED',
      message: detail || `${command} is not supported by the ${engine} WebDriver adapter`,
      suggestedAction:
        'Use the supported WebDriver core commands, or run this command with --engine chromium.',
      details: { engine, command },
    },
  }
}

function selectorForWebDriver(selector: string): string {
  const match = /^@e(\d+)$/.exec(selector)
  return match ? `[data-autobrowser-webdriver-ref="e${match[1]}"]` : selector
}

const SNAPSHOT_SCRIPT = `(() => {
  const root = SELECTOR ? document.querySelector(SELECTOR) : document;
  if (!root) return { error: 'snapshot target not found' };
  const roles = ROLES;
  const candidates = Array.from(root.querySelectorAll('a,button,input,textarea,select,[role],[onclick]'));
  const elements = [];
  let nextRef = 1;
  for (const node of candidates) {
    if (elements.length >= 200) break;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) continue;
    const role = node.getAttribute('role') || node.tagName.toLowerCase();
    if (roles.length && !roles.includes(role)) continue;
    let ref = node.getAttribute('data-autobrowser-webdriver-ref');
    if (!ref) {
      while (document.querySelector('[data-autobrowser-webdriver-ref="e' + nextRef + '"]')) nextRef++;
      ref = 'e' + nextRef++;
      node.setAttribute('data-autobrowser-webdriver-ref', ref);
    }
    elements.push({
      ref: '@' + ref,
      tag: node.tagName.toLowerCase(),
      role,
      text: (node.innerText || node.getAttribute('aria-label') || node.value || '').trim(),
      visible: true,
      enabled: !node.disabled,
      checked: typeof node.checked === 'boolean' ? node.checked : undefined,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    });
  }
  return {
    snapshotId: 'webdriver-' + Date.now(),
    url: location.href,
    title: document.title,
    elements,
    frames: [],
    truncated: candidates.length > elements.length
  };
})()`

export function createWebDriverCommandHandler({
  engine,
  driverUrl,
  homeDir,
  fetchImpl,
}: WebDriverCommandOptions) {
  const client = createWebDriverClient({
    engine,
    driverUrl,
    homeDir,
    ...(fetchImpl ? { fetchImpl } : {}),
  })

  async function execute<TValue = unknown>(script: string): Promise<TValue> {
    return await client.call<TValue>('POST', (sessionId) => `/session/${sessionId}/execute/sync`, {
      script,
      args: [],
    })
  }

  async function findElement(selector: string): Promise<string> {
    const value = await client.call<Record<string, string>>(
      'POST',
      (sessionId) => `/session/${sessionId}/element`,
      { using: 'css selector', value: selectorForWebDriver(selector) },
    )
    const elementId = value[ELEMENT_KEY] || value.ELEMENT
    if (!elementId) throw new Error(`element not found: ${selector}`)
    return elementId
  }

  async function navigate(command: string, args: Record<string, unknown>) {
    const method = command === 'goto' ? 'url' : command
    await client.call(
      'POST',
      (sessionId) => `/session/${sessionId}/${method === 'url' ? 'url' : method}`,
      method === 'url' ? { url: args.url } : {},
    )
    return {
      url: await client.call('GET', (id) => `/session/${id}/url`),
      title: await client.call('GET', (id) => `/session/${id}/title`),
    }
  }

  return async function handleWebDriverCommand(
    command: string,
    args: Record<string, unknown>,
  ): Promise<CommandResponse> {
    if (args.tabId !== undefined || (args.frame && args.frame !== 'top')) {
      return unsupported(
        engine,
        command,
        'Explicit tab/frame targets are not yet supported by this WebDriver adapter',
      )
    }
    const supported = new Set([
      'status',
      'goto',
      'back',
      'forward',
      'reload',
      'snapshot',
      'click',
      'fill',
      'type',
      'press',
      'get',
      'is',
      'storage',
      'cookies',
      'screenshot',
      'close',
    ])
    if (!supported.has(command)) return unsupported(engine, command)
    if (command === 'screenshot') {
      if (args.full === true || args.annotate === true || (args.format && args.format !== 'png')) {
        return unsupported(
          engine,
          command,
          'WebDriver currently supports viewport PNG screenshots only; full-page, annotations and other formats are not emulated',
        )
      }
    }
    if (command === 'snapshot' && args.changed === true)
      return unsupported(
        engine,
        command,
        'Changed-snapshot tracking requires the Chromium extension',
      )
    if (command === 'reload') {
      if (args.waitFor || (args.waitUntil && args.waitUntil !== 'load')) {
        return unsupported(
          engine,
          command,
          'WebDriver reload currently supports the default load wait only',
        )
      }
    }

    try {
      switch (command) {
        case 'status':
          return { ok: true, result: await client.status() }
        case 'goto':
        case 'back':
        case 'forward':
        case 'reload':
          return { ok: true, result: await navigate(command, args) }
        case 'snapshot': {
          const script = SNAPSHOT_SCRIPT.replace('SELECTOR', JSON.stringify(args.selector || null))
            .replace('SELECTOR', JSON.stringify(args.selector || null))
            .replace('ROLES', JSON.stringify(args.roles || []))
          const result = await execute<Record<string, unknown>>(script)
          if (result.error) throw new Error(String(result.error))
          return { ok: true, result }
        }
        case 'click': {
          const elementId = await findElement(String(args.selector))
          await client.call('POST', (id) => `/session/${id}/element/${elementId}/click`, {})
          return { ok: true, result: { clicked: true, selector: args.selector } }
        }
        case 'fill':
        case 'type': {
          const elementId = await findElement(String(args.selector))
          if (command === 'fill') {
            await client.call('POST', (id) => `/session/${id}/element/${elementId}/clear`, {})
          }
          const text =
            String(args.value) + (command === 'type' && args.submit === true ? KEY_MAP.Enter : '')
          await client.call('POST', (id) => `/session/${id}/element/${elementId}/value`, {
            text,
            value: [...text],
          })
          return {
            ok: true,
            result: { [command === 'fill' ? 'filled' : 'typed']: true, selector: args.selector },
          }
        }
        case 'press': {
          const key = String(args.key)
          const text = KEY_MAP[key] || key
          await client.call('POST', (id) => `/session/${id}/element/active/value`, {
            text,
            value: [...text],
          })
          return { ok: true, result: { pressed: key } }
        }
        case 'get': {
          const attr = String(args.attr || 'text')
          if (attr === 'title')
            return { ok: true, result: await client.call('GET', (id) => `/session/${id}/title`) }
          if (attr === 'url')
            return { ok: true, result: await client.call('GET', (id) => `/session/${id}/url`) }
          if (attr === 'cdp-url') return unsupported(engine, command, 'CDP URLs are Chromium-only')
          const selector = JSON.stringify(selectorForWebDriver(String(args.selector)))
          const script = `(() => {
            const node = document.querySelector(${selector});
            if (!node) return { found: false };
            const attr = ${JSON.stringify(attr)};
            if (attr === 'text') return { found: true, value: node.innerText || node.textContent || '' };
            if (attr === 'value') return { found: true, value: node.value ?? '' };
            if (attr === 'html') return { found: true, value: node.outerHTML };
            return { found: true, value: node.getAttribute(attr) };
          })()`
          const result = await execute<{ found: boolean; value?: unknown }>(script)
          if (!result.found) throw new Error(`element not found: ${String(args.selector)}`)
          return { ok: true, result: result.value }
        }
        case 'is': {
          const selector = JSON.stringify(selectorForWebDriver(String(args.selector)))
          const state = String(args.state)
          const result = await execute<{ found: boolean; value?: boolean }>(`(() => {
            const node = document.querySelector(${selector});
            if (!node) return { found: false };
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            const values = {
              visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
              enabled: !node.disabled,
              disabled: Boolean(node.disabled),
              checked: Boolean(node.checked),
              focused: document.activeElement === node
            };
            return { found: true, value: values[${JSON.stringify(state)}] };
          })()`)
          if (!result.found) throw new Error(`element not found: ${String(args.selector)}`)
          return { ok: true, result: result.value }
        }
        case 'storage': {
          const action = String(args.action)
          const store = args.session === true ? 'sessionStorage' : 'localStorage'
          const key = JSON.stringify(args.key)
          let expression = ''
          if (action === 'get')
            expression =
              args.key === undefined
                ? `({ storage: Object.fromEntries(Object.entries(${store})) })`
                : `({ key: ${key}, value: ${store}.getItem(${key}) })`
          else if (action === 'set')
            expression = `(${store}.setItem(${key}, ${JSON.stringify(args.value)}), { key: ${key}, value: ${JSON.stringify(args.value)} })`
          else if (action === 'delete')
            expression = `(${store}.removeItem(${key}), { key: ${key}, deleted: true })`
          else expression = `(${store}.clear(), { cleared: true })`
          return { ok: true, result: await execute(`(() => (${expression}))()`) }
        }
        case 'cookies': {
          const action = String(args.action)
          if (action === 'set') {
            await client.call('POST', (id) => `/session/${id}/cookie`, {
              cookie: {
                name: args.name,
                value: args.value,
                ...(args.domain ? { domain: args.domain } : {}),
              },
            })
            return { ok: true, result: { name: args.name, value: args.value, set: true } }
          }
          if (action === 'delete') {
            await client.call(
              'DELETE',
              (id) => `/session/${id}/cookie/${encodeURIComponent(String(args.name))}`,
            )
            return { ok: true, result: { name: args.name, deleted: true } }
          }
          if (action === 'clear') {
            await client.call('DELETE', (id) => `/session/${id}/cookie`)
            return { ok: true, result: { cleared: true } }
          }
          let cookies = await client.call<Array<Record<string, unknown>>>(
            'GET',
            (id) => `/session/${id}/cookie`,
          )
          const domain = args.domain
          const cookiePath = args.path
          if (typeof domain === 'string') {
            cookies = cookies.filter(
              (cookie) =>
                String(cookie.domain || '').replace(/^\./, '') === domain.replace(/^\./, ''),
            )
          }
          if (typeof cookiePath === 'string') {
            cookies = cookies.filter((cookie) => cookie.path === cookiePath)
          }
          return { ok: true, result: { cookies } }
        }
        case 'screenshot': {
          let data: string
          if (args.element) {
            const elementId = await findElement(String(args.element))
            data = await client.call<string>(
              'GET',
              (id) => `/session/${id}/element/${elementId}/screenshot`,
            )
          } else {
            data = await client.call<string>('GET', (id) => `/session/${id}/screenshot`)
          }
          return { ok: true, result: { data, mimeType: 'image/png', format: 'png' } }
        }
        case 'close': {
          if (args.all === true) {
            await client.closeSession()
            return { ok: true, result: { closed: true, all: true } }
          }
          await client.call('DELETE', (id) => `/session/${id}/window`)
          return { ok: true, result: { closed: true } }
        }
        default:
          return unsupported(engine, command)
      }
    } catch (error) {
      const failure = error as WebDriverError
      return {
        ok: false,
        error: {
          message: failure.message,
          code: failure.code || 'WEBDRIVER_COMMAND_ERROR',
          ...(failure.details !== undefined ? { details: failure.details } : {}),
          ...(failure.suggestedAction ? { suggestedAction: failure.suggestedAction } : {}),
        },
      }
    }
  }
}
