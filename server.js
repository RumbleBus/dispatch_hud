// Dispatch HUD — Real-time operational dashboard for OpenClaw
// Zero npm dependencies. Node.js builtins only.
// Watches the session store on disk and streams state to the browser via SSE.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const OPENCLAW = process.env.OPENCLAW_PATH || '/usr/bin/openclaw';

// ---------- config ----------
const PORT = 4400;
const HOST = process.env.HUD_HOST || '0.0.0.0';
const SESSION_STORE = path.join(process.env.HOME || '/home/node', '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
const POLL_INTERVAL = 30000; // fallback CLI poll every 30s
const ACTIVE_THRESHOLD = 60000;    // 60s since last update = active
const RECENT_THRESHOLD = 300000;   // 5min since last update = recent

// ---------- state ----------
let agents = [];
let sessions = {};       // key -> session metadata
let openclawVersion = null;
let versionChecked = false;
let formatError = null;
let sseClients = new Set();
let changeTimer = null;
let pendingChanges = false;
let lastStoreMtime = 0;

// ---------- helpers ----------
function now() { return Date.now(); }

function ago(ms) {
  const s = Math.floor((now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h + 'h ago';
}

function fmtTokens(n) {
  if (!n || n < 0) return '-';
  if (n < 1000) return n + '';
  if (n < 1000000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

// ---------- data sources ----------

function loadAgents() {
  try {
    const raw = execSync(OPENCLAW + ' agents list --json', { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { PATH: '/usr/bin:/usr/local/bin:' + (process.env.PATH || '') }) });
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[hud] agents list returned non-array:', typeof parsed);
      return;
    }
    agents = parsed.map(a => ({
      id: a.id,
      name: a.name || a.id,
      model: a.model || 'unknown',
      identityEmoji: a.identityEmoji || '',
      identityName: a.identityName || a.name || a.id,
      isDefault: !!a.isDefault,
      workspace: a.workspace || '',
    }));
    console.log(`[hud] loaded ${agents.length} agents`);
  } catch (e) {
    console.warn('[hud] failed to load agents:', e.message);
  }
}

function loadVersion() {
  try {
    const raw = execSync(OPENCLAW + ' status --json', { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { PATH: '/usr/bin:/usr/local/bin:' + (process.env.PATH || '') }) });
    const parsed = JSON.parse(raw);
    // Extract version from status output
    const ver = parsed && (parsed.runtimeVersion || parsed.version);
    if (ver) {
      openclawVersion = ver;
      versionChecked = true;
      console.log(`[hud] OpenClaw version: ${ver}`);
    }
  } catch (e) {
    console.warn('[hud] failed to check version:', e.message);
  }
}

const EXPECTED_SESSION_KEYS = ['key', 'updatedAt', 'totalTokens', 'model', 'agentId', 'kind', 'contextTokens', 'inputTokens', 'outputTokens'];

function validateSessionEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  // Check that at least some expected keys exist
  const hasKey = EXPECTED_SESSION_KEYS.some(k => k in entry);
  if (!hasKey) return false;
  return true;
}

function stripSession(entry) {
  // Strip message history, just keep metadata
  const meta = {};
  for (const k of EXPECTED_SESSION_KEYS) {
    if (k in entry) meta[k] = entry[k];
  }
  // Also grab useful extras
  if ('sessionId' in entry) meta.sessionId = entry.sessionId;
  if ('ageMs' in entry) meta.ageMs = entry.ageMs;
  if ('lastInteractionAt' in entry) meta.lastInteractionAt = entry.lastInteractionAt;
  if ('sessionStartedAt' in entry) meta.sessionStartedAt = entry.sessionStartedAt;
  if ('agentRuntime' in entry) meta.agentRuntime = entry.agentRuntime;
  if ('modelOverride' in entry) meta.modelOverride = entry.modelOverride;
  if ('providerOverride' in entry) meta.providerOverride = entry.providerOverride;
  return meta;
}

function loadSessionStore() {
  try {
    if (!fs.existsSync(SESSION_STORE)) {
      return { exists: false, sessions: {} };
    }
    const raw = fs.readFileSync(SESSION_STORE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      formatError = 'session store format unexpected';
      console.warn('[hud] unexpected session store format:', typeof parsed);
      return { exists: true, sessions: {} };
    }

    // Validate format
    let validCount = 0;
    const stripped = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (validateSessionEntry(entry)) {
        stripped[key] = stripSession(entry);
        validCount++;
      } else {
        console.warn(`[hud] skipping invalid session entry: ${key}`);
      }
    }

    // Clear format error if we got valid data
    if (validCount > 0) formatError = null;

    // Update mtime
    try {
      lastStoreMtime = fs.statSync(SESSION_STORE).mtimeMs;
    } catch (e) { /* ignore */ }

    return { exists: true, sessions: stripped };
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.warn('[hud] JSON parse error (file may be mid-write):', e.message);
      return { exists: true, sessions: null, parseError: true };
    }
    console.warn('[hud] failed to read session store:', e.message);
    return { exists: true, sessions: null };
  }
}

