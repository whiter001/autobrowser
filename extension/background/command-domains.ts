import type { createDownloadsDomain } from './downloads.js'
import type { createFileTransferDomain } from './file-transfer.js'
import type { createInitScriptDomain } from './init-scripts.js'
import type { createMediaDomain } from './media.js'
import type { createNetworkDomain } from './network.js'
import type { createPageInputDomain } from './page-input.js'
import type { createPageObserveDomain } from './page-observe.js'
import type { createSessionDomain } from './session.js'
import type { createTracingDomain } from './tracing.js'
import type { createVideoDomain } from './video.js'
import type { createWebMcpDomain } from './webmcp.js'

export type PageInputDomain = ReturnType<typeof createPageInputDomain>
export type PageObserveDomain = ReturnType<typeof createPageObserveDomain>
export type SessionDomain = ReturnType<typeof createSessionDomain>
export type NetworkDomain = ReturnType<typeof createNetworkDomain>
export type DownloadsDomain = ReturnType<typeof createDownloadsDomain>
export type FileTransferDomain = ReturnType<typeof createFileTransferDomain>
export type MediaDomain = ReturnType<typeof createMediaDomain>
export type InitScriptDomain = ReturnType<typeof createInitScriptDomain>
export type TracingDomain = ReturnType<typeof createTracingDomain>
export type VideoDomain = ReturnType<typeof createVideoDomain>
export type WebMcpDomain = ReturnType<typeof createWebMcpDomain>
