#!/usr/bin/env node
'use strict';

// Dispatch HUD QA Diagnostic Script
// Zero npm dependencies — Node.js builtins only
// Usage: node qa.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HUD_HOST = 'localhost';
const HUD_PORT = 4400;
const AGENTS_DIR = path.join(os.homedir() || '/home/node', '.openclaw', 'agents');
const TOPIC_NAMES_FILE = path.join(__dirname, 'topic-names.json');

// Thresholds (must match server.js)
const ACTIVE_THRESHOLD = 60000;   // 60s
const RECENT_THRESHOLD = 300000;  // 5min
const STALE_THRESHOLD = 86400000; // 24h

// ---------- helpers ----------

function now() { return Date.now(); }

function fmtISO(ts) {
  return new Date(ts).toISOString().replace(/\.\d+Z$/, 'Z');
}

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.floor((now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// Load topic names for label validation
let topicNames = { topics: {}, directs: {}, groups: {}, cron: {} };
try {
  if (fs.existsSync(TOPIC_NAMES_FILE)) {
    topicNames = JSON.parse(fs.readFileSync(TOPIC_NAMES_FILE, 'utf8'));
  }
} catch (e) {
  // optional
}

// ---------- session label logic (mirrors server.js) ----------

function getSessionLabel(s) {
  const key = s.key || '';
  const kind = s.kind || s.chatType || '';

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
    if (key.includes('slash')) return 'telegram — slash command';
    return 'telegram';
  }

  if (effKind === 'discord' || key.includes('discord:')) return 'discord';
  if (effKind === 'admin' || key.includes(':admin')) return 'admin console';
  if (key.includes('subagent')) return 'spawn-child';
  if (effKind === 'main' || key.endsWith(':main')) return 'main — dispatch direct';

  return effKind;
}

// ---------- heartbeat detection (mirrors server.js) ----------

function checkHeartbeat(sessionKey, sessionId) {
  if (!sessionId) return { isHeartbeat: false, lastRealActivity: null };

  const agentId = sessionKey ? (sessionKey.split(':')[1] || 'main') : 'main';
  const transcriptDir = path.join(AGENTS_DIR, agentId, 'sessions');
  let transcriptPath = path.join(transcriptDir, sessionId + '.jsonl');

  if (!fs.existsSync(transcriptPath)) {
    try {
      const files = fs.readdirSync(transcriptDir).filter(f => f.startsWith(sessionId) && f.endsWith('.jsonl') && !f.includes('trajectory'));
      if (files.length > 0) {
        transcriptPath = path.join(transcriptDir, files[0]);
      } else {
        return { isHeartbeat: false, lastRealActivity: null };
      }
    } catch (e) {
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
            textContent = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          }
          const isHB = textContent.includes('[OpenClaw heartbeat poll]') || textContent.includes('heartbeat');

          if (userMsgCount === 0) {
            lastUserWasHeartbeat = isHB;
          }

          if (!isHB) {
            const ts = entry.timestamp || entry.ts || entry.createdAt;
            if (ts) {
              lastRealTimestamp = new Date(ts).getTime();
            }
            break;
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

// Backward compat shim
function isHeartbeatActive(sessionKey, sessionId) {
  return checkHeartbeat(sessionKey, sessionId).isHeartbeat;
}

// ---------- raw session store reading ----------

const EXPECTED_SESSION_KEYS = ['updatedAt', 'sessionId', 'totalTokens', 'model', 'inputTokens', 'outputTokens', 'contextTokens', 'modelOverride', 'startedAt', 'endedAt', 'runtimeMs', 'status'];

function validateSessionEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return EXPECTED_SESSION_KEYS.some(k => k in entry);
}

function stripSession(entry, key) {
  const meta = {};
  for (const k of EXPECTED_SESSION_KEYS) {
    if (k in entry) meta[k] = entry[k];
  }
  if (!meta.agentId && key) {
    const parts = key.split(':');
    if (parts.length >= 2 && parts[0] === 'agent') {
      meta.agentId = parts[1];
    }
  }
  if (!meta.model && entry.modelOverride) {
    const parts = entry.modelOverride.split('/');
    meta.model = parts[parts.length - 1] || entry.modelOverride;
  }
  if (key) {
    const parts = key.split(':');
    if (parts.length >= 3) {
      meta.kind = parts[2];
    }
  }
  meta.key = key;
  return meta;
}

function readAllSessionStores() {
  const allSessions = {};
  const perAgent = {};
  let agentDirs = [];

  try {
    agentDirs = fs.readdirSync(AGENTS_DIR).filter(d => {
      try {
        const stat = fs.statSync(path.join(AGENTS_DIR, d));
        return stat.isDirectory() && d !== 'default';
      } catch (e) { return false; }
    });
  } catch (e) {
    return { sessions: {}, perAgent: {}, agentDirs: [] };
  }

  for (const agentDir of agentDirs) {
    const storePath = path.join(AGENTS_DIR, agentDir, 'sessions', 'sessions.json');
    if (!fs.existsSync(storePath)) continue;

    let parsed;
    try {
      const raw = fs.readFileSync(storePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (e) {
      // skip unparseable (mid-write)
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    perAgent[agentDir] = 0;
    for (const [key, entry] of Object.entries(parsed)) {
      if (validateSessionEntry(entry)) {
        const stripped = stripSession(entry, key);
        stripped.agentId = agentDir;
        allSessions[key] = stripped;
        perAgent[agentDir]++;
      }
    }
  }

  return { sessions: allSessions, perAgent, agentDirs };
}

// ---------- SSE fetch ----------

function fetchHUDState() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: HUD_HOST,
      port: HUD_PORT,
      path: '/stream',
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' },
      timeout: 5000,
    }, (res) => {
      let buffer = '';
      const timer = setTimeout(() => {
        req.destroy();
        resolve({ ok: false, error: 'Timeout waiting for SSE data event' });
      }, 4000);

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        // Look for the first "data:" line with JSON payload
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            try {
              const data = JSON.parse(payload);
              clearTimeout(timer);
              req.destroy();
              resolve({ ok: true, data });
            } catch (e) {
              // not valid JSON yet, keep going
            }
          }
        }
      });

      res.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: e.message });
      });
    });

    req.on('error', (e) => {
      resolve({ ok: false, error: e.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Connection timeout' });
    });

    req.end();
  });
}

