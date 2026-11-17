async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  await page.setContent(`<!doctype html>
    <html lang="zh-CN">
      <head><title>autobrowser advanced smoke</title></head>
      <body>
        <label for="query">Query</label>
        <input id="query">
        <label for="mode">Mode</label>
        <select id="mode">
          <option value="fast">Fast</option>
          <option value="deep">Deep</option>
        </select>
        <label for="ready">Ready</label>
        <input id="ready" type="checkbox">
        <button id="load" type="button">Load items</button>
        <output id="status">idle</output>
        <ul id="items"></ul>
        <button id="mock" type="button">Load mocked</button>
        <output id="mock-result"></output>
        <label for="upload">Upload</label>
        <input id="upload" type="file">
        <output id="upload-result"></output>
        <button id="prompt" type="button">Prompt</button>
        <output id="prompt-result"></output>
        <iframe id="details-frame" src="/frame" title="Details"></iframe>
        <script>
          const status = document.querySelector('#status')
          document.querySelector('#load').addEventListener('click', async () => {
            if (!document.querySelector('#ready').checked) {
              status.textContent = 'error: not ready'
              return
            }

            status.textContent = 'loading'
            const query = document.querySelector('#query').value
            const mode = document.querySelector('#mode').value
            const response = await fetch(
              '/api/items?query=' + encodeURIComponent(query) + '&mode=' + mode,
            )
            if (!response.ok) {
              status.textContent = 'error: HTTP ' + response.status
              return
            }

            const data = await response.json()
            const list = document.querySelector('#items')
            list.replaceChildren()
            for (const item of data.items) {
              const li = document.createElement('li')
              li.textContent = item
              list.append(li)
            }
            localStorage.setItem(
              'advanced-smoke',
              JSON.stringify({ query, mode, count: data.items.length }),
            )
            document.cookie = 'advanced_smoke=ready; path=/; SameSite=Lax'
            status.textContent = 'ready'
          })

          document.querySelector('#mock').addEventListener('click', async () => {
            const response = await fetch('/api/should-be-mocked')
            const data = await response.json()
            document.querySelector('#mock-result').textContent = data.source + ':' + data.value
          })

          document.querySelector('#upload').addEventListener('change', async (event) => {
            const file = event.target.files[0]
            document.querySelector('#upload-result').textContent =
              file.name + ':' + (await file.text())
          })
          document.querySelector('#prompt').addEventListener('click', () => {
            const answer = window.prompt('Enter value')
            document.querySelector('#prompt-result').textContent = 'prompt:' + answer
          })
        </script>
      </body>
    </html>`)

  const checks = []
  await page.getByRole('button', { name: 'Load items', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'error: not ready')
  checks.push('validation-error')

  await page.getByLabel('Query', { exact: true }).fill('alpha')
  await page.getByLabel('Mode', { exact: true }).selectOption('deep')
  await page.getByLabel('Ready', { exact: true }).check()
  await page.getByRole('button', { name: 'Load items', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready')

  const items = await page.locator('#items li').allTextContents()
  assert(
    JSON.stringify(items) === JSON.stringify(['query:alpha', 'mode:deep', 'server:ok']),
    `真实请求渲染结果不正确：${JSON.stringify(items)}`,
  )
  checks.push('form-and-async-fetch')

  await page.route('**/api/should-be-mocked', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ source: 'route', value: 42 }),
    })
  })
  try {
    await page.getByRole('button', { name: 'Load mocked', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('#mock-result')?.textContent === 'route:42',
    )
  } finally {
    await page.unroute('**/api/should-be-mocked')
  }
  checks.push('route-interception')

  const frame = page.frameLocator('#details-frame')
  await frame.getByRole('button', { name: 'Frame action', exact: true }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('#details-frame')?.contentDocument?.querySelector('#frame-result')
        ?.textContent === 'frame-ready',
  )
  checks.push('iframe-interaction')

  page.once('dialog', async (dialog) => {
    assert(dialog.type() === 'prompt', '对话框类型不正确')
    await dialog.accept('confirmed')
  })
  await page.getByRole('button', { name: 'Prompt', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('#prompt-result')?.textContent === 'prompt:confirmed',
  )
  checks.push('native-dialog')

  const storage = await page.evaluate(() => JSON.parse(localStorage.getItem('advanced-smoke')))
  assert(storage.query === 'alpha' && storage.mode === 'deep' && storage.count === 3, '存储内容不正确')
  const cookieWritten = await page.evaluate(() => document.cookie.includes('advanced_smoke=ready'))
  assert(cookieWritten, '页面 cookie 未写入')
  checks.push('storage-and-cookie')

  return {
    checks,
    items,
    storage,
    mocked: await page.locator('#mock-result').textContent(),
    frame: await frame.locator('#frame-result').textContent(),
  }
}
