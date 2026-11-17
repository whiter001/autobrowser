async (page) => {
  await page.evaluate(() => {
    // 只用 createElement/textContent，不拼 innerHTML：
    // B 站页面开了 Trusted Types，字符串 HTML 会被直接拒绝。
    const create = (tag, options = {}) => {
      const element = document.createElement(tag)
      if (options.text) element.textContent = options.text
      if (options.href) element.setAttribute('href', options.href)
      if (options.src) element.setAttribute('src', options.src)
      if (options.className) element.setAttribute('class', options.className)
      return element
    }

    // 作者区域里的空头像图标：没有文本的 SVG，作者名在它后面的链接上。
    const createAuthorIcon = () => {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('class', 'author-ico')
      icon.setAttribute('width', '20')
      icon.setAttribute('height', '20')
      return icon
    }

    const videoUrl = 'https://www.bilibili.com/video/BV1xx411c7mD'

    // 普通视频卡：封面 + BV 链接 + owner 作者 + 日期。
    const normal = create('div', { className: 'bili-video-card' })
    const normalCover = create('a', { href: videoUrl })
    normalCover.append(create('img', { src: 'https://i0.hdslb.com/bfs/archive/example-cover.jpg' }))
    const normalInfo = create('div', { className: 'bili-video-card__info' })
    const normalTitle = create('h3', { className: 'bili-video-card__info--tit' })
    normalTitle.append(create('a', { href: videoUrl, text: '示例视频标题' }))
    const normalOwner = create('div', { className: 'bili-video-card__info--owner' })
    normalOwner.append(createAuthorIcon())
    normalOwner.append(create('a', { href: 'https://space.bilibili.com/123456', text: '老番茄' }))
    const normalDate = create('span', {
      className: 'bili-video-card__info--date',
      text: '· 2024-05-01',
    })
    normalInfo.append(normalTitle, normalOwner, normalDate)
    normal.append(normalCover, normalInfo)

    // 广告卡：明确的"广告"标记 + cm.bilibili.com 跟踪链接，没有 BV 视频链接。
    const ad = create('div', { className: 'bili-video-card' })
    const adInfo = create('div', { className: 'bili-video-card__info' })
    const adTitle = create('h3', { className: 'bili-video-card__info--tit' })
    adTitle.append(create('a', { href: 'https://www.bilibili.com/ad/promo', text: '广告推广标题' }))
    const adOwner = create('div', { className: 'bili-video-card__info--owner' })
    adOwner.append(create('span', { text: '某品牌旗舰店' }))
    const adMarker = create('span', { className: 'bili-video-card__info--ad' })
    adMarker.append(
      create('a', {
        href: 'https://cm.bilibili.com/x/abc123?utm_source=feed',
        text: '广告',
      }),
    )
    adInfo.append(adTitle, adOwner, adMarker)
    ad.append(adInfo)

    // 整页替换：真实页面自带的卡片不能混进采集结果。
    document.body.replaceChildren(normal, ad)
    document.title = 'B 站推荐 - bilibili'
  })
  return await page.title()
}