function diffSessions(oldSessions, newSessions) {
  const changed = [];
  const removed = [];

  // Check for new/changed sessions
  for (const [key, entry] of Object.entries(newSessions)) {
    const old = oldSessions[key];
    if (!old || old.updatedAt !== entry.updatedAt) {
      changed.push(entry);
    }
  }

  // Check for removed sessions
  for (const key of Object.keys(oldSessions)) {
    if (!(key in newSessions)) {
      removed.push(key);
    }
  }

  return { changed, removed };
}

// ---------- SSE ----------

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // client gone
  }
}

function broadcast(event, data) {
  for (const res of sseClients) {
    sseSend(res, event, data);
  }
}

function buildState() {
  // Determine agent status from session data
  const agentStatus = {};
  const agentSessions = {};
  const now_ms = now();

  for (const [key, s] of Object.entries(sessions)) {
    const aid = s.agentId;
    if (!aid) continue;
    if (!agentSessions[aid]) agentSessions[aid] = [];
    agentSessions[aid].push(s);
  }

  const agentList = agents.map(a => {
    const ses = agentSessions[a.id] || [];
    const activeSessions = ses.filter(s => s.updatedAt && (now_ms - s.updatedAt) < ACTIVE_THRESHOLD);
    const recentSessions = ses.filter(s => s.updatedAt && (now_ms - s.updatedAt) < RECENT_THRESHOLD);
    const totalTokens = ses.reduce((sum, s) => sum + (s.totalTokens || 0), 0);
    const lastActive = ses.length > 0
      ? Math.max(...ses.filter(s => s.updatedAt).map(s => s.updatedAt))
      : null;

    let status = 'idle';
    if (activeSessions.length > 0) status = 'active';
    else if (recentSessions.length > 0) status = 'recent';

    return {
      id: a.id,
      name: a.name,
      model: a.model,
      emoji: a.identityEmoji,
      status,
      sessions: ses.length,
      activeSessions: activeSessions.length,
      tokens: totalTokens,
      lastActive,
    };
  });

  // Build session list for display (sorted by most recent)
  const sessionList = Object.values(sessions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // Build comms placeholder
  const comms = [];

  return {
    agents: agentList,
    sessions: sessionList,
    comms,
    now: now_ms,
    version: openclawVersion,
    formatError,
  };
}

function sendFullState(res) {
  const state = buildState();
  sseSend(res, 'state', state);
}

function broadcastFullState() {
  const state = buildState();
  broadcast('state', state);
}

// ---------- file watcher ----------

function processStoreChange() {
  if (pendingChanges) return;
  pendingChanges = true;

  // Debounce rapid writes
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    pendingChanges = false;

    const result = loadSessionStore();
    if (!result.exists) {
      // Gateway may be restarting
      if (sseClients.size > 0) {
        broadcast('gateway-offline', { message: 'Gateway is offline. Restart it with: openclaw gateway restart' });
      }
      return;
    }

    if (result.parseError) {
      // File was mid-write, retry
      changeTimer = setTimeout(processStoreChange, 200);
      pendingChanges = true;
      return;
    }

    if (result.sessions === null) {
      return;
    }

    const oldSessions = sessions;
    sessions = result.sessions;

    if (sseClients.size === 0) return; // nobody to tell

    const diff = diffSessions(oldSessions, result.sessions);

    if (diff.changed.length > 0 || diff.removed.length > 0) {
      broadcast('session-update', {
        changed: diff.changed,
        removed: diff.removed,
        now: now(),
      });
    }
  }, 200);
}

