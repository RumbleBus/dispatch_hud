// Dispatch HUD v2 — Task-Centric Operational Dashboard
// Zero npm dependencies. Node.js builtins only.
// Reads sessions.json + peeks transcript first-user-messages for spawn-child sessions.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OPENCLAW = process.env.OPENCLAW_PATH || '/usr/bin/openclaw';
const AGENTS_DIR = path.join(process.env.HOME || '/home/node', '.openclaw', 'agents');
const MAIN_SESSION_STORE = path.join(AGENTS_DIR, 'main', 'sessions', 'sessions.json');
const MAIN_TRANSCRIPT_DIR = path.join(AGENTS_DIR, 'main', 'sessions');

// ---------- config ----------
const PORT = 4400;
const HOST = process.env.HUD_HOST || '0.0.0.0';
const SESSION_STORE = MAIN_SESSION_STORE;
const TRANSCRIPT_DIR = MAIN_TRANSCRIPT_DIR;
const POLL_INTERVAL = 5000;       // CLI poll every 5s
const ACTIVE_THRESHOLD = 60000;   // 60s since last update = active
const RECENT_THRESHOLD = 300000;  // 5min since last update = recent
const MAX_TASK_DESC_LEN = 300;
const TOPIC_NAMES_FILE = path.join(__dirname, 'topic-names.json');
let topicNames = { topics: {}, directs: {}, groups: {}, cron: {} };

// ---------- state ----------
let agents = [];
let sessions = {};       // key -> session metadata
let taskCache = {};       // sessionId -> { taskDesc, agentName, cachedAt }
let openclawVersion = null;
let versionChecked = false;
let formatError = null;
let sseClients = new Set();
let changeTimer = null;
let pendingChanges = false;

// ---------- helpers ----------
function now() { return Date.now(); }

function loadTopicNames() {
  try {
    if (fs.existsSync(TOPIC_NAMES_FILE)) {
      const raw = fs.readFileSync(TOPIC_NAMES_FILE, 'utf8');
      topicNames = JSON.parse(raw);
      console.log('[hud] loaded topic names:', Object.keys(topicNames.topics || {}).length, 'topics,', Object.keys(topicNames.directs || {}).length, 'directs');
    }
  } catch (e) {
    console.warn('[hud] failed to load topic names:', e.message);
  }
}

