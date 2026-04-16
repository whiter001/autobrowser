import { htmlResponse, jsonResponse, textResponse } from "./core/protocol.js";
import { createRuntime, type Runtime } from "./core/runtime.js";

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface SnapshotData {
  token: string;
  relayPort: number;
  ipcPort: number;
  startedAt: string;
  extensionConnected: boolean;
}

function connectPage(snapshot: SnapshotData): string {
  const token = escapeHtml(snapshot.token);
  const relayUrl = `ws://127.0.0.1:${snapshot.relayPort}/ws`;
  const ipcUrl = `http://127.0.0.1:${snapshot.ipcPort}`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>autobrowser connect</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1020;
        --panel: #121a2f;
        --panel-2: #17213a;
        --text: #e6edf7;
        --muted: #98a6c7;
        --accent: #6ee7ff;
        --accent-2: #9b7bff;
        --border: rgba(255,255,255,0.08);
      }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top left, rgba(110, 231, 255, 0.15), transparent 30%),
          radial-gradient(circle at top right, rgba(155, 123, 255, 0.16), transparent 34%), var(--bg);
        color: var(--text);
        display: grid;
        place-items: center;
      }
      .card {
        width: min(900px, calc(100vw - 40px));
        padding: 28px;
        border: 1px solid var(--border);
        border-radius: 24px;
        background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
        box-shadow: 0 20px 80px rgba(0,0,0,0.35);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 34px;
      }
      p {
        margin: 0 0 12px;
        color: var(--muted);
        line-height: 1.6;
      }
      code, pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      pre {
        overflow: auto;
        padding: 16px;
        border-radius: 16px;
        background: rgba(0, 0, 0, 0.22);
        border: 1px solid var(--border);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-top: 18px;
      }
      .panel {
        padding: 16px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .value {
        margin-top: 8px;
        font-size: 16px;
        word-break: break-all;
      }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      button, a.button {
        appearance: none;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: linear-gradient(180deg, rgba(110,231,255,0.18), rgba(155,123,255,0.18));
        color: var(--text);
        padding: 12px 18px;
        font: inherit;
        cursor: pointer;
        text-decoration: none;
      }
      .small {
        font-size: 12px;
        color: var(--muted);
      }
      @media (max-width: 720px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>autobrowser 已启动</h1>
      <p>本地 relay server 正在运行。先在浏览器扩展中保存 token，再让扩展连到下面的 WebSocket 地址。</p>

      <div class="grid">
        <section class="panel">
          <div class="label">Relay WebSocket</div>
          <div class="value"><code>${relayUrl}</code></div>
        </section>
        <section class="panel">
          <div class="label">CLI API</div>
          <div class="value"><code>${ipcUrl}</code></div>
        </section>
        <section class="panel">
          <div class="label">Token</div>
          <div class="value"><code id="token">${token}</code></div>
        </section>
        <section class="panel">
          <div class="label">Current status</div>
          <div class="value">${snapshot.extensionConnected ? "extension connected" : "waiting for extension"}</div>
        </section>
      </div>

      <div class="actions">
        <button id="copy-token">Copy token</button>
        <a class="button" href="/status">Open status JSON</a>
      </div>

      <pre>1. Open the extension options page.
2. Paste the token above and save it.
3. Reload the extension if it does not connect automatically.
4. Use the CLI against http://127.0.0.1:${snapshot.ipcPort}.</pre>
      <p class="small">If you want a tighter setup later, this page can be extended into a local control dashboard.</p>
    </main>

    <script>
      document.getElementById("copy-token")?.addEventListener("click", async () => {
        const token = document.getElementById("token")?.textContent || "";
        await navigator.clipboard.writeText(token);
      });
    </script>
  </body>
</html>`;
}

interface ServerOptions {
  relayPort?: number;
  ipcPort?: number;
  homeDir?: string;
  token?: string;
}

interface StartServersResult {
  runtime: Runtime;
  relayServer: Bun.Server;
  ipcServer: Bun.Server;
  stop: () => void;
}

export async function startServers(
  options: ServerOptions = {},
): Promise<StartServersResult> {
  const runtime = await createRuntime(options);

  const relayServer = Bun.serve({
    hostname: "127.0.0.1",
    port: runtime.runtime.relayPort,
    fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/ws") {
        if (url.searchParams.get("token") !== runtime.runtime.token) {
          return textResponse("unauthorized", { status: 401 });
        }

        const upgraded = server.upgrade(request, {
          data: {
            extensionId: url.searchParams.get("extensionId") || null,
            userAgent: request.headers.get("user-agent"),
          },
        });

        return upgraded
          ? undefined
          : textResponse("upgrade failed", { status: 400 });
      }

      if (url.pathname === "/connect" || url.pathname === "/") {
        return htmlResponse(connectPage(runtime.snapshot()));
      }

      if (url.pathname === "/status") {
        return jsonResponse(runtime.snapshot());
      }

      return textResponse("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        runtime.attachExtension(
          socket as unknown as WebSocket,
          socket.data as Record<string, unknown>,
        );
        socket.send(
          JSON.stringify({
            type: "hello",
            token: runtime.runtime.token,
            relayPort: runtime.runtime.relayPort,
            ipcPort: runtime.runtime.ipcPort,
          }),
        );
      },
      message(socket, message) {
        runtime.handleExtensionMessage(message);
      },
      close() {
        runtime.detachExtension();
      },
    },
  });

  const ipcServer = Bun.serve({
    hostname: "127.0.0.1",
    port: runtime.runtime.ipcPort,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/status" && request.method === "GET") {
        return jsonResponse(runtime.snapshot());
      }

      if (url.pathname === "/command" && request.method === "POST") {
        return request
          .json()
          .then(async (body: unknown) => {
            const data = body as {
              command?: string;
              args?: Record<string, unknown>;
            } | null;
            const command = String(data?.command || "").trim();
            const args =
              data?.args && typeof data.args === "object" ? data.args : {};

            if (!command) {
              return jsonResponse(
                { ok: false, error: { message: "missing command" } },
                { status: 400 },
              );
            }

            if (command === "status") {
              return jsonResponse({ ok: true, result: runtime.snapshot() });
            }

            try {
              const result = await runtime.dispatchCommand(command, args);
              return jsonResponse({ ok: true, result });
            } catch (error) {
              const err = error as Error;
              runtime.setError(err.message);
              return jsonResponse(
                {
                  ok: false,
                  error: {
                    message: err.message,
                    code: err.code || "COMMAND_FAILED",
                  },
                },
                { status: 500 },
              );
            }
          })
          .catch((error: Error) =>
            jsonResponse(
              { ok: false, error: { message: error.message } },
              { status: 400 },
            ),
          );
      }

      return textResponse("not found", { status: 404 });
    },
  });

  await runtime.persist();

  return {
    runtime,
    relayServer,
    ipcServer,
    stop() {
      relayServer.stop();
      ipcServer.stop();
    },
  };
}
