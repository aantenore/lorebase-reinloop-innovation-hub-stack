// Real-time world server: `node server/src/game-main.ts [--mock] [--seconds N] [--lorebase-wait N]`.
// REST endpoints (rules, scenarios, roster, status, SSE mirror) and the WebSocket `/ws`.
import { loadConfig } from './config.ts';
import { createHttpServer } from './http/server.ts';
import { attachWebSocket } from './http/ws.ts';
import { loadGameConfig } from './rt/config.ts';
import { Game } from './rt/game.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cfg = loadConfig(argv);
const gameCfg = loadGameConfig();
const seconds = Number(flag('--seconds') ?? 0);
// --lorebase-wait N: give up (exit 1) when Lorebase, or its seed, is not there after N seconds (lorebase.maxWaitMs).
const lorebaseWait = Number(flag('--lorebase-wait') ?? NaN);
if (Number.isFinite(lorebaseWait) && lorebaseWait >= 0) cfg.lorebase.maxWaitMs = lorebaseWait * 1000;

const game = new Game(cfg, gameCfg);
const server = createHttpServer(game);
const wss = attachWebSocket(server, { path: gameCfg.ws.path, maxPayloadBytes: gameCfg.ws.maxPayloadBytes, port: cfg.http.port, corsOrigins: cfg.http.corsOrigins, apiToken: cfg.apiToken, allowedHosts: cfg.http.allowedHosts }, {
  open: (c) => game.onOpen(c),
  message: (c, m) => game.onMessage(c, m),
  close: (c) => game.onClose(c),
});

server.listen(cfg.http.port, cfg.http.host, () => {
  const provider = game.mock ? `mock (offline: ${game.mockReason})` : game.provider;
  console.log(`real-time world on http://${cfg.http.host}:${cfg.http.port} (ws ${gameCfg.ws.path}, provider ${provider}${cfg.modelOverride ? `, all agents on ${cfg.modelOverride}` : ''}${cfg.apiToken ? ', token required' : ''})`);
});

let stopping = false;
async function stop(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  await game.shutdown();
  for (const c of wss.clients) c.terminate();
  server.closeAllConnections();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

// The run's time limit counts from here, while Lorebase may still be awaited.
if (seconds > 0) setTimeout(() => void stop(), seconds * 1000);
try {
  await game.init();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await stop(1);
}
