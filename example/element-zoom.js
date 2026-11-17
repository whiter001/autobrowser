async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const near = (actual, expected) => Math.abs(actual - expected) < 0.01

  await page.setContent(`<!doctype html>
    <html lang="zh-CN">
      <head><title>autobrowser element zoom</title></head>
      <body style="margin: 0">
        <div id="zoom-target" style="width: 160px; height: 80px; zoom: 1; background: #dbeafe">
          <button id="inside-button" type="button">Inside zoom</button>
          <output id="click-result">not-clicked</output>
        </div>
        <script>
          document.querySelector('#inside-button').addEventListener('click', () => {
            document.querySelector('#click-result').textContent = 'clicked-at-1.5'
          })
        </script>
      </body>
    </html>`)

  const target = page.locator('#zoom-target')
  const before = await target.boundingBox()
  assert(before && near(before.width, 160) && near(before.height, 80), '初始元素尺寸不正确')

  await target.evaluate((element) => {
    element.dataset.autobrowserOldZoom = element.style.zoom
    element.style.zoom = '1.5'
  })

  let during
  let clickResult
  try {
    during = await target.boundingBox()
    assert(
      during && near(during.width, 240) && near(during.height, 120),
      `局部放大尺寸不正确：${JSON.stringify(during)}`,
    )

    await target.getByRole('button', { name: 'Inside zoom', exact: true }).click()
    clickResult = await page.locator('#click-result').textContent()
    assert(clickResult === 'clicked-at-1.5', '放大后的元素内部点击未生效')
  } finally {
    await target.evaluate((element) => {
      element.style.zoom = element.dataset.autobrowserOldZoom || ''
      delete element.dataset.autobrowserOldZoom
    })
  }

  const restored = await target.boundingBox()
  assert(
    restored && near(restored.width, before.width) && near(restored.height, before.height),
    '还原后的元素尺寸不正确',
  )
  const restoredStyle = await target.evaluate((element) => ({
    zoom: element.style.zoom,
    savedZoom: element.dataset.autobrowserOldZoom,
  }))
  assert(restoredStyle.zoom === '1' && restoredStyle.savedZoom === undefined, '原始 zoom 样式未还原')

  return {
    checks: ['layout-zoom', 'zoomed-click', 'restore-style-and-size'],
    before,
    during,
    restored,
    clickResult,
    restoredStyle,
  }
}