function startWatcher() {
  try {
    fs.watch(SESSION_STORE, (eventType, filename) => {
      if (eventType === 'change' || eventType === 'rename') {
        processStoreChange();
      }
    });
    console.log('[hud] watching session store:', SESSION_STORE);
  } catch (e) {
    console.warn('[hud] fs.watch failed, falling back to polling:', e.message);
    // Fall back to polling
    setInterval(() => {
      processStoreChange();
    }, 5000);
  }
}

// ---------- CLI polling fallback ----------

function pollCli() {
  try {
    const raw = execSync(OPENCLAW + ' sessions list --json', { encoding: 'utf8', timeout: 15000, env: Object.assign({}, process.env, { PATH: '/usr/bin:/usr/local/bin:' + (process.env.PATH || '') }) });
    const parsed = JSON.parse(raw);

    if (!parsed || !Array.isArray(parsed.sessions)) {
      console.warn('[hud] CLI poll: unexpected format');
      return;
    }

    // Merge CLI data into our session state
    // This catches anything the file watcher might have missed
    let changed = false;
    for (const cliSession of parsed.sessions) {
      const key = cliSession.key;
      if (!key) continue;
      const existing = sessions[key];
      if (!existing || existing.updatedAt !== cliSession.updatedAt) {
        sessions[key] = {
          key: cliSession.key,
          sessionId: cliSession.sessionId,
          agentId: cliSession.agentId,
          model: cliSession.model,
          modelOverride: cliSession.modelOverride,
          kind: cliSession.kind,
          updatedAt: cliSession.updatedAt,
          totalTokens: cliSession.totalTokens,
          inputTokens: cliSession.inputTokens,
          outputTokens: cliSession.outputTokens,
          contextTokens: cliSession.contextTokens,
          ageMs: cliSession.ageMs,
        };
        changed = true;
      }
    }

    if (changed && sseClients.size > 0) {
      broadcastFullState();
    }
  } catch (e) {
    // CLI failures are expected when gateway is offline
    if (sseClients.size > 0 && !fs.existsSync(SESSION_STORE)) {
      broadcast('gateway-offline', { message: 'Gateway is offline. Restart it with: openclaw gateway restart' });
    }
  }
}

// ---------- HTTP server ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // SSE endpoint
  if (pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send full state immediately
    sendFullState(res);

    // If gateway is offline, send offline event
    if (!fs.existsSync(SESSION_STORE)) {
      sseSend(res, 'gateway-offline', { message: 'Gateway is offline. Restart it with: openclaw gateway restart' });
    }

    // If version hasn't been checked yet, check now
    if (!versionChecked) {
      loadVersion();
    }
    if (openclawVersion) {
      sseSend(res, 'version', { version: openclawVersion });
    }

    sseClients.add(res);
    console.log(`[hud] SSE client connected (${sseClients.size} total)`);

    req.on('close', () => {
      sseClients.delete(res);
      console.log(`[hud] SSE client disconnected (${sseClients.size} remaining)`);
    });

    return;
  }

  // Static files
  let filepath = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(__dirname, 'public', filepath);

  // Prevent path traversal
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(file);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };

  try {
    const content = fs.readFileSync(file);
    const mime = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'max-age=3600',
    });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ---------- start ----------

function startup() {
  console.log('[hud] Dispatch HUD starting...');
  console.log('[hud] session store:', SESSION_STORE);

  // Load agents
  loadAgents();

  // Check version
  loadVersion();

  // Load initial session state
  const result = loadSessionStore();
  if (result.exists && result.sessions) {
    sessions = result.sessions;
    console.log(`[hud] loaded ${Object.keys(sessions).length} sessions`);
  } else if (!result.exists) {
    console.log('[hud] session store not found (gateway may be offline)');
  }

  // Start file watcher
  startWatcher();

  // Start CLI polling fallback
  setInterval(pollCli, POLL_INTERVAL);

  // Start HTTP server
  server.listen(PORT, HOST, () => {
    console.log(`[hud] listening on http://${HOST}:${PORT}`);
    console.log(`[hud] ${agents.length} agents, ${Object.keys(sessions).length} sessions`);
    if (openclawVersion) {
      console.log(`[hud] OpenClaw ${openclawVersion}`);
    }
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[hud] shutting down...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[hud] shutting down...');
  server.close(() => process.exit(0));
});

startup();