function getSessionLabel(s) {
  const key = s.key || '';
  const kind = s.kind || s.chatType || '';
  
  // Parse kind from session key if not set
  let effKind = kind;
  if (!effKind) {
    if (key.includes('cron:')) effKind = 'cron';
    else if (key.includes('telegram:')) effKind = 'telegram';
    else if (key.includes('discord:')) effKind = 'discord';
    else if (key.includes(':admin')) effKind = 'admin';
    else if (key.endsWith(':main')) effKind = 'main';
    else effKind = 'direct';
  }
  
  if (effKind === 'cron' || key.includes('cron:')) {
    const cronId = key.split(':').pop();
    const cronName = topicNames.cron && topicNames.cron[cronId];
    if (cronName) return 'cron — ' + cronName;
    return 'cron';
  }
  
  if (effKind === 'telegram' || key.includes('telegram:')) {
    if (key.includes('group')) {
      const groupId = (key.match(/group:(-?\d+)/) || [])[1];
      const groupName = (topicNames.groups && topicNames.groups[groupId]) || 'Dispatch Topics';
      
      if (key.includes('topic:')) {
        const topicId = (key.match(/topic:(\d+)/) || [])[1];
        const topicName = topicNames.topics && topicNames.topics[topicId];
        if (topicName) return groupName + ' — ' + topicName;
        return groupName + ' — topic ' + topicId;
      }
      return groupName;
    }
    
    if (key.includes('direct') || key.includes('default')) {
      const userId = key.split(':').pop();
      const userName = topicNames.directs && topicNames.directs[userId];
      if (userName) return 'telegram — ' + userName + ' (Direct)';
      return 'telegram — direct';
    }
    
    if (key.includes('slash')) {
      return 'telegram — slash command';
    }
    
    return 'telegram';
  }
  
  if (effKind === 'discord' || key.includes('discord:')) {
    return 'discord';
  }
  
  if (effKind === 'admin' || key.includes(':admin')) {
    return 'admin console';
  }
  
  if (key.includes('subagent')) {
    return 'spawn-child';
  }
  
  if (effKind === 'main' || key.endsWith(':main')) {
    return 'main — dispatch direct';
  }
  
  return effKind;
}

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.floor((now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

function elapsed(ms) {
  if (!ms) return '-';
  const s = Math.floor((now() - ms) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return m + 'm ' + rem + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function fmtTokens(n) {
  if (!n || n < 0) return '-';
  if (n < 1000) return n + '';
  if (n < 1000000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

// ---------- agent name matching ----------
const AGENT_NAME_PATTERNS = [
  { id: 'editor', pattern: /\bYou are the editor\b/i },
  { id: 'dev-lead', pattern: /\bYou are the dev[\s-]?lead\b/i },
  { id: 'devops', pattern: /\bYou are the devops\b/i },
  { id: 'security-reviewer', pattern: /\bYou are the security[\s-]?reviewer\b/i },
  { id: 'writer', pattern: /\bYou are the writer\b/i },
  { id: 'philosopher', pattern: /\bYou are the philosopher\b/i },
  { id: 'art-director', pattern: /\bYou are the art[\s-]?director\b/i },
  { id: 'creative-reviewer', pattern: /\bYou are the creative[\s-]?reviewer\b/i },
  { id: 'tax-assistant', pattern: /\bYou are the tax[\s-]?assistant\b/i },
  { id: 'tax-reviewer', pattern: /\bYou are the tax[\s-]?reviewer\b/i },
  { id: 'ux-researcher', pattern: /\bYou are the ux[\s-]?researcher\b/i },
  { id: 'pm-impact-analyst', pattern: /\bYou are the pm[\s-]?impact[\s-]?analyst\b/i },
  { id: 'main', pattern: /\bYou are (dispatch|the main|the coordinator)\b/i },
];

function extractAgentFromTask(text) {
  if (!text) return null;
  for (const { id, pattern } of AGENT_NAME_PATTERNS) {
    if (pattern.test(text)) return id;
  }
  // Broader match: look for any configured agent name
  for (const a of agents) {
    if (a.id === 'main') continue;
    const namePattern = new RegExp('\\b' + a.id.replace(/-/g, '[\\s-]?') + '\\b', 'i');
    if (namePattern.test(text)) return a.id;
  }
  return null;
}

function extractTaskDescription(text) {
  if (!text) return null;
  // Find [Subagent Task] block
  const marker = '[Subagent Task]';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // Not a subagent task message, return first 300 chars
    return text.substring(0, MAX_TASK_DESC_LEN).trim();
  }
  // Get text after the marker
  let desc = text.substring(idx + marker.length).trim();
  // Remove leading whitespace/newlines
  desc = desc.replace(/^\s+/, '');
  // Cut at next section marker if present
  const nextMarker = desc.indexOf('\n\n[');
  if (nextMarker > 0) {
    desc = desc.substring(0, nextMarker);
  }
  // Truncate
  if (desc.length > MAX_TASK_DESC_LEN) {
    desc = desc.substring(0, MAX_TASK_DESC_LEN) + '...';
  }
  return desc.trim();
}

// ---------- heartbeat detection ----------
// Read the last few KB of a transcript to check if the last user message was a heartbeat poll.
// Returns { isHeartbeat: bool, lastRealActivity: number|null }
// lastRealActivity is the timestamp (ms) of the last non-heartbeat message, or null if N/A.
function checkHeartbeat(sessionKey, sessionId) {
  if (!sessionId) return { isHeartbeat: false, lastRealActivity: null };
  
  const agentId = sessionKey ? (sessionKey.split(':')[1] || 'main') : 'main';
  const transcriptDir = path.join(AGENTS_DIR, agentId, 'sessions');
  let transcriptPath = path.join(transcriptDir, sessionId + '.jsonl');
  
  if (!fs.existsSync(transcriptPath)) {
    const files = fs.readdirSync(transcriptDir).filter(f => f.startsWith(sessionId) && f.endsWith('.jsonl') && !f.includes('trajectory'));
    if (files.length > 0) {
      transcriptPath = path.join(transcriptDir, files[0]);
    } else {
      return { isHeartbeat: false, lastRealActivity: null };
    }
  }
  
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(16384, stat.size);
    const fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    
    const text = buffer.toString('utf8');
    const lines = text.split('\n').filter(l => l.trim());
    
    let lastUserWasHeartbeat = false;
    let lastRealTimestamp = null;
    
    // Scan from the end for user messages
    let userMsgCount = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'message' && entry.message && entry.message.role === 'user') {
          const content = entry.message.content;
          let textContent = '';
          if (typeof content === 'string') {
            textContent = content;
          } else if (Array.isArray(content)) {
            textContent = content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
          }
          const isHB = textContent.includes('[OpenClaw heartbeat poll]') || textContent.includes('heartbeat');
          
          if (userMsgCount === 0) {
            // Most recent user message
            lastUserWasHeartbeat = isHB;
          }
          
          if (!isHB) {
            // Found a real user message — capture its timestamp
            const ts = entry.timestamp || entry.ts || entry.createdAt;
            if (ts) {
              lastRealTimestamp = new Date(ts).getTime();
            }
            break; // Stop after first non-heartbeat user message
          }
          userMsgCount++;
        }
      } catch (e) { continue; }
    }
    
    return { isHeartbeat: lastUserWasHeartbeat, lastRealActivity: lastRealTimestamp };
  } catch (e) {
    return { isHeartbeat: false, lastRealActivity: null };
  }
}

// Backward-compat shim for any callers expecting the old boolean return
function isHeartbeatActive(sessionKey, sessionId) {
  return checkHeartbeat(sessionKey, sessionId).isHeartbeat;
}

// ---------- transcript peek ----------
function peekTranscriptTask(sessionKey, sessionId) {
  if (!sessionId) return null;
  
  // Check cache first
  if (taskCache[sessionId]) {
    return taskCache[sessionId];
  }
  
  // Determine which agent directory this session belongs to
  const agentId = sessionKey ? (sessionKey.split(':')[1] || 'main') : 'main';
  const transcriptDir = path.join(AGENTS_DIR, agentId, 'sessions');
  
  // Try finding the transcript file — it may have a topic suffix
  let transcriptPath = path.join(transcriptDir, sessionId + '.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    // Try with topic suffix pattern
    const files = fs.readdirSync(transcriptDir).filter(f => f.startsWith(sessionId) && f.endsWith('.jsonl') && !f.includes('trajectory'));
    if (files.length > 0) {
      transcriptPath = path.join(transcriptDir, files[0]);
    } else {
      return null;
    }
  }
  
  try {
    // Read first 8KB of the file to find the first user message
    const fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);
    
    const text = buffer.toString('utf8', 0, bytesRead);
    const lines = text.split('\n');
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        // Look for user message with actual content
        if (entry.type === 'message' && entry.message && entry.message.role === 'user') {
          const content = entry.message.content;
          let textContent = '';
          if (typeof content === 'string') {
            textContent = content;
          } else if (Array.isArray(content)) {
            textContent = content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
          }
          if (textContent && textContent.trim()) {
            const taskDesc = extractTaskDescription(textContent);
            const agentId = extractAgentFromTask(textContent);
            const result = { taskDesc, agentId, cachedAt: now() };
            taskCache[sessionId] = result;
            return result;
          }
        }
      } catch (e) {
        // Skip unparseable lines
        continue;
      }
    }
  } catch (e) {
    // File read error, just return null
    return null;
  }
  
  return null;
}