// ---------- QA checks ----------

function deriveStatus(updatedAt, nowMs) {
  if (!updatedAt) return 'completed';
  const age = nowMs - updatedAt;
  if (age < ACTIVE_THRESHOLD) return 'active';
  if (age < RECENT_THRESHOLD) return 'recent';
  return 'completed';
}

function isRawKind(label) {
  // Check if the label is just a raw kind string like "direct", "group", "subagent"
  const rawKinds = ['direct', 'group', 'subagent', 'cron', 'telegram', 'discord', 'admin', 'main'];
  return rawKinds.includes(label);
}

// ---------- main ----------

async function main() {
  const results = [];
  const nowMs = now();
  const reportTime = fmtISO(nowMs);

  console.log('Dispatch HUD QA Report — ' + reportTime);
  console.log('=====================================');

  // 1. Fetch HUD state
  const hudResult = await fetchHUDState();
  if (!hudResult.ok) {
    results.push({ status: 'FAIL', label: 'HUD server responding', detail: hudResult.error });
    // Can't do further checks without HUD data, but still read raw stores
    console.log('❌ FAIL  HUD server responding — ' + hudResult.error);
    console.log('     (Cannot cross-check without HUD data, reading raw stores only)');
  } else {
    results.push({ status: 'PASS', label: 'HUD server responding' });
    console.log('✅ PASS  HUD server responding');
  }

  // 2. Read all raw session stores
  const raw = readAllSessionStores();
  const rawSessionCount = Object.keys(raw.sessions).length;

  if (hudResult.ok) {
    const hudData = hudResult.data;
    const hudSessionCount = hudData.counts ? hudData.counts.totalSessions : (hudData.sessions ? hudData.sessions.length : 0);

    // 3. Session count check
    if (hudSessionCount === rawSessionCount) {
      results.push({ status: 'PASS', label: 'Session count', detail: hudSessionCount + ' (matches)' });
      console.log('✅ PASS  Session count: ' + hudSessionCount + ' (matches)');
    } else {
      results.push({ status: 'FAIL', label: 'Session count', detail: 'HUD=' + hudSessionCount + ' raw=' + rawSessionCount });
      console.log('❌ FAIL  Session count: HUD=' + hudSessionCount + ' vs raw=' + rawSessionCount);
    }

    // 4. Active Work check — all sessions updated < 5 min ago and not heartbeat should be in activeWork
    const expectedActive = [];
    for (const [key, s] of Object.entries(raw.sessions)) {
      if (!s.updatedAt) continue;
      const age = nowMs - s.updatedAt;
      if (age >= RECENT_THRESHOLD) continue;
      if (isHeartbeatActive(s.key, s.sessionId)) continue;
      expectedActive.push(key);
    }

    const hudActiveKeys = new Set((hudData.activeWork || []).map(w => w.key));
    const expectedActiveKeys = new Set(expectedActive);

    let activeMatch = true;
    let missingFromHUD = [];
    let extraInHUD = [];

    for (const k of expectedActiveKeys) {
      if (!hudActiveKeys.has(k)) {
        missingFromHUD.push(k);
      }
    }
    for (const k of hudActiveKeys) {
      if (!expectedActiveKeys.has(k)) {
        // Could be a heartbeat session that HUD wrongly included, or timing skew
        extraInHUD.push(k);
      }
    }

    if (missingFromHUD.length === 0 && extraInHUD.length === 0) {
      results.push({ status: 'PASS', label: 'Active work', detail: hudActiveKeys.size + ' items, all valid' });
      console.log('✅ PASS  Active work: ' + hudActiveKeys.size + ' items, all valid');
    } else {
      let detail = hudActiveKeys.size + ' items';
      if (missingFromHUD.length > 0) detail += ', ' + missingFromHUD.length + ' missing from HUD';
      if (extraInHUD.length > 0) detail += ', ' + extraInHUD.length + ' extra in HUD';
      results.push({ status: 'FAIL', label: 'Active work', detail });
      console.log('❌ FAIL  Active work: ' + detail);
      for (const k of missingFromHUD.slice(0, 3)) {
        const s = raw.sessions[k];
        console.log('         missing: ' + k + ' (updated ' + ago(s.updatedAt) + ')');
      }
      for (const k of extraInHUD.slice(0, 3)) {
        console.log('         extra: ' + k);
      }
    }

    // 5. Heartbeat filter check — find heartbeat sessions updated < 5 min ago and verify they're NOT in activeWork
    const heartbeatSessions = [];
    for (const [key, s] of Object.entries(raw.sessions)) {
      if (!s.updatedAt) continue;
      const age = nowMs - s.updatedAt;
      if (age >= RECENT_THRESHOLD) continue;
      if (isHeartbeatActive(s.key, s.sessionId)) {
        heartbeatSessions.push(key);
      }
    }

    let heartbeatFiltered = true;
    let heartbeatLeaks = [];
    for (const key of heartbeatSessions) {
      if (hudActiveKeys.has(key)) {
        heartbeatFiltered = false;
        heartbeatLeaks.push(key);
      }
    }

    if (heartbeatSessions.length === 0) {
      results.push({ status: 'PASS', label: 'Heartbeat filter', detail: 'no recent heartbeat sessions to check' });
      console.log('✅ PASS  Heartbeat filter: no recent heartbeat sessions to check');
    } else if (heartbeatFiltered) {
      results.push({ status: 'PASS', label: 'Heartbeat filter', detail: heartbeatSessions.length + ' heartbeat sessions correctly excluded' });
      console.log('✅ PASS  Heartbeat filter: ' + heartbeatSessions.length + ' heartbeat sessions correctly excluded');
    } else {
      results.push({ status: 'FAIL', label: 'Heartbeat filter', detail: heartbeatLeaks.length + ' heartbeat sessions in activeWork' });
      console.log('❌ FAIL  Heartbeat filter: ' + heartbeatLeaks.length + ' heartbeat sessions leaked into activeWork');
      for (const k of heartbeatLeaks.slice(0, 3)) {
        console.log('         leaked: ' + k);
      }
    }

    // 6. Agent fleet check — session counts and token totals per agent
    const hudAgents = hudData.agents || [];
    let fleetMismatches = [];

    for (const hudAgent of hudAgents) {
      const aid = hudAgent.id;
      const rawCount = raw.perAgent[aid] || 0;
      const hudCount = hudAgent.sessions || 0;

      if (hudCount !== rawCount) {
        fleetMismatches.push({
          agent: aid,
          field: 'sessionCount',
          hud: hudCount,
          raw: rawCount
        });
      }

      // Token total check
      let rawTokens = 0;
      for (const [key, s] of Object.entries(raw.sessions)) {
        if ((s.agentId || 'main') === aid) {
          rawTokens += (s.totalTokens || 0);
        }
      }
      const hudTokens = hudAgent.tokens || 0;
      if (hudTokens !== rawTokens) {
        fleetMismatches.push({
          agent: aid,
          field: 'tokens',
          hud: hudTokens,
          raw: rawTokens
        });
      }
    }

    // Check for agents in raw but not in HUD fleet
    for (const rawAgent of Object.keys(raw.perAgent)) {
      const found = hudAgents.find(a => a.id === rawAgent);
      if (!found) {
        fleetMismatches.push({
          agent: rawAgent,
          field: 'missing',
          hud: 'absent',
          raw: raw.perAgent[rawAgent]
        });
      }
    }

    if (fleetMismatches.length === 0) {
      results.push({ status: 'PASS', label: 'Agent fleet', detail: 'session counts and tokens match for all ' + hudAgents.length + ' agents' });
      console.log('✅ PASS  Agent fleet: session counts and tokens match for all ' + hudAgents.length + ' agents');
    } else {
      results.push({ status: 'FAIL', label: 'Agent fleet', detail: fleetMismatches.length + ' mismatches' });
      console.log('❌ FAIL  Agent fleet: ' + fleetMismatches.length + ' mismatches');
      for (const m of fleetMismatches.slice(0, 5)) {
        console.log('         ' + m.agent + ' ' + m.field + ': HUD=' + m.hud + ' raw=' + m.raw);
      }
    }

    // 7. Status derivation check — verify each activeWork item has correct status based on updatedAt
    let statusErrors = [];
    for (const item of (hudData.activeWork || [])) {
      const expectedStatus = deriveStatus(item.updatedAt, nowMs);
      if (item.status !== expectedStatus) {
        statusErrors.push({
          key: item.key,
          hudStatus: item.status,
          expectedStatus,
          age: item.updatedAt ? Math.floor((nowMs - item.updatedAt) / 1000) + 's' : 'unknown'
        });
      }
    }

    if (statusErrors.length === 0) {
      results.push({ status: 'PASS', label: 'Status derivation', detail: 'all activeWork statuses correct' });
      console.log('✅ PASS  Status derivation: all activeWork statuses correct');
    } else {
      results.push({ status: 'FAIL', label: 'Status derivation', detail: statusErrors.length + ' mismatches' });
      console.log('❌ FAIL  Status derivation: ' + statusErrors.length + ' mismatches');
      for (const e of statusErrors.slice(0, 3)) {
        console.log('         ' + e.key + ': HUD=' + e.hudStatus + ' expected=' + e.expectedStatus + ' (age ' + e.age + ')');
      }
    }

    // 8. Fleet status check — verify agent fleet statuses match raw data
    let fleetStatusErrors = [];
    for (const hudAgent of hudAgents) {
      // Recompute lastActive from raw data
      let lastActive = null;
      const aid = hudAgent.id;
      for (const [key, s] of Object.entries(raw.sessions)) {
        if ((s.agentId || 'main') !== aid) continue;
        if (!s.updatedAt) continue;
        if (isHeartbeatActive(s.key, s.sessionId)) continue;
        if (!lastActive || s.updatedAt > lastActive) lastActive = s.updatedAt;
      }

      // Fleet status uses 'idle' for old/no activity (not 'completed')
      let expectedFleetStatus = 'idle';
      if (lastActive) {
        const age = nowMs - lastActive;
        if (age < ACTIVE_THRESHOLD) expectedFleetStatus = 'active';
        else if (age < RECENT_THRESHOLD) expectedFleetStatus = 'recent';
        else if (age < STALE_THRESHOLD) expectedFleetStatus = 'idle';
        else expectedFleetStatus = 'stale';
      }
      if (hudAgent.status !== expectedFleetStatus) {
        fleetStatusErrors.push({
          agent: aid,
          hudStatus: hudAgent.status,
          expectedStatus: expectedFleetStatus,
          lastActive: lastActive ? ago(lastActive) : 'never'
        });
      }
    }

    if (fleetStatusErrors.length === 0) {
      results.push({ status: 'PASS', label: 'Fleet status', detail: 'all agent statuses match raw data' });
      console.log('✅ PASS  Fleet status: all agent statuses match raw data');
    } else {
      results.push({ status: 'FAIL', label: 'Fleet status', detail: fleetStatusErrors.length + ' mismatches' });
      console.log('❌ FAIL  Fleet status: ' + fleetStatusErrors.length + ' mismatches');
      for (const e of fleetStatusErrors.slice(0, 3)) {
        console.log('         Agent "' + e.agent + '": HUD=' + e.hudStatus + ' expected=' + e.expectedStatus + ' (last active ' + e.lastActive + ')');
      }
    }

    // 9. Session labels — check for raw kind labels in HUD sessions and activeWork
    let rawLabelSessions = [];

    // Check activeWork items
    for (const item of (hudData.activeWork || [])) {
      if (item.isSubagent) continue; // subagent items have task descriptions
      const label = item.taskDesc || '';
      if (isRawKind(label)) {
        rawLabelSessions.push({ key: item.key, label });
      }
    }

    // Check sessions list
    for (const s of (hudData.sessions || [])) {
      const label = getSessionLabel(s);
      if (isRawKind(label)) {
        // Only report if not already caught
        if (!rawLabelSessions.find(r => r.key === s.key)) {
          rawLabelSessions.push({ key: s.key, label });
        }
      }
    }

    if (rawLabelSessions.length === 0) {
      results.push({ status: 'PASS', label: 'Session labels', detail: 'all human-readable' });
      console.log('✅ PASS  Session labels: all human-readable');
    } else {
      results.push({ status: 'WARN', label: 'Session labels', detail: rawLabelSessions.length + ' sessions showing raw kind labels' });
      console.log('⚠️ WARN  Session labels: ' + rawLabelSessions.length + ' sessions showing raw kind labels');
      for (const r of rawLabelSessions.slice(0, 5)) {
        console.log('         ' + r.key + ' → "' + r.label + '"');
      }
    }

    // 10. Agent status with recent session not reflected — check each agent
    // Uses the same heartbeat filter logic as the HUD to avoid false positives
    let staleAgentWarnings = [];
    for (const hudAgent of hudAgents) {
      const aid = hudAgent.id;
      // Find most recent non-heartbeat session for this agent
      let mostRecent = null;
      let mostRecentKey = null;
      for (const [key, s] of Object.entries(raw.sessions)) {
        if ((s.agentId || 'main') !== aid) continue;
        if (!s.updatedAt) continue;
        // Skip heartbeat sessions (same logic as HUD)
        const hb = checkHeartbeat(key, s.sessionId);
        if (hb.isHeartbeat) {
          // Use last real activity if available
          if (hb.lastRealActivity && (!mostRecent || hb.lastRealActivity > mostRecent)) {
            mostRecent = hb.lastRealActivity;
            mostRecentKey = key + ' (real-act)';
          }
        } else if (!mostRecent || s.updatedAt > mostRecent) {
          mostRecent = s.updatedAt;
          mostRecentKey = key;
        }
      } // end for

      if (mostRecent) {
        const age = nowMs - mostRecent;
        if (age < ACTIVE_THRESHOLD && hudAgent.status !== 'active') {
          staleAgentWarnings.push({
            agent: aid,
            hudStatus: hudAgent.status,
            expected: 'active',
            sessionKey: mostRecentKey,
            age: Math.floor(age / 1000) + 's'
          });
        } else if (age >= ACTIVE_THRESHOLD && age < RECENT_THRESHOLD && hudAgent.status !== 'recent' && hudAgent.status !== 'active') {
          staleAgentWarnings.push({
            agent: aid,
            hudStatus: hudAgent.status,
            expected: 'recent',
            sessionKey: mostRecentKey,
            age: Math.floor(age / 1000) + 's'
          });
        }
      }
    }

    if (staleAgentWarnings.length === 0) {
      results.push({ status: 'PASS', label: 'Agent staleness', detail: 'no stale agents detected' });
      console.log('✅ PASS  Agent staleness: no stale agents detected');
    } else {
      results.push({ status: 'FAIL', label: 'Agent staleness', detail: staleAgentWarnings.length + ' stale agents' });
      console.log('❌ FAIL  Agent staleness: ' + staleAgentWarnings.length + ' stale agents');
      for (const w of staleAgentWarnings.slice(0, 5)) {
        console.log('         Agent "' + w.agent + '" shows ' + w.hudStatus + ' but has session updated ' + w.age + ' ago');
      }
    }

  } else {
    // HUD was down, just report raw session count
    console.log('     Raw session count: ' + rawSessionCount);
    console.log('     Agents: ' + Object.keys(raw.perAgent).join(', '));
    console.log('=====================================');
    console.log('Result: 0 PASS, 0 WARN, 1 FAIL');
    process.exit(1);
  }

  // Summary
  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;

  console.log('=====================================');
  console.log('Result: ' + pass + ' PASS, ' + warn + ' WARN, ' + fail + ' FAIL');

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('QA script crashed:', e.message);
  console.error(e.stack);
  process.exit(2);
});
