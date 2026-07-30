#!/bin/bash
# verify.sh — Post-deploy verification for Dispatch HUD
# Run after deploy to catch issues before the user checks.
# Exits non-zero on any failure.

set -euo pipefail
HOST="${1:-http://127.0.0.1:4400}"
PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

echo "=== Dispatch HUD Verification ==="
echo "Host: $HOST"
echo ""

# 1. Server responds with HTTP 200
echo "--- Server health ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HOST/" 2>/dev/null || true)
if [ "$HTTP_CODE" = "200" ]; then
  pass "HTTP 200 OK"
else
  fail "HTTP $HTTP_CODE (expected 200)"
fi

# 2. HTML contains closing tags and DISPATCH
echo "--- HTML structure ---"
HTML=$(curl -s --max-time 5 "$HOST/" 2>/dev/null || true)
if echo "$HTML" | grep -q '</html>'; then
  pass "Has </html>"
else
  fail "Missing </html>"
fi
if echo "$HTML" | grep -q 'DISPATCH'; then
  pass "Contains DISPATCH"
else
  fail "Missing DISPATCH text"
fi

# 3. Client-side JavaScript is syntactically valid
echo "--- Client JS syntax ---"
SCRIPT=$(echo "$HTML" | python3 -c "
import sys, re
h = sys.stdin.read()
m = re.search(r'<script>(.*?)</script>', h, re.DOTALL)
print(m.group(1) if m else '')
" 2>/dev/null || true)
if [ -n "$SCRIPT" ]; then
  JS_OK=$(node -e "
const s = require('child_process').execSync('cat',{input:process.argv[1],encoding:'utf8',maxBuffer:1024*1024});
try { new Function(process.argv[1]); console.log('ok'); } catch(e) { console.log('fail:'+e.message); }
" "$SCRIPT" 2>/dev/null || true)
  if echo "$JS_OK" | grep -q 'ok'; then
    pass "Client JS syntax valid"
  else
    fail "Client JS syntax error: $JS_OK"
  fi
else
  fail "No script block found in HTML"
fi

# 4. SSE stream delivers data
echo "--- SSE stream ---"
SSE=$(curl -s --max-time 6 "$HOST/stream" 2>/dev/null || true)
if echo "$SSE" | grep -q 'event: state'; then
  pass "SSE stream delivers state events"
else
  fail "SSE stream missing state events"
fi

# 5. State contains real agents
echo "--- Data quality ---"
if echo "$SSE" | grep -q '"agents"'; then
  pass "State has agents array"
else
  fail "State missing agents array"
fi
if echo "$SSE" | grep -q '"main"'; then
  pass "Contains main agent"
else
  fail "Missing main agent"
fi
if echo "$SSE" | grep -q '"sessions"'; then
  pass "State has sessions array"
else
  fail "State missing sessions array"
fi

# 6. No offline event
echo "--- No error states ---"
if echo "$SSE" | grep -q 'gateway-offline'; then
  fail "Gateway reported as offline"
else
  pass "Gateway is online"
fi

echo ""
echo "=== Results: $PASS pass, $FAIL fail ==="
[ "$FAIL" -eq 0 ] || exit 1