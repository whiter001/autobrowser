import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'autobrowser';
export const DEFAULT_RELAY_PORT = 47978;
export const DEFAULT_IPC_PORT = 47979;
export const STATE_DIR_NAME = '.autobrowser';
export const TOKEN_FILE_NAME = 'token';
export const STATE_FILE_NAME = 'state.json';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function getHomeDir() {
  return process.env.AUTOBROWSER_HOME || process.env.HOME || os.homedir();
}

export function getStateDir(homeDir = getHomeDir()) {
  return path.join(homeDir, STATE_DIR_NAME);
}

export function getTokenPath(homeDir = getHomeDir()) {
  return path.join(getStateDir(homeDir), TOKEN_FILE_NAME);
}

export function getStatePath(homeDir = getHomeDir()) {
  return path.join(getStateDir(homeDir), STATE_FILE_NAME);
}

export function createToken() {
  return crypto.randomUUID().replaceAll('-', '');
}

export function createId(prefix = 'req') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export async function ensureStateDir(homeDir = getHomeDir()) {
  await mkdir(getStateDir(homeDir), { recursive: true });
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

export async function writeJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }

  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    ...init,
    headers,
  });
}

export async function parseJsonRequest(request) {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }

  return JSON.parse(text);
}

export function textResponse(value, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }

  return new Response(value, { ...init, headers });
}

export function htmlResponse(value, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8');
  }

  return new Response(value, { ...init, headers });
}

export function success(result, meta = {}) {
  return { ok: true, result, ...meta };
}

export function failure(message, meta = {}) {
  return { ok: false, error: { message, ...meta } };
}

export async function isPortInUse(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    return response.ok;
  } catch {
    return false;
  }
}
