export interface DevicePreset {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  userAgent: string
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'desktop-chrome': {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
    userAgent: '',
  },
  'iphone-15': {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  'pixel-10': {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  },
}

export function getDevicePreset(name: string): DevicePreset | null {
  return DEVICE_PRESETS[name] || null
}
