async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  const visibleSummaries = page.locator('.ai-summary:visible')
  await visibleSummaries.waitFor()
  assert(await page.locator('.ai-summary').count() === 2, '测试页应包含两份摘要节点')
  assert(await visibleSummaries.count() === 1, '可见摘要去重失败')
  const summary = (await visibleSummaries.textContent()).trim()
  assert(summary === '可见的知乎 AI 摘要', '可见摘要内容不正确')

  const answerHref = await page.locator('[data-target-answer]').getAttribute('href')
  assert(answerHref, '目标回答链接不存在')
  await page.goto(new URL(answerHref, page.url()).href)
  await page.locator('#answer-target .RichContent-inner').waitFor()

  const title = await page.title()
  assert(title.includes('目标回答'), '动态标题中缺少目标标题')
  assert(await page.locator('.RichContent-inner').count() === 2, '测试回答页应包含多个正文容器')

  const answer = page.locator('#answer-target')
  const result = {
    title,
    summary,
    author: (await answer.locator('.author').textContent()).trim(),
    publishedAt: (await answer.locator('.published-at').textContent()).trim(),
    url: page.url(),
    content: (await answer.locator('.RichContent-inner').textContent()).trim(),
  }
  assert(result.author === '目标作者', '目标回答作者不匹配')
  assert(result.publishedAt === '2026-11-17', '目标回答日期不匹配')
  assert(result.content.includes('保留来源元数据'), '目标回答正文不匹配')

  const itemCount = await page.evaluate(() => {
    window.researchItems = Array.from({ length: 140 }, (_, index) => ({
      id: index + 1,
      title: `结构化条目 ${index + 1}`,
      content: '反脆弱'.repeat(100),
    }))
    return window.researchItems.length
  })
  assert(itemCount === 140, '大结果测试数据生成失败')

  return {
    checks: ['visible-deduplication', 'target-answer-container', 'dynamic-title'],
    answer: result,
    itemCount,
  }
}
