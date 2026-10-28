interface RecorderSession {
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
}

const sessions = new Map<number, RecorderSession>()

async function startRecording(tabId: number, streamId: string): Promise<void> {
  if (sessions.has(tabId)) throw new Error('Recording is already active')
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints,
    audio: false,
  })
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  )
  if (!mimeType) throw new Error('MediaRecorder does not support WebM')
  const recorder = new MediaRecorder(stream, { mimeType })
  const session: RecorderSession = { recorder, stream, chunks: [] }
  sessions.set(tabId, session)
  recorder.ondataavailable = (event) => {
    if (event.data.size) session.chunks.push(event.data)
  }
  recorder.start(250)
}

async function stopRecording(tabId: number): Promise<void> {
  const session = sessions.get(tabId)
  if (!session) throw new Error('Recording has not been started')
  await new Promise<void>((resolve, reject) => {
    session.recorder.onerror = () => reject(new Error('MediaRecorder failed'))
    session.recorder.onstop = () => resolve()
    session.recorder.stop()
  })
  const blob = new Blob(session.chunks, { type: session.recorder.mimeType })
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('Failed to read recording'))
    reader.readAsDataURL(blob)
  })
  for (const track of session.stream.getTracks()) track.stop()
  sessions.delete(tabId)
  await chrome.runtime.sendMessage({
    type: 'autobrowser.video.result',
    tabId,
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    bytes: blob.size,
    mimeType: blob.type || 'video/webm',
  })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'autobrowser.video.start') {
    void startRecording(Number(message.tabId), String(message.streamId)).then(
      () => sendResponse({ ok: true }),
      (error: Error) => sendResponse({ ok: false, error: error.message }),
    )
    return true
  }
  if (message?.type === 'autobrowser.video.stop') {
    void stopRecording(Number(message.tabId)).then(
      () => sendResponse({ ok: true }),
      (error: Error) => sendResponse({ ok: false, error: error.message }),
    )
    return true
  }
  return false
})