// ---------- data sources ----------

function loadAgents() {
  try {
    const raw = execSync(OPENCLAW + ' agents list --json', {
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, { PATH: '/usr/bin:/usr/local/bin:' + (process.env.PATH || '') })
    });
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
    console.log('[hud] loaded ' + agents.length + ' agents');
  } catch (e) {
    console.warn('[hud] failed to load agents:', e.message);
  }
}

function loadVersion() {
  try {
    const raw = execSync(OPENCLAW + ' status --json', {
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, { PATH: '/usr/bin:/usr/local/bin:' + (process.env.PATH || '') })
    });
    const parsed = JSON.parse(raw);
    const ver = parsed && (parsed.runtimeVersion || parsed.version);
    if (ver) {
      openclawVersion = ver;
      versionChecked = true;
      console.log('[hud] OpenClaw version: ' + ver);
    }
  } catch (e) {
    console.warn('[hud] failed to check version:', e.message);
  }
}

const EXPECTED_SESSION_KEYS = ['updatedAt', 'sessionId', 'totalTokens', 'model', 'inputTokens', 'outputTokens', 'contextTokens', 'modelOverride', 'startedAt', 'endedAt', 'runtimeMs', 'status'];

function validateSessionEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const hasKey = EXPECTED_SESSION_KEYS.some(k => k in entry);
  return hasKey;
}

