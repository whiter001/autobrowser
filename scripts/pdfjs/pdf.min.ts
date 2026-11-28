import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

// build:chrome 会把这个入口打成 IIFE；注入页面后通过 globalThis.pdfjsLib 取库。
;(globalThis as unknown as { pdfjsLib: unknown }).pdfjsLib = pdfjsLib
