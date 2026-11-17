async (page) => {
  await page.evaluate(() => {
    const create = (tag, options = {}) => {
      const element = document.createElement(tag)
      if (options.text) element.textContent = options.text
      if (options.href) element.setAttribute('href', options.href)
      if (options.src) element.setAttribute('src', options.src)
      if (options.id) element.id = options.id
      return element
    }

    const card = create('ytd-video-renderer')
    const thumbnail = create('a', { id: 'thumbnail', href: '/watch?v=anUdyedhsbE' })
    thumbnail.append(create('img', { src: 'https://i.ytimg.com/vi/anUdyedhsbE/hq720.jpg' }))
    const channel = create('a', { href: 'https://www.youtube.com/@MoonBit_lang' })
    channel.append(create('img', { src: 'https://yt3.ggpht.com/channel-avatar=s68' }))
    const heading = create('h3')
    heading.append(create('a', { id: 'video-title', href: '/watch?v=anUdyedhsbE', text: 'MoonBit Online Meetup #15' }))
    const channelName = create('ytd-channel-name')
    channelName.append(create('yt-formatted-string', { text: 'MoonBit' }))
    channelName.append(create('yt-formatted-string', { text: 'MoonBit' }))
    const metadata = create('div', { id: 'metadata-line', text: '130\n3个月前' })
    const owner = create('ytd-video-owner-renderer')
    owner.append(channel, channelName)

    card.append(thumbnail, heading, owner, metadata)
    document.body.replaceChildren(card)
    document.title = 'MoonBit - YouTube'
  })
  return await page.title()
}
