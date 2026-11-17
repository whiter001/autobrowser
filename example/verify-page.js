async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  await page.setContent(`<!doctype html>
    <html lang="zh-CN">
      <head><title>autobrowser CLI smoke</title></head>
      <body>
        <label for="name">名称</label>
        <input id="name" name="name">
        <button id="increment" type="button">Increment</button>
        <output id="counter">0</output>
        <script>
          document.querySelector('#increment').addEventListener('click', () => {
            setTimeout(() => {
              document.querySelector('#counter').textContent = '1'
            }, 25)
          })
        </script>
      </body>
    </html>`)

  const checks = []
  assert((await page.title()) === 'autobrowser CLI smoke', '页面标题不符合预期')
  checks.push('title')

  await page.getByLabel('名称', { exact: true }).fill('from-autobrowser')
  assert(
    (await page.locator('#name').inputValue()) === 'from-autobrowser',
    '输入框填写结果不符合预期',
  )
  checks.push('fill')

  await page.getByRole('button', { name: 'Increment', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#counter')?.textContent === '1')
  checks.push('click-and-async-wait')

  return {
    checks,
    title: await page.title(),
    name: await page.locator('#name').inputValue(),
    counter: await page.locator('#counter').textContent(),
  }
}