function stripSession(entry, key) {
  const meta = {};
  for (const k of EXPECTED_SESSION_KEYS) {
    if (k in entry) meta[k] = entry[k];
  }
  // Extract agentId from session key
  if (!meta.agentId && key) {
    const parts = key.split(':');
    if (parts.length >= 2 && parts[0] === 'agent') {
      meta.agentId = parts[1];
    }
  }
  // Extract model from modelOverride
  if (!meta.model && entry.modelOverride) {
    const parts = entry.modelOverride.split('/');
    meta.model = parts[parts.length - 1] || entry.modelOverride;
  }
  // Derive kind from key
  if (key) {
    const parts = key.split(':');
    if (parts.length >= 3) {
      meta.kind = parts[2];
    }
  }
  meta.key = key;
  return meta;
}

function loadSessionStore() {
  // Read session stores from ALL agent directories, not just main
  let allSessions = {};
  let anyExists = false;
  let anyParseError = false;
  
  try {
    const agentDirs = fs.readdirSync(AGENTS_DIR).filter(d => {
      const stat = fs.statSync(path.join(AGENTS_DIR, d));
      return stat.isDirectory() && d !== 'default';
    });
    
    for (const agentDir of agentDirs) {
      const storePath = path.join(AGENTS_DIR, agentDir, 'sessions', 'sessions.json');
      if (!fs.existsSync(storePath)) continue;
      
      anyExists = true;
      try {
        const raw = fs.readFileSync(storePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          continue;
        }
        
        for (const [key, entry] of Object.entries(parsed)) {
          if (validateSessionEntry(entry)) {
            const stripped = stripSession(entry, key);
            // Override agentId based on the directory name
            stripped.agentId = agentDir;
            allSessions[key] = stripped;
          }
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          anyParseError = true;
          // File may be mid-write, skip this agent
          continue;
        }
      }
    }
    
    if (Object.keys(allSessions).length > 0) formatError = null;
    return { exists: anyExists, sessions: allSessions, parseError: anyParseError };
  } catch (e) {
    console.warn('[hud] failed to read session stores:', e.message);
    return { exists: false, sessions: {} };
  }
}

