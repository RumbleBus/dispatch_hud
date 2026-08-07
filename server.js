// Dispatch HUD v3 — Task-Centric Operational Dashboard
// Zero npm dependencies. Node.js builtins only.
// Reads sessions.json + peeks transcript first-user-messages for spawn-child sessions.
// v3: Scans parent transcripts for comms (spawn/send instructions) + task board grouping.

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
const RECENT_THRESHOLD = 900000;  // 15min since last update = recent
const STALE_THRESHOLD = 86400000; // 24h since last update = stale (non-responsive)
const MAX_TASK_DESC_LEN = 300;

// Agent category mapping
const AGENT_CATEGORIES = {
  orchestrator: ['main'],
  planners: ['planner'],
  producers: ['writer', 'dev-lead', 'art-director', 'tax-assistant', 'devops', 'ui-designer'],
  critics: ['philosopher', 'security-reviewer', 'editor', 'creative-reviewer', 'tax-reviewer', 'qa-reviewer'],
  researchers: ['ux-researcher', 'pm-impact-analyst'],
};

// Perth AWST = UTC+8. Returns the UTC ms timestamp of the start of today in Perth.
function getPerthDayStart() {
  const now = new Date();
  const perthOffsetMs = 8 * 60 * 60 * 1000;
  const perthNow = new Date(now.getTime() + perthOffsetMs);
  perthNow.setHours(0, 0, 0, 0);
  return perthNow.getTime() - perthOffsetMs;
}
const TOPIC_NAMES_FILE = path.join(__dirname, 'topic-names.json');
let topicNames = { topics: {}, directs: {}, groups: {}, cron: {} };

// ---------- state ----------
let agents = [];
let sessions = {};       // key -> session metadata
let taskCache = {};       // sessionId -> { taskDesc, agentName, cachedAt }
let heartbeatCache = {};  // sessionId -> { isHeartbeat, lastRealActivity, cachedAt }
let commsCache = {};      // transcriptPath -> { mtime, comms: [...] }
let taskBoardCache = {};  // parentSessionId -> { mtime, tasks: [...] }
const HEARTBEAT_CACHE_TTL = 10000; // 10s — heartbeat status doesn't change fast
const COMMS_SCAN_MAX_AGE = 86400000; // 24h — only scan transcripts modified in last 24h
const COMMS_MAX_PER_SESSION = 50;  // max comms entries per transcript
const TASK_TEXT_MAX = 50000; // max chars of instruction text to include
const MAX_COMMS = 500;    // max total comms entries in payload
let openclawVersion = null;
let versionChecked = false;
let formatError = null;
let sseClients = new Set();
let changeTimer = null;
let pendingChanges = false;
let buildInProgress = false; // lock to prevent concurrent buildState calls