function diffSessions(oldSessions, newSessions) {
  const changed = [];
  const removed = [];
  for (const [key, entry] of Object.entries(newSessions)) {
    const old = oldSessions[key];
    if (!old || old.updatedAt !== entry.updatedAt) {
      changed.push(entry);
    }
  }
  for (const key of Object.keys(oldSessions)) {
    if (!(key in newSessions)) {
      removed.push(key);
    }
  }
  return { changed, removed };
}

// ---------- state building ----------

function buildState() {
  const now_ms = now();
  const agentSessions = {};
  const comms = [];

  // Group sessions by agent
  for (const [key, s] of Object.entries(sessions)) {
    const aid = s.agentId || 'main';
    if (!agentSessions[aid]) agentSessions[aid] = [];
    agentSessions[aid].push(s);
  }

  // Track last activity per agent (from task agent identity)
  const agentLastActivity = {};

  // Unified Active Work panel — ALL sessions with recent activity
  // spawn-child sessions get task descriptions from transcript peek
  // direct/group/cron sessions get session kind and context
  const recentSessions = Object.values(sessions)
    .filter(s => s.updatedAt && (now_ms - s.updatedAt) < RECENT_THRESHOLD)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const activeWork = [];

  for (const s of recentSessions) {
    const age = s.updatedAt ? (now_ms - s.updatedAt) : Infinity;
    const isActive = age < ACTIVE_THRESHOLD;
    const isRecent = age < RECENT_THRESHOLD;
    
    // Skip sessions where the last activity was just a heartbeat poll
    // (but still count them in fleet via checkHeartbeat's lastRealActivity)
    const hbInfo = checkHeartbeat(s.key, s.sessionId);
    if (hbInfo.isHeartbeat) continue;
    
    let status = 'completed';
    if (isActive) status = 'active';
    else if (isRecent) status = 'recent';

    const isSubagent = s.kind === 'subagent' || (s.key && s.key.includes('subagent'));
    
    // Peek transcript for subagent sessions to get task description
    let taskDesc = null;
    let taskAgentId = null;
    if (isSubagent) {
      const taskInfo = peekTranscriptTask(s.key, s.sessionId);
      taskDesc = taskInfo?.taskDesc || '(no task description found)';
      taskAgentId = taskInfo?.agentId || null;

      // Track last activity for the dispatched agent
      if (taskAgentId && s.updatedAt) {
        if (!agentLastActivity[taskAgentId] || s.updatedAt > agentLastActivity[taskAgentId]) {
          agentLastActivity[taskAgentId] = s.updatedAt;
        }
      }

      // Build comms entry for subagent spawns
      if (s.updatedAt) {
        comms.push({
          time: s.updatedAt,
          from: s.agentId || 'main',
          to: taskAgentId || 'sub-agent',
          kind: 'spawn',
          ago: ago(s.updatedAt),
        });
      }
    } else {
      taskDesc = getSessionLabel(s);
      taskAgentId = s.agentId || 'main';
    }

    activeWork.push({
      key: s.key,
      sessionId: s.sessionId,
      agentId: taskAgentId || s.agentId || 'main',
      taskDesc: taskDesc,
      isSubagent: isSubagent,
      status: status,
      tokens: s.totalTokens || 0,
      inputTokens: s.inputTokens || 0,
      outputTokens: s.outputTokens || 0,
      model: s.model || 'unknown',
      updatedAt: s.updatedAt || 0,
      elapsed: elapsed(s.startedAt || s.updatedAt),
      startedAt: s.startedAt || s.updatedAt,
      kind: s.kind || 'direct',
    });
  }

  // Build fleet with last activity
  const fleet = agents.map(a => {
    const ses = agentSessions[a.id] || [];
    const totalTokens = ses.reduce((sum, s) => sum + (s.totalTokens || 0), 0);
    
    // Find last non-heartbeat activity
    let lastActive = null;
    for (const s of ses) {
      if (!s.updatedAt) continue;
      // Check if this session's last activity was a heartbeat poll
      const hb = checkHeartbeat(s.key, s.sessionId);
      if (hb.isHeartbeat) {
        // Session's last user msg was a heartbeat — use the last REAL activity instead
        const realTs = hb.lastRealActivity;
        if (realTs && (!lastActive || realTs > lastActive)) lastActive = realTs;
        continue;
      }
      if (!lastActive || s.updatedAt > lastActive) lastActive = s.updatedAt;
    }
    // Also consider dispatch comms (spawn activity)
    const lastTaskActivity = agentLastActivity[a.id] || null;
    lastActive = Math.max(lastActive || 0, lastTaskActivity || 0) || null;

    let status = 'idle';
    if (lastActive) {
      const age = now_ms - lastActive;
      if (age < ACTIVE_THRESHOLD) status = 'active';
      else if (age < RECENT_THRESHOLD) status = 'recent';
    }

    return {
      id: a.id,
      name: a.name,
      model: a.model,
      emoji: a.identityEmoji,
      identityName: a.identityName,
      status,
      sessions: ses.length,
      tokens: totalTokens,
      lastActive,
      lastActiveAgo: lastActive ? ago(lastActive) : 'never',
    };
  });

  // Sort comms by time desc
  comms.sort((a, b) => (b.time || 0) - (a.time || 0));

  // All sessions for the sessions panel
  const allSessions = Object.values(sessions)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(s => ({
      key: s.key,
      sessionId: s.sessionId,
      agentId: s.agentId || 'main',
      kind: s.kind || 'direct',
      tokens: s.totalTokens || 0,
      inputTokens: s.inputTokens || 0,
      outputTokens: s.outputTokens || 0,
      model: s.model || 'unknown',
      updatedAt: s.updatedAt || 0,
      ageAgo: ago(s.updatedAt),
      status: s.updatedAt ? ((now_ms - s.updatedAt) < ACTIVE_THRESHOLD ? 'active' : ((now_ms - s.updatedAt) < RECENT_THRESHOLD ? 'recent' : 'completed')) : 'unknown',
    }));

  return {
    agents: fleet,
    activeWork,
    comms,
    sessions: allSessions,
    now: now_ms,
    version: openclawVersion,
    formatError,
    counts: {
      totalSessions: allSessions.length,
      activeWork: activeWork.length,
      agents: fleet.length,
    },
  };
}

// ---------- SSE ----------

function sseSend(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  } catch (e) {
    // client gone
  }
}

function broadcast(event, data) {
  for (const res of sseClients) {
    sseSend(res, event, data);
  }
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

  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    pendingChanges = false;

    const result = loadSessionStore();
    if (!result.exists) {
      if (sseClients.size > 0) {
        broadcast('gateway-offline', { message: 'Gateway is offline. Restart with: openclaw gateway restart' });
      }
      return;
    }

    if (result.parseError) {
      changeTimer = setTimeout(processStoreChange, 200);
      pendingChanges = true;
      return;
    }

    if (result.sessions === null) {
      return;
    }

    const oldSessions = sessions;
    sessions = result.sessions;

    // Invalidate task cache for sessions that have changed
    const diff = diffSessions(oldSessions, result.sessions);
    for (const changed of diff.changed) {
      if (changed.sessionId) {
        delete taskCache[changed.sessionId];
      }
    }

    if (sseClients.size > 0) {
      broadcastFullState();
    }
  }, 300);
}

function startWatcher() {
  // Watch session stores for ALL agent directories
  try {
    const agentDirs = fs.readdirSync(AGENTS_DIR).filter(d => {
      const stat = fs.statSync(path.join(AGENTS_DIR, d));
      return stat.isDirectory() && d !== 'default';
    });
    
    for (const agentDir of agentDirs) {
      const storePath = path.join(AGENTS_DIR, agentDir, 'sessions', 'sessions.json');
      if (fs.existsSync(storePath)) {
        try {
          fs.watch(storePath, (eventType) => {
            if (eventType === 'change' || eventType === 'rename') {
              processStoreChange();
            }
          });
          console.log('[hud] watching session store:', storePath);
        } catch (e) {
          console.warn('[hud] fs.watch failed for', storePath, ':', e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[hud] failed to enumerate agent dirs for watching:', e.message);
  }
  
  // Watch topic names file for live updates
  try {
    fs.watch(TOPIC_NAMES_FILE, () => {
      loadTopicNames();
      if (sseClients.size > 0) broadcastFullState();
    });
    console.log('[hud] watching topic names:', TOPIC_NAMES_FILE);
  } catch (e) {
    // topic names file optional
  }
}

// ---------- CLI polling fallback ----------

function pollCli() {
  try {
    const raw = execSync(OPENCLAW + ' sessions list --json', {
      encoding: 'utf8',
      timeout: 15000,
      env: Object.assign({}, process.env, { PATH: '/usr/bin:/usr/local/bin:' + (process.env.PATH || '') })
    });
    const parsed = JSON.parse(raw);

    if (!parsed || !Array.isArray(parsed.sessions)) {
      console.warn('[hud] CLI poll: unexpected format');
      return;
    }

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
          startedAt: cliSession.startedAt,
          endedAt: cliSession.endedAt,
          runtimeMs: cliSession.runtimeMs,
          status: cliSession.status,
        };
        // Invalidate task cache for changed sessions
        if (cliSession.sessionId) {
          delete taskCache[cliSession.sessionId];
        }
        changed = true;
      }
    }

    if (changed && sseClients.size > 0) {
      broadcastFullState();
    }
  } catch (e) {
    if (sseClients.size > 0 && !fs.existsSync(MAIN_SESSION_STORE)) {
      broadcast('gateway-offline', { message: 'Gateway is offline. Restart with: openclaw gateway restart' });
    }
  }
}

// ---------- HTTP server ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const pathname = url.pathname;

  // SSE endpoint
  if (pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    sendFullState(res);

    if (!fs.existsSync(MAIN_SESSION_STORE)) {
      sseSend(res, 'gateway-offline', { message: 'Gateway is offline. Restart with: openclaw gateway restart' });
    }

    if (!versionChecked) {
      loadVersion();
    }
    if (openclawVersion) {
      sseSend(res, 'version', { version: openclawVersion });
    }

    sseClients.add(res);
    console.log('[hud] SSE client connected (' + sseClients.size + ' total)');

    req.on('close', () => {
      sseClients.delete(res);
      console.log('[hud] SSE client disconnected (' + sseClients.size + ' remaining)');
    });

    return;
  }

  // Static files
  let filepath = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(__dirname, 'public', filepath);

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
  console.log('[hud] Dispatch HUD v2 starting...');
  console.log('[hud] session store:', SESSION_STORE);
  console.log('[hud] transcript dir:', TRANSCRIPT_DIR);

  loadAgents();
  loadVersion();
  loadTopicNames();

  const result = loadSessionStore();
  if (result.exists && result.sessions) {
    sessions = result.sessions;
    console.log('[hud] loaded ' + Object.keys(sessions).length + ' sessions');
  } else if (!result.exists) {
    console.log('[hud] session store not found (gateway may be offline)');
  }

  startWatcher();
  setInterval(pollCli, POLL_INTERVAL);

  server.listen(PORT, HOST, () => {
    console.log('[hud] listening on http://' + HOST + ':' + PORT);
    console.log('[hud] ' + agents.length + ' agents, ' + Object.keys(sessions).length + ' sessions');
    if (openclawVersion) {
      console.log('[hud] OpenClaw ' + openclawVersion);
    }
  });
}

process.on('SIGTERM', () => {
  console.log('[hud] shutting down...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[hud] shutting down...');
  server.close(() => process.exit(0));
});

startup();