// ---------- transcript watcher state (Increment 4: real-time progress) ----------
let watchedTranscripts = new Map(); // transcriptPath -> { watcher, lastMtime }
let lastCommsSentTime = new Map();   // transcriptPath -> ms timestamp of last sent comms entry
let commsUpdateDebounce = null;
let pendingTranscriptChanges = new Set();
let transcriptPollTimer = null;

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
        if (topicName) return topicName;
        return 'topic ' + topicId;
      }
      return 'General';
    }
    
    if (key.includes('direct') || key.includes('default')) {
      const userId = key.split(':').pop();
      const userName = topicNames.directs && topicNames.directs[userId];
      if (userName) return 'Dispatch';
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
  
  // Check cache first
  const cached = heartbeatCache[sessionId];
  if (cached && (Date.now() - cached.cachedAt) < HEARTBEAT_CACHE_TTL) {
    return { isHeartbeat: cached.isHeartbeat, lastRealActivity: cached.lastRealActivity };
  }
  
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
    
    const result = { isHeartbeat: lastUserWasHeartbeat, lastRealActivity: lastRealTimestamp };
    heartbeatCache[sessionId] = { ...result, cachedAt: Date.now() };
    return result;
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

// ---------- noise reply detection ----------
// Single function to detect noise replies: NO_REPLY, HEARTBEAT_OK, heartbeat status patterns,
// and internal narration that shouldn't appear in the comms feed.
function isNoiseReply(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  // Direct matches
  if (lower === 'no_reply' || lower === 'heartbeat_ok') return true;

  // Any text under 200 chars that ends with NO_REPLY (case-insensitive, trimmed)
  if (trimmed.length < 200 && lower.endsWith('no_reply')) return true;

  // Single-word status replies — standalone or followed by NO_REPLY
  // Catches: "Quiet.", "Nothing.", "Still quiet.", "Still nothing.",
  // "Quiet hours.", "Same state.", "Nothing new.", "Day logged. Quiet."
  const statusRegex = /^(quiet\.?|nothing\.?|nothing\s+new\.?|still\s+quiet\.?|still\s+nothing\.?|quiet\s+hours\.?|same\s+state\.?|day\s+logged\.?\s*quiet\.?)\s*(\n*no_reply)?$/i;
  if (statusRegex.test(trimmed)) return true;

  // Internal narration (not user-facing replies)
  if (/^(now |let me |good |done |found |better |spawns |the )/i.test(trimmed)) return true;

  return false;
}

// ---------- transcript comms scanner ----------
// Scans parent session transcripts for sessions_spawn, sessions_send, 
// user messages (from Eric), and inter-session messages (sub-agent responses)
// to build a comms feed + task board.

async function scanTranscriptForComms(transcriptPath) {
  let stat;
  try {
    stat = await fs.promises.stat(transcriptPath);
  } catch (e) {
    return []; // file doesn't exist or can't stat
  }
  
  if (stat.mtimeMs < now() - COMMS_SCAN_MAX_AGE) return []; // skip old files
  
  // Check cache (sync, fast path — no async needed if cache hit)
  const cached = commsCache[transcriptPath];
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.comms;
  }
  
  const comms = [];
  try {
    const content = await fs.promises.readFile(transcriptPath, 'utf8');
    const lines = content.split('\n');
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message') continue;
        const msg = entry.message;
        if (!msg) continue;
        const role = msg.role;
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : (msg.timestamp || 0);
        
        // --- Extract assistant tool calls (spawn/send) ---
        if (role === 'assistant') {
          const content = msg.content;
          if (!Array.isArray(content)) continue;
          
          for (const item of content) {
            if (!item || item.type !== 'toolCall') continue;
            const toolName = item.name;
            const args = item.arguments || {};
            
            if (toolName === 'sessions_spawn') {
              const agentId = args.agentId || 'default';
              const taskText = (args.task || '').slice(0, TASK_TEXT_MAX);
              comms.push({
                time: ts,
                from: 'main',
                to: agentId,
                kind: 'spawn',
                instruction: taskText,
                label: args.label || '',
                taskName: args.taskName || '',
                ago: ago(ts),
              });
            } else if (toolName === 'sessions_send') {
              const target = args.sessionKey || args.label || '';
              const messageText = (args.message || '').slice(0, TASK_TEXT_MAX);
              let toAgent = 'unknown';
              if (target) {
                const parts = target.split(':');
                if (parts.length >= 2 && parts[0] === 'agent') {
                  toAgent = parts[1];
                }
              }
              comms.push({
                time: ts,
                from: 'main',
                to: toAgent,
                kind: 'send',
                instruction: messageText,
                target: target,
                ago: ago(ts),
              });
            }
          }
        }
        
        // --- Extract assistant text responses (Dispatch's replies) ---
        if (role === 'assistant') {
          const content = msg.content;
          if (!Array.isArray(content)) continue;
          
          for (const item of content) {
            if (!item || item.type !== 'text') continue;
            const text = (item.text || '').trim();
            if (!text) continue;
            // Skip noise replies (NO_REPLY, heartbeat status, internal narration)
            if (isNoiseReply(text)) continue;
            
            comms.push({
              time: ts,
              from: 'main',
              to: 'user',
              kind: 'reply',
              instruction: text.slice(0, TASK_TEXT_MAX),
              ago: ago(ts),
            });
            break; // Only first text block per assistant turn
          }
        }
        
        // --- Extract user messages (from Eric, not inter-session) ---
        if (role === 'user') {
          const content = msg.content;
          let textContent = '';
          if (typeof content === 'string') {
            textContent = content;
          } else if (Array.isArray(content)) {
            textContent = content
              .filter(c => c && c.type === 'text')
              .map(c => c.text)
              .join('\n');
          }
          
          if (!textContent.trim()) continue;
          // Skip heartbeat polls
          if (textContent.includes('[OpenClaw heartbeat poll]')) continue;
          if (textContent.trim() === '[OpenClaw heartbeat poll]') continue;
          
          // Route inter-session messages to the response handler below
          if (textContent.includes('[Inter-session message]')) {
            // Extract source session
            const sourceMatch = textContent.match(/sourceSession=([^\s]+)/);
            const sourceSession = sourceMatch ? sourceMatch[1] : 'unknown';
            
            let fromAgent = 'sub-agent';
            if (sourceSession) {
              const parts = sourceSession.split(':');
              if (parts.length >= 2 && parts[0] === 'agent') {
                fromAgent = parts[1];
              }
            }
            
            let responseText = '';
            const beginIdx = textContent.indexOf('<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>');
            const endIdx = textContent.indexOf('<<<END_UNTRUSTED_CHILD_RESULT>>>');
            if (beginIdx >= 0 && endIdx >= 0) {
              responseText = textContent.substring(beginIdx + '<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>'.length, endIdx).trim();
            } else {
              const ctxEnd = textContent.indexOf('<<<END_OPENCLAW_INTERNAL_CONTEXT>>>');
              if (ctxEnd >= 0) {
                responseText = textContent.substring(ctxEnd + '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>'.length).trim();
              } else {
                const linesArr = textContent.split('\n');
                responseText = linesArr.slice(3).join('\n').trim();
              }
            }
            
            const isCompletion = textContent.includes('[Internal task completion event]');
            
            const statsMatch = textContent.match(/Stats: (.+?)$/m);
            const stats = statsMatch ? statsMatch[1].trim() : '';
            
            comms.push({
              time: ts,
              from: fromAgent,
              to: 'main',
              kind: isCompletion ? 'response' : 'announce',
              instruction: (responseText || '(no response text)').slice(0, TASK_TEXT_MAX),
              sourceSession: sourceSession,
              stats: stats,
              ago: ago(ts),
            });
            continue;
          }
          
          // Skip other internal context
          if (textContent.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')) continue;
          if (textContent.startsWith('Conversation info')) continue;
          if (textContent.startsWith('Sender (untrusted')) continue;
          
          // Strip conversation metadata prefixes
          let cleanText = textContent;
          cleanText = cleanText.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```/g, '').trim();
          cleanText = cleanText.replace(/Sender \(untrusted metadata\):[\s\S]*?```/g, '').trim();
          cleanText = cleanText.replace(/Conversation context \(untrusted[\s\S]*?```/g, '').trim();
          
          if (cleanText.length < 2) continue;
          
          comms.push({
            time: ts,
            from: 'user',
            to: 'main',
            kind: 'user',
            instruction: cleanText.slice(0, TASK_TEXT_MAX),
            ago: ago(ts),
          });
        }
      } catch (e) { continue; }
    }
    
    // ─── Threading: assign sequential id and parentId ───
    // Assign sequential ids (c0, c1, c2...) scoped to this transcript scan
    for (let i = 0; i < comms.length; i++) {
      comms[i].id = 'c' + i;
    }

    // Build lookup: ts → reply id (for matching spawns/sends to their reply)
    const replyByTs = {};
    for (const c of comms) {
      if (c.kind === 'reply' && c.time) {
        replyByTs[c.time] = c.id;
      }
    }

    // Assign parentId based on kind and temporal relationships
    let lastUserId = null;   // id of most recent user message
    let lastReplyId = null;  // id of most recent reply

    for (const c of comms) {
      switch (c.kind) {
        case 'user':
          c.parentId = null; // root
          lastUserId = c.id;
          break;
        case 'reply':
          c.parentId = lastUserId; // most recent user message before it
          lastReplyId = c.id;
          break;
        case 'spawn':
        case 'send':
          // parentId = reply entry with same ts (same assistant turn)
          if (c.time && replyByTs[c.time]) {
            c.parentId = replyByTs[c.time];
          } else {
            c.parentId = lastReplyId; // fallback: most recent reply
          }
          break;
        case 'response':
        case 'announce':
          // parentId = most recent spawn where spawn.to === response.from and spawn.time < response.time
          {
            let bestSpawn = null;
            for (const other of comms) {
              if (other.kind === 'spawn' && other.to === c.from && other.time && c.time && other.time < c.time) {
                if (!bestSpawn || other.time > bestSpawn.time) {
                  bestSpawn = other;
                }
              }
            }
            c.parentId = bestSpawn ? bestSpawn.id : null;
          }
          break;
        default:
          c.parentId = null;
      }
    }

    // Sort by time descending, limit per session
    comms.sort((a, b) => (b.time || 0) - (a.time || 0));
    
    // Limit user messages per session to prevent domination
    const userCount = comms.filter(c => c.kind === 'user').length;
    if (userCount > 10) {
      const limited = [];
      let userSeen = 0;
      for (const c of comms) {
        if (c.kind === 'user') {
          userSeen++;
          if (userSeen > 10) continue;
        }
        limited.push(c);
      }
      comms.length = 0;
      comms.push(...limited);
    }
    
    // Enforce overall per-session limit
    if (comms.length > COMMS_MAX_PER_SESSION) {
      comms.length = COMMS_MAX_PER_SESSION;
    }
  } catch (e) {
    return [];
  }
  
  // Cache and return
  commsCache[transcriptPath] = { mtime: stat.mtimeMs, comms };
  return comms;
}

// Find transcript file for a session
function findTranscriptFile(agentId, sessionId) {
  const dir = path.join(AGENTS_DIR, agentId, 'sessions');
  if (!fs.existsSync(dir)) return null;
  
  // Try exact match first
  const exact = path.join(dir, sessionId + '.jsonl');
  if (fs.existsSync(exact)) return exact;
  
  // Try with topic suffix (sessionId-topic-N.jsonl), exclude trajectory files
  // Return the most recently modified match
  try {
    const files = fs.readdirSync(dir).filter(f =>
      f.startsWith(sessionId) && f.endsWith('.jsonl') && !f.includes('trajectory')
    );
    if (files.length === 0) return null;
    
    // Find file with most recent mtime
    let bestFile = files[0];
    let bestMtime = 0;
    for (const f of files) {
      try {
        const fStat = fs.statSync(path.join(dir, f));
        if (fStat.mtimeMs > bestMtime) {
          bestMtime = fStat.mtimeMs;
          bestFile = f;
        }
      } catch (e) {}
    }
    return path.join(dir, bestFile);
  } catch (e) {}
  
  return null;
}

// Extract last tool-call activity from a transcript (for live "working..." indicator)
function extractLastActivity(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(16384, stat.size);
    const fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    
    const text = buffer.toString('utf8');
    const lines = text.split('\n').filter(l => l.trim());
    
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== 'message') continue;
        const msg = entry.message;
        if (!msg || msg.role !== 'assistant') continue;
        const content = msg.content;
        if (!Array.isArray(content)) continue;
        
        for (let j = content.length - 1; j >= 0; j--) {
          const item = content[j];
          if (!item || item.type !== 'toolCall') continue;
          const toolName = item.name || 'unknown';
          const args = item.arguments || {};
          let desc = '';
          if (toolName === 'exec') {
            desc = (args.command || '').split('\n')[0].slice(0, 80);
          } else if (toolName === 'read' || toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch') {
            desc = args.path || '';
          } else if (toolName === 'web_search') {
            desc = args.query || '';
          } else if (toolName === 'web_fetch') {
            desc = args.url || '';
          } else if (toolName === 'sessions_spawn') {
            desc = args.agentId || args.taskName || 'spawn';
          } else if (toolName === 'sessions_send') {
            desc = args.sessionKey || '';
          } else if (toolName === 'image' || toolName === 'pdf') {
            desc = (args.path || args.url || '').slice(0, 80);
          } else {
            desc = toolName;
          }
          return { tool: toolName, desc: desc.slice(0, 100) };
        }
      } catch (e) { continue; }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Build task board: groups spawn comms by parent session
function buildTaskBoard(allComms, sessions) {
  // allComms: array of { time, from, to, kind, instruction, ago, parentSessionId, parentLabel }
  // sessions: the global sessions object (key -> session metadata)
  const tasks = {};
  
  for (const c of allComms) {
    if (c.kind !== 'spawn') continue;
    
    const parentId = c.parentSessionId;
    if (!parentId) continue;
    
    if (!tasks[parentId]) {
      tasks[parentId] = {
        sessionId: parentId,
        parentKey: c.parentKey || '',
        label: c.parentLabel || 'Unknown',
        goal: c.instruction ? c.instruction.slice(0, 150) : '',
        spawns: [],
        agents: {},
        totalSpawns: 0,
        completedSpawns: 0,
        activeSpawns: 0,
        errorSpawns: 0,
        iterations: 0,
        lastActivity: 0,
        firstSpawn: c.time || 0,
      };
    }
    
    tasks[parentId].spawns.push(c);
    tasks[parentId].totalSpawns++;
    tasks[parentId].lastActivity = Math.max(tasks[parentId].lastActivity, c.time || 0);
    tasks[parentId].firstSpawn = Math.min(tasks[parentId].firstSpawn, c.time || Infinity);
    if (tasks[parentId].firstSpawn === Infinity) tasks[parentId].firstSpawn = c.time || 0;
    
    // Track per-agent counts
    const agent = c.to;
    if (!tasks[parentId].agents[agent]) {
      tasks[parentId].agents[agent] = { count: 0, lastTime: 0 };
    }
    tasks[parentId].agents[agent].count++;
    tasks[parentId].agents[agent].lastTime = Math.max(tasks[parentId].agents[agent].lastTime, c.time || 0);
  }
  
  // Convert to array, check completion status for each spawn
  const taskList = Object.values(tasks).map(t => {
    // Count unique agents
    t.agentList = Object.entries(t.agents).map(([id, info]) => ({
      id, count: info.count, lastTime: info.lastTime
    })).sort((a, b) => b.lastTime - a.lastTime);
    t.uniqueAgents = t.agentList.length;
    t.maxIterations = Math.max(...t.agentList.map(a => a.count), 0);
    
    // Check completion by looking up child sessions in the session store
    let completed = 0;
    let active = 0;
    let errors = 0;
    for (const spawn of t.spawns) {
      const spawnTime = spawn.time;
      const agentId = spawn.to;

      // Search sessions for matching child session: agent:AGENTID:subagent:*
      let matchedSession = null;
      let bestDiff = Infinity;

      for (const [sKey, sEntry] of Object.entries(sessions || {})) {
        // Must be a subagent session for the right agent
        if (!sKey.startsWith('agent:' + agentId + ':subagent:')) continue;

        // Match by start time proximity (within 30-second window)
        const sessionStart = sEntry.startedAt || sEntry.createdAt || sEntry.updatedAt || 0;
        if (!sessionStart || !spawnTime) continue;

        const diff = Math.abs(sessionStart - spawnTime);
        if (diff < bestDiff && diff <= 30000) {
          bestDiff = diff;
          matchedSession = sEntry;
        }
      }

      if (matchedSession) {
        // Found matching session — use its actual status
        if (matchedSession.endedAt || matchedSession.status === 'ended') {
          completed++;
        } else if (matchedSession.status === 'error') {
          errors++;
          completed++; // error sessions are also done
        } else {
          // No endedAt and status is active/running → still active
          active++;
        }
      } else {
        // No matching session found — fall back to age heuristic (120s)
        if (spawnTime) {
          const age = now() - spawnTime;
          if (age < 120000) {
            active++;
          } else {
            completed++;
          }
        } else {
          completed++;
        }
      }
    }
    t.completedSpawns = completed;
    t.activeSpawns = active;
    t.errorSpawns = errors;
    t.progress = t.totalSpawns > 0 ? Math.round((completed / t.totalSpawns) * 100) : 0;
    t.elapsed = elapsed(t.firstSpawn);
    t.lastActivityAgo = ago(t.lastActivity);
    
    return t;
  });
  
  // Sort by last activity descending
  taskList.sort((a, b) => b.lastActivity - a.lastActivity);
  
  // Strip spawns array from payload — client doesn't use it
  for (const t of taskList) {
    delete t.spawns;
  }
  
  return taskList;
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

// ---------- cache eviction ----------
// Caps a cache object to maxEntries by deleting oldest entries (by mtime or cachedAt).
function evictCache(cache, maxEntries) {
  const keys = Object.keys(cache);
  if (keys.length <= maxEntries) return;
  // Sort by mtime (or cachedAt fallback), oldest first
  keys.sort((a, b) => {
    const aTime = cache[a].mtime || cache[a].cachedAt || 0;
    const bTime = cache[b].mtime || cache[b].cachedAt || 0;
    return aTime - bTime;
  });
  const toRemove = keys.length - maxEntries;
  for (let i = 0; i < toRemove; i++) {
    delete cache[keys[i]];
  }
}

async function buildState() {
  if (buildInProgress) return null;
  buildInProgress = true;
  try {
  // Evict stale cache entries to prevent unbounded growth
  evictCache(commsCache, 100);
  evictCache(taskBoardCache, 100);

  const now_ms = now();
  const agentSessions = {};

  // ---------- Scan parent transcripts for comms (spawn/send instructions) ----------
  const STALE_CUTOFF = now_ms - COMMS_SCAN_MAX_AGE;
  
  // First pass: collect transcript paths and metadata (sync)
  const scanJobs = [];
  for (const [key, s] of Object.entries(sessions)) {
    // Only scan main agent sessions that aren't spawn-child or cron
    if (s.kind === 'spawn-child' || s.kind === 'subagent') continue;
    if (s.key && s.key.includes('subagent:')) continue;
    if (s.kind === 'cron') continue;
    // Skip other agents' main sessions (heartbeat-only, like agent:editor:main)
    if (s.key && /^agent:(?!main\b)[^:]+:main$/.test(s.key)) continue;
    if (!s.updatedAt || s.updatedAt < STALE_CUTOFF) continue;
    
    const transcriptPath = findTranscriptFile(s.agentId || 'main', s.sessionId);
    if (!transcriptPath) continue;
    
    const parentLabel = getSessionLabel(s);
    scanJobs.push({ session: s, transcriptPath, parentLabel });
  }
  
  // Scan all transcripts in parallel (async)
  const scanResults = await Promise.all(
    scanJobs.map(async (job) => {
      const sessionComms = await scanTranscriptForComms(job.transcriptPath);
      return { job, sessionComms };
    })
  );
  
  // Collect results
  const allComms = [];
  for (const { job, sessionComms } of scanResults) {
    if (sessionComms.length === 0) continue;
    for (const c of sessionComms) {
      c.parentSessionId = job.session.sessionId;
      c.parentLabel = job.parentLabel;
      c.parentKey = job.session.key;
      allComms.push(c);
    }
  }
  
  // Sort all comms by time descending
  allComms.sort((a, b) => (b.time || 0) - (a.time || 0));
  
  // Limit total comms to prevent payload bloat
  const displayComms = allComms.slice(0, MAX_COMMS);
  
  // Re-compute ago values for display
  for (const c of displayComms) {
    c.ago = ago(c.time);
  }

  // Build task board from comms
  const taskBoard = buildTaskBoard(allComms, sessions);

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

      // Fallback: extract agent ID from session key if transcript peek didn't find it
      // Session key format: agent:<agentId>:subagent:<uuid>
      if (!taskAgentId && s.key) {
        const keyParts = s.key.split(':');
        if (keyParts.length >= 3 && keyParts[0] === 'agent' && keyParts[2] === 'subagent') {
          taskAgentId = keyParts[1];
        }
      }

      // Track last activity for the dispatched agent
      if (taskAgentId && s.updatedAt) {
        if (!agentLastActivity[taskAgentId] || s.updatedAt > agentLastActivity[taskAgentId]) {
          agentLastActivity[taskAgentId] = s.updatedAt;
        }
      }

      // Comms are now built from transcript scanning, not from session metadata
    } else {
      taskDesc = getSessionLabel(s);
      taskAgentId = s.agentId || 'main';
    }

    // For active sessions, extract last tool-call activity for live indicator
    let lastActivity = null;
    if (isActive) {
      const activityAgentId = isSubagent ? (taskAgentId || s.agentId || 'main') : (s.agentId || 'main');
      const tp = findTranscriptFile(activityAgentId, s.sessionId);
      if (tp) {
        lastActivity = extractLastActivity(tp);
      }
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
      lastActivity: lastActivity,
    });
  }

  // Build fleet with last activity
  const fleet = agents.flatMap(a => {
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
    // Also consider dispatch comms (spawn activity) — use comms spawn timestamps
    const lastTaskActivity = agentLastActivity[a.id] || null;
    // Also check comms data for spawn timestamps to this agent
    let lastCommActivity = null;
    for (const c of displayComms) {
      if (c.to === a.id && c.time) {
        if (!lastCommActivity || c.time > lastCommActivity) lastCommActivity = c.time;
      }
    }
    lastActive = Math.max(lastActive || 0, lastTaskActivity || 0, lastCommActivity || 0) || null;

    let status = 'idle';
    if (lastActive) {
      const age = now_ms - lastActive;
      if (age < ACTIVE_THRESHOLD) status = 'active';
      else if (age < RECENT_THRESHOLD) status = 'recent';
      else if (age < STALE_THRESHOLD) status = 'idle';
      else status = 'stale';
    }

    // Determine category
    let category = 'producers';
    for (const [cat, ids] of Object.entries(AGENT_CATEGORIES)) {
      if (ids.includes(a.id)) { category = cat; break; }
    }

    const baseAgent = {
      id: a.id,
      name: a.name,
      model: a.model,
      emoji: a.identityEmoji,
      identityName: a.identityName,
      status,
      category,
      sessions: ses.length,
      tokens: totalTokens,
      lastActive,
      lastActiveAgo: lastActive ? ago(lastActive) : 'never',
    };

    // For the orchestrator (main), expand into multiple cards: one per active topic/session
    if (a.id === 'main') {
      const topicCards = [];
      const mainSessions = ses.filter(s => s.updatedAt && (now_ms - s.updatedAt) < STALE_THRESHOLD);
      for (const s of mainSessions) {
        const label = getSessionLabel(s);
        // Skip subagent sessions and admin/slash sessions
        if (s.key && s.key.includes('subagent:')) continue;
        if (s.key && (s.key.includes(':admin') || s.key.includes('slash:'))) continue;
        if (s.key && s.key.includes('reasoning-probe')) continue;
        // Skip cron sessions — not shown as orbit cores
        if (s.key && s.key.includes('cron:')) continue;
        // Skip internal main session — redundant with Telegram DM
        if (s.key === 'agent:main:main') continue;

        // Check heartbeat for this session
        const hb = checkHeartbeat(s.key, s.sessionId);
        let sessionTs = s.updatedAt;
        if (hb.isHeartbeat && hb.lastRealActivity) {
          sessionTs = hb.lastRealActivity;
        }
        if (!sessionTs) continue;

        const sessionAge = now_ms - sessionTs;
        let sessionStatus = 'idle';
        if (sessionAge < ACTIVE_THRESHOLD) sessionStatus = 'active';
        else if (sessionAge < RECENT_THRESHOLD) sessionStatus = 'recent';
        else if (sessionAge < STALE_THRESHOLD) sessionStatus = 'idle';
        else sessionStatus = 'stale';

        topicCards.push({
          ...baseAgent,
          id: 'main',
          topicKey: s.key,
          topicLabel: label,
          status: sessionStatus,
          sessions: 1,
          tokens: s.totalTokens || 0,
          lastActive: sessionTs,
          lastActiveAgo: ago(sessionTs),
        });
      }
      // Sort topic cards by lastActive desc
      topicCards.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
      return topicCards;
    }

    return [baseAgent];
  });

  // Comms are now built from transcript scanning above (displayComms)

  // All sessions for the sessions panel
  // Only send sessions the UI actually uses (active work + comms are already separate arrays)
  // The sessions panel is not rendered, so skip sending 140 items of payload bloat
  const sessionCount = Object.keys(sessions).length;

    // Update transcript watchers for active sessions (Increment 4)
    const activeTranscriptPaths = new Set();
    for (const w of activeWork) {
      if (w.status === 'active') {
        const tp = findTranscriptFile(w.agentId || 'main', w.sessionId);
        if (tp) activeTranscriptPaths.add(tp);
      }
    }
    for (const t of taskBoard) {
      if (t.activeSpawns > 0) {
        const tp = findTranscriptFile('main', t.sessionId);
        if (tp) activeTranscriptPaths.add(tp);
      }
    }
    updateTranscriptWatchers(activeTranscriptPaths);

    const _result = {
      agents: fleet,
      activeWork,
      comms: displayComms,
      taskBoard,
      sessions: [],  // UI doesn't render this; skip the bloat
      now: now_ms,
      version: openclawVersion,
      formatError,
      counts: {
        totalSessions: sessionCount,
        activeWork: activeWork.length,
        agents: fleet.length,
        comms: displayComms.length,
        tasks: taskBoard.length,
      },
      dailyTokens: (() => {
        const dayStart = getPerthDayStart();
        let total = 0;
        for (const s of Object.values(sessions)) {
          if (s.updatedAt && s.updatedAt >= dayStart) {
            total += (s.totalTokens || 0);
          }
        }
        return total;
      })(),
      categories: AGENT_CATEGORIES,
    };
    return _result;
  } catch (e) {
    console.error('[hud] buildState error:', e);
    return null;
  } finally {
    buildInProgress = false;
  }
}

// ---------- SSE ----------

function sseSend(res, event, data) {
  try {
    const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    if (!res.write(payload)) {
      // Backpressure — wait for drain before continuing
      res.once('drain', () => {});
    }
  } catch (e) {
    // client gone
  }
}

function broadcast(event, data) {
  for (const res of sseClients) {
    sseSend(res, event, data);
  }
}

async function sendFullState(res) {
  const state = await buildState();
  if (state) sseSend(res, 'state', state);
}

// SSE keepalive — prevents proxy/browser from dropping idle connections
const SSE_KEEPALIVE_MS = 15000; // 15s
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      sseClients.delete(res);
    }
  }
}, SSE_KEEPALIVE_MS);

async function broadcastFullState() {
  const state = await buildState();
  if (state) broadcast('state', state);
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
      pendingChanges = false;
      changeTimer = setTimeout(processStoreChange, 200);
      return;
    }

    if (result.sessions === null) {
      return;
    }

    const oldSessions = sessions;
    sessions = result.sessions;

    // Invalidate caches for sessions that have changed
    const diff = diffSessions(oldSessions, result.sessions);
    for (const changed of diff.changed) {
      if (changed.sessionId) {
        delete taskCache[changed.sessionId];
        delete heartbeatCache[changed.sessionId];
      }
    }
    // Clear comms cache so transcript changes are picked up on next buildState
    commsCache = {};

    if (sseClients.size > 0) {
      broadcastFullState();
      // Also broadcast sessions update for the sessions view
      broadcast('sessions-update', { sessions: buildSessionSummaries() });
    }
  }, 300);
}

// ---------- transcript watcher (Increment 4: incremental comms updates) ----------

function updateTranscriptWatchers(activePaths) {
  const currentPaths = new Set(watchedTranscripts.keys());
  
  // Remove watchers for paths no longer active
  for (const [p, info] of watchedTranscripts) {
    if (!activePaths.has(p)) {
      try { info.watcher.close(); } catch (e) {}
      watchedTranscripts.delete(p);
      lastCommsSentTime.delete(p);
    }
  }
  
  // Add watchers for new active paths
  for (const p of activePaths) {
    if (watchedTranscripts.has(p)) continue;
    try {
      const stat = fs.statSync(p);
      const watcher = fs.watch(p, (eventType) => {
        if (eventType === 'change') {
          pendingTranscriptChanges.add(p);
          scheduleCommsUpdate();
        }
      });
      watcher.on('error', () => {
        try { watcher.close(); } catch (e) {}
        watchedTranscripts.delete(p);
      });
      watchedTranscripts.set(p, { watcher, lastMtime: stat.mtimeMs });
      
      // Initialize baseline: use cached comms max time, or current time
      const cached = commsCache[p];
      if (cached && cached.comms.length > 0) {
        const maxTime = Math.max(...cached.comms.map(c => c.time || 0));
        lastCommsSentTime.set(p, maxTime);
      } else {
        lastCommsSentTime.set(p, Date.now());
      }
    } catch (e) {
      // Can't watch this file, skip
    }
  }
}

function scheduleCommsUpdate() {
  if (commsUpdateDebounce) return;
  commsUpdateDebounce = setTimeout(async () => {
    commsUpdateDebounce = null;
    const changed = Array.from(pendingTranscriptChanges);
    pendingTranscriptChanges.clear();
    
    if (changed.length === 0 || sseClients.size === 0) return;
    
    // Clear comms cache for changed files so they get rescanned
    for (const p of changed) {
      delete commsCache[p];
    }
    
    const newComms = [];
    const activities = {};
    
    for (const transcriptPath of changed) {
      // Find session this transcript belongs to
      let sessionId = null;
      let parentSessionId = null;
      let parentLabel = null;
      let parentKey = null;
      
      for (const [key, s] of Object.entries(sessions)) {
        const tp = findTranscriptFile(s.agentId || 'main', s.sessionId);
        if (tp === transcriptPath) {
          sessionId = s.sessionId;
          if (!key.includes('subagent:')) {
            parentSessionId = s.sessionId;
            parentLabel = getSessionLabel(s);
            parentKey = s.key;
          }
          break;
        }
      }
      
      // Extract last tool-call activity for this transcript
      if (sessionId) {
        const activity = extractLastActivity(transcriptPath);
        if (activity) {
          activities[sessionId] = activity;
        }
      }
      
      // Scan for new comms (only for parent sessions)
      if (!parentSessionId) continue;
      
      const comms = await scanTranscriptForComms(transcriptPath);
      const lastSent = lastCommsSentTime.get(transcriptPath) || 0;
      
      const fresh = comms.filter(c => (c.time || 0) > lastSent);
      for (const c of fresh) {
        c.parentSessionId = parentSessionId;
        c.parentLabel = parentLabel;
        c.parentKey = parentKey;
        c.ago = ago(c.time);
        newComms.push(c);
      }
      
      if (fresh.length > 0) {
        const maxTime = Math.max(...fresh.map(c => c.time || 0));
        lastCommsSentTime.set(transcriptPath, maxTime);
      }
    }
    
    if (sseClients.size > 0 && (newComms.length > 0 || Object.keys(activities).length > 0)) {
      broadcast('comms-update', { comms: newComms, activities: activities });
    }
  }, 500);
}

// Fallback poll: check transcript mtimes every 3s (in case fs.watch misses events)
function startTranscriptPoll() {
  if (transcriptPollTimer) clearInterval(transcriptPollTimer);
  transcriptPollTimer = setInterval(() => {
    if (sseClients.size === 0) return;
    
    for (const [p, info] of watchedTranscripts) {
      try {
        const stat = fs.statSync(p);
        if (stat.mtimeMs > info.lastMtime) {
          info.lastMtime = stat.mtimeMs;
          pendingTranscriptChanges.add(p);
          scheduleCommsUpdate();
        }
      } catch (e) {
        // File might be gone, skip
      }
    }
  }, 3000);
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
  
  // Start transcript poll fallback (Increment 4)
  startTranscriptPoll();
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

// ---------- sessions API ----------

function buildSessionSummaries() {
  const now_ms = now();
  return Object.values(sessions)
    .map(s => {
      const age = s.updatedAt ? (now_ms - s.updatedAt) : Infinity;
      let status = 'completed';
      if (s.endedAt) status = 'completed';
      else if (age < ACTIVE_THRESHOLD) status = 'active';
      else if (age < RECENT_THRESHOLD) status = 'recent';
      else if (age < STALE_THRESHOLD) status = 'idle';
      else status = 'stale';

      const isSubagent = s.kind === 'subagent' || (s.key && s.key.includes('subagent:'));
      const hbInfo = checkHeartbeat(s.key, s.sessionId);
      
      let taskDesc = null;
      if (isSubagent) {
        const taskInfo = peekTranscriptTask(s.key, s.sessionId);
        taskDesc = taskInfo ? taskInfo.taskDesc : null;
      }

      return {
        session_id: s.sessionId,
        key: s.key,
        agent_id: s.agentId || 'main',
        label: getSessionLabel(s),
        kind: s.kind || 'direct',
        status,
        started: s.startedAt || null,
        last_activity: s.updatedAt || null,
        ended: s.endedAt || null,
        runtime_ms: s.runtimeMs || null,
        model: s.model || '',
        tokens: {
          total: s.totalTokens || 0,
          input: s.inputTokens || 0,
          output: s.outputTokens || 0,
          context: s.contextTokens || 0,
        },
        is_subagent: isSubagent,
        is_heartbeat: hbInfo.isHeartbeat,
        task_desc: taskDesc,
      };
    })
    .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
}

async function buildSessionDetail(sessionId) {
  let session = null;
  for (const s of Object.values(sessions)) {
    if (s.sessionId === sessionId) { session = s; break; }
  }
  if (!session) return null;

  const summaries = buildSessionSummaries();
  const summary = summaries.find(s => s.session_id === sessionId);
  if (!summary) return null;

  const agentId = session.agentId || 'main';
  const transcriptPath = findTranscriptFile(agentId, sessionId);
  let events = [];
  if (transcriptPath) {
    try {
      const comms = await scanTranscriptForComms(transcriptPath);
      events = comms.slice(0, 500).map(c => ({
        ts: c.time,
        type: c.kind,
        actor: c.from,
        target: c.to || null,
        summary: (c.instruction || '').slice(0, 200),
      }));
    } catch (e) {
      // transcript scan failed, return with empty events
    }
  }

  return Object.assign(summary, { events });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- HTTP server ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const pathname = url.pathname;

  // Sessions API
  if (pathname === '/api/sessions') {
    return sendJson(res, 200, { sessions: buildSessionSummaries() });
  }
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const rawId = sessionMatch[1];
    if (rawId.includes('..') || rawId.includes('/') || rawId.includes('\\')) {
      return sendJson(res, 400, { error: 'invalid path' });
    }
    const id = decodeURIComponent(rawId);
    buildSessionDetail(id).then(detail => {
      if (!detail) return sendJson(res, 404, { error: 'session not found' });
      sendJson(res, 200, detail);
    }).catch(e => sendJson(res, 500, { error: e.message }));
    return;
  }

  // SSE endpoint
  if (pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    res.socket?.setTimeout(0);

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
      'Content-Length': Buffer.byteLength(content),
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

function cleanupWatchers() {
  for (const [p, info] of watchedTranscripts) {
    try { info.watcher.close(); } catch (e) {}
  }
  watchedTranscripts.clear();
  if (transcriptPollTimer) clearInterval(transcriptPollTimer);
  if (commsUpdateDebounce) clearTimeout(commsUpdateDebounce);
}

process.on('SIGTERM', () => {
  console.log('[hud] shutting down...');
  cleanupWatchers();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[hud] shutting down...');
  cleanupWatchers();
  server.close(() => process.exit(0));
});

startup();
