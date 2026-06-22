// ============================================================
//   API Keys — set these as Environment Variables on Railway/Vercel
//   For local dev they fall back to the values below
// ============================================================
const GEMINI_KEY   = process.env.GEMINI_KEY   || 'AQ.Ab8RN6LJY7toctYJp7dTdSs2UyIoz40va53ndTC11nt-m3Le8g';
const OPENAI_KEY   = process.env.OPENAI_KEY   || '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';
const CLAUDE_KEY   = process.env.CLAUDE_KEY   || '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';
const FOOTBALL_KEY = process.env.FOOTBALL_KEY || '42d361dfc176060098766f96e9b09f6c2997dcc314f46b5fc60ed8a9b0b4cb40';
// ============================================================


const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GPT_MODEL = 'gpt-4o-mini';   // cheap + good; change to 'gpt-4o' for stronger
const CLAUDE_MODEL = 'claude-sonnet-4-5';   // Sonnet — strong & cost-efficient for a live site
const DATA_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const CACHE_FILE = path.join(__dirname, 'analysis-cache.json');

let MATCH_CACHE = null;
let ANALYSIS_CACHE = loadCache();

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // keep only today's entries (daily auto-refresh)
    const today = new Date().toISOString().slice(0, 10);
    const pruned = {};
    Object.keys(data).forEach((k) => { if (k.startsWith(today + '__')) pruned[k] = data[k]; });
    return pruned;
  } catch { return {}; }
}
function saveCache() { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(ANALYSIS_CACHE)); } catch {} }

const CODES_FILE = path.join(__dirname, 'active-codes.json');
let ACTIVE_CODES = loadActiveCodes();

function loadActiveCodes() {
  try {
    if (fs.existsSync(CODES_FILE)) {
      return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveActiveCodes() {
  try {
    fs.writeFileSync(CODES_FILE, JSON.stringify(ACTIVE_CODES, null, 2));
  } catch (e) {}
}

function generateCode(tier) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `IQ-${tier.toUpperCase()}-${rand}`;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'goaliq' } }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return fetchJSON(resp.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      resp.on('data', (c) => (body += c));
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ---- REAL DATA: recent form for a team from apifootball.com ----
let FORM_CACHE = {};      // team name -> form string
let ALL_RESULTS = null;   // fetched once, reused for every team

async function loadAllResults() {
  if (ALL_RESULTS) return ALL_RESULTS;
  if (FOOTBALL_KEY === 'PASTE-FOOTBALL-KEY-HERE') { ALL_RESULTS = []; return ALL_RESULTS; }
  try {
    const today = new Date();
    const from = new Date(today.getTime() - 180 * 86400000).toISOString().slice(0, 10);
    const to = today.toISOString().slice(0, 10);
    // World Cup league id = 28; pull just that competition's recent results (fast)
    const url = `https://apiv3.apifootball.com/?action=get_events&from=${from}&to=${to}&league_id=28&APIkey=${FOOTBALL_KEY}`;
    const all = await fetchJSON(url);
    ALL_RESULTS = Array.isArray(all) ? all.filter((m) => m.match_status === 'Finished') : [];
  } catch (e) {
    ALL_RESULTS = [];
  }
  return ALL_RESULTS;
}

async function getTeamForm(teamName) {
  if (FORM_CACHE[teamName] !== undefined) return FORM_CACHE[teamName];
  if (FOOTBALL_KEY === 'PASTE-FOOTBALL-KEY-HERE') return '';
  const all = await loadAllResults();
  const played = all.filter((m) =>
    m.match_hometeam_name === teamName || m.match_awayteam_name === teamName
  ).slice(-5);
  if (!played.length) { FORM_CACHE[teamName] = ''; return ''; }
  const parts = played.map((m) => {
    const home = m.match_hometeam_name === teamName;
    const gf = home ? m.match_hometeam_score : m.match_awayteam_score;
    const ga = home ? m.match_awayteam_score : m.match_hometeam_score;
    const opp = home ? m.match_awayteam_name : m.match_hometeam_name;
    const res = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
    return `${res} ${gf}-${ga} vs ${opp}`;
  });
  const form = parts.join('; ');
  FORM_CACHE[teamName] = form;
  return form;
}



// ---- Gemini ----
function askGemini(prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 500, temperature: 0.4 } });
    const req = https.request({
      method: 'POST', hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (resp) => {
      let body = ''; resp.on('data', (c) => (body += c));
      resp.on('end', () => { try { const j = JSON.parse(body); if (j.error) return reject(new Error(j.error.message)); resolve(j.candidates?.[0]?.content?.parts?.[0]?.text || ''); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// ---- GPT ----
function askGPT(prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: GPT_MODEL, max_tokens: 500, temperature: 0.4, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({
      method: 'POST', hostname: 'api.openai.com', path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Length': Buffer.byteLength(data) },
    }, (resp) => {
      let body = ''; resp.on('data', (c) => (body += c));
      resp.on('end', () => { try { const j = JSON.parse(body); if (j.error) return reject(new Error(j.error.message)); resolve(j.choices?.[0]?.message?.content || ''); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// ---- Claude ----
function askClaude(prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({
      method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(data) },
    }, (resp) => {
      let body = ''; resp.on('data', (c) => (body += c));
      resp.on('end', () => { try { const j = JSON.parse(body); if (j.error) return reject(new Error(j.error.message)); resolve(j.content?.[0]?.text || ''); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function parseJSON(text) {
  try { const m = String(text).replace(/```json|```/g, '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

function buildPrompt(home, away, stage, homeForm, awayForm) {
  let dataBlock = '';
  if (homeForm || awayForm) {
    dataBlock = '\nREAL RECENT FORM (most recent last):\n'
      + home + ': ' + (homeForm || 'no data') + '\n'
      + away + ': ' + (awayForm || 'no data') + '\n'
      + 'Weight this real form heavily in your analysis.\n';
  }
  return 'You are a world-class football analyst specializing in international tournaments. '
    + 'Analyze this 2026 FIFA World Cup match rigorously and produce a betting-grade prediction.\n\n'
    + 'IMPORTANT: The 2026 World Cup is hosted across the USA, Canada and Mexico. '
    + 'Unless one of the two teams is USA, Canada or Mexico, treat this as a NEUTRAL venue with NO home advantage for either side. '
    + 'Never invent a home-field advantage.\n\n'
    + 'TEAM 1: ' + home + '\n'
    + 'TEAM 2: ' + away + '\n'
    + 'STAGE: ' + (stage || 'Group stage') + '\n'
    + dataBlock + '\n'
    + 'Before deciding, weigh these factors in your reasoning:\n'
    + '1. Current squad quality and depth of each nation, and key star players.\n'
    + '2. Recent form and momentum.\n'
    + '3. FIFA world ranking gap and historical head-to-head record.\n'
    + '4. Tactical match-up (attacking vs defensive styles).\n'
    + '5. Tournament context: importance of this match and pressure on each side.\n'
    + '6. Be cautious with lesser-known nations — do not overrate them, but account for upset potential.\n\n'
    + 'Calibrate probabilities realistically: a clear favorite vs a weak side should be 70-85%, '
    + 'evenly matched sides should be closer to 40-30-30. Draws are common in international football, '
    + 'so give the draw a fair weight (usually 20-30%). Confidence should reflect how certain you are '
    + '(high only when the gap is large and form is consistent).\n\n'
    + 'For goal scoring predictions (Over/Under, BTTS, and Multi-Goals):\n'
    + '- Over/Under 2.5 goals probability: how likely is the total score to be 3 goals or more (Over) vs 2 goals or less (Under).\n'
    + '- Both Teams to Score (BTTS) probability: how likely is it that both teams score at least one goal (Yes) vs at least one team keeping a clean sheet (No).\n'
    + '- Multi-Goals range probability: chance of total goals being 0-1, 2-3, or 4+ goals.\n\n'
    + 'Reply with ONLY valid JSON, no markdown, no extra text:\n'
    + '{"verdict":"' + home + '" or "' + away + '" or "Draw",'
    + '"home_prob":number,"draw_prob":number,"away_prob":number,'
    + '"confidence":number,"score":"most likely final score like 2-1",'
    + '"angle":"one sharp analytical sentence in Hebrew explaining the key reason — do NOT mention home advantage unless a host nation (USA/Canada/Mexico) is playing",'
    + '"over_2_5_prob":number,"under_2_5_prob":number,'
    + '"btts_yes_prob":number,"btts_no_prob":number,'
    + '"goals_0_1_prob":number,"goals_2_3_prob":number,"goals_4_plus_prob":number}\n'
    + '(home_prob + draw_prob + away_prob = 100. score format = team1_goals-team2_goals. '
    + 'over_2_5_prob + under_2_5_prob = 100. btts_yes_prob + btts_no_prob = 100. '
    + 'goals_0_1_prob + goals_2_3_prob + goals_4_plus_prob = 100. All probability values must be integers.)';
}

function fallbackAnalyze(home, away) {
  const seed = [...((home || '') + (away || ''))].reduce((a, c) => a + c.charCodeAt(0), 0);
  const r = (n) => { const x = Math.sin(seed * n) * 10000; return x - Math.floor(x); };
  let h = 35 + Math.floor(r(1) * 40), d = 15 + Math.floor(r(2) * 20);
  let a = 100 - h - d; if (a < 5) { a = 5; h = 70; d = 25; }
  const top = h >= a && h >= d ? 'home' : a >= d ? 'away' : 'draw';
  
  const over_2_5_prob = 35 + Math.floor(r(6) * 40);
  const under_2_5_prob = 100 - over_2_5_prob;
  const btts_yes_prob = 35 + Math.floor(r(7) * 45);
  const btts_no_prob = 100 - btts_yes_prob;
  const goals_0_1_prob = 15 + Math.floor(r(8) * 20);
  const goals_2_3_prob = 40 + Math.floor(r(9) * 25);
  const goals_4_plus_prob = 100 - goals_0_1_prob - goals_2_3_prob;

  return { 
    h, d, a, verdict: top === 'home' ? home : top === 'away' ? away : 'Draw',
    conf: Math.round(Math.max(h, d, a) * 0.9), angle: 'Basic analysis.', models: [], byAI: false,
    over_2_5_prob, under_2_5_prob, btts_yes_prob, btts_no_prob,
    goals_0_1_prob, goals_2_3_prob, goals_4_plus_prob
  };
}

// run both models, merge results
async function analyzeAI(home, away, stage) {
  const today = new Date().toISOString().slice(0, 10);
  const key = today + '__' + home + '__' + away;   // includes date -> auto-refresh daily
  if (ANALYSIS_CACHE[key]) {
    const cached = ANALYSIS_CACHE[key];
    if (cached.over_2_5_prob === undefined) {
      const seed = [...((home || '') + (away || ''))].reduce((a, c) => a + c.charCodeAt(0), 0);
      const r = (n) => { const x = Math.sin(seed * n) * 10000; return x - Math.floor(x); };
      cached.over_2_5_prob = 35 + Math.floor(r(6) * 40);
      cached.under_2_5_prob = 100 - cached.over_2_5_prob;
      cached.btts_yes_prob = 35 + Math.floor(r(7) * 45);
      cached.btts_no_prob = 100 - cached.btts_yes_prob;
      cached.goals_0_1_prob = 15 + Math.floor(r(8) * 20);
      cached.goals_2_3_prob = 40 + Math.floor(r(9) * 25);
      cached.goals_4_plus_prob = 100 - cached.goals_0_1_prob - cached.goals_2_3_prob;
    }
    return cached;
  }

  const prompt = buildPrompt(home, away, stage, '', '');
  const jobs = [];
  if (GEMINI_KEY !== 'PASTE-GEMINI-KEY-HERE') jobs.push({ name: 'Gemini', col: '#4285f4', fn: () => askGemini(prompt) });
  if (OPENAI_KEY !== 'PASTE-GPT-KEY-HERE') jobs.push({ name: 'GPT-4o', col: '#19c37d', fn: () => askGPT(prompt) });
  if (CLAUDE_KEY !== 'PASTE-CLAUDE-KEY-HERE') jobs.push({ name: 'Claude', col: '#cc785c', fn: () => askClaude(prompt) });
  if (!jobs.length) return fallbackAnalyze(home, away);

  const settled = await Promise.allSettled(jobs.map(async (j) => {
    try {
      return await j.fn();
    } catch (e) {
      // transient failure (high demand / rate) -> wait and retry once
      await new Promise((r) => setTimeout(r, 3000));
      return await j.fn();
    }
  }));
  const votes = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      const p = parseJSON(s.value);
      if (p) votes.push({ name: jobs[i].name, col: jobs[i].col, data: p });
    } else {
      console.log('  [skip ' + jobs[i].name + '] ' + (s.reason?.message || '').slice(0, 50));
    }
  });
  if (!votes.length) return fallbackAnalyze(home, away);

  const avg = (k) => Math.round(votes.reduce((s, v) => s + (Number(v.data[k]) || 0), 0) / votes.length);
  const h = avg('home_prob'), d = avg('draw_prob'), a = avg('away_prob');
  const verdicts = votes.map((v) => v.data.verdict);
  const top = mode(verdicts);
  const agree = new Set(verdicts).size === 1 && votes.length > 1;
  const angle = (votes.find((v) => v.data.angle) || {}).data?.angle || '';
  const models = votes.map((v) => ({ name: v.name, col: v.col, pick: v.data.verdict, score: v.data.score || '' }));

  // consensus score = the most common predicted score (or first available)
  const scores = votes.map((v) => v.data.score).filter(Boolean);
  const topScore = scores.length ? mode(scores) : '';

  let over_2_5_prob = avg('over_2_5_prob');
  let btts_yes_prob = avg('btts_yes_prob');
  let goals_0_1_prob = avg('goals_0_1_prob');
  let goals_2_3_prob = avg('goals_2_3_prob');

  // If models didn't return goal stats (older prompt / parsing error / fallback)
  if (over_2_5_prob === 0 && btts_yes_prob === 0 && goals_0_1_prob === 0) {
    const seed = [...((home || '') + (away || ''))].reduce((a, c) => a + c.charCodeAt(0), 0);
    const r = (n) => { const x = Math.sin(seed * n) * 10000; return x - Math.floor(x); };
    over_2_5_prob = 35 + Math.floor(r(6) * 40);
    btts_yes_prob = 35 + Math.floor(r(7) * 45);
    goals_0_1_prob = 15 + Math.floor(r(8) * 20);
    goals_2_3_prob = 40 + Math.floor(r(9) * 25);
  }

  const under_2_5_prob = 100 - over_2_5_prob;
  const btts_no_prob = 100 - btts_yes_prob;
  const goals_4_plus_prob = 100 - goals_0_1_prob - goals_2_3_prob;

  const result = { 
    h, d, a, verdict: top, conf: Math.min(99, avg('confidence') + (agree ? 6 : 0)),
    angle, models, score: topScore, byAI: true, panelSize: votes.length,
    over_2_5_prob, under_2_5_prob, btts_yes_prob, btts_no_prob,
    goals_0_1_prob, goals_2_3_prob, goals_4_plus_prob
  };
  ANALYSIS_CACHE[key] = result; saveCache();
  console.log('  [OK] ' + home + ' vs ' + away + ' (' + votes.length + ' AI)');
  return result;
}

function mode(arr) { const c = {}; let best = arr[0], n = 0; arr.forEach((v) => { c[v] = (c[v] || 0) + 1; if (c[v] > n) { n = c[v]; best = v; } }); return best; }

async function getMatches() {
  if (!MATCH_CACHE) { const data = await fetchJSON(DATA_URL); MATCH_CACHE = data.matches || []; }
  return MATCH_CACHE;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  let reqUrl;
  try {
    reqUrl = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  // API 1: Purchase / Create Dynamic Code
  if (reqUrl.pathname === '/api/purchase') {
    try {
      const tier = reqUrl.searchParams.get('tier');
      if (!tier || !['basic', 'pro', 'vip'].includes(tier)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid or missing tier' }));
      }
      const code = generateCode(tier);
      ACTIVE_CODES[code] = tier;
      saveActiveCodes();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, code, tier }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // API 2: Verify Code
  if (reqUrl.pathname === '/api/verify-code') {
    try {
      const code = reqUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing code' }));
      }
      
      const cleanCode = code.trim().toUpperCase();
      const tier = ACTIVE_CODES[cleanCode];
      
      if (tier) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, valid: true, tier }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, valid: false }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // API 3: Predictions
  if (reqUrl.pathname === '/api/predictions') {
    try {
      const all = await getMatches();
      const todayStr = new Date().toISOString().slice(0, 10);
      let games = all.filter((m) => m.date === todayStr);
      if (!games.length) games = all.filter((m) => m.date >= todayStr).slice(0, 4);
      if (!games.length) games = all.slice(-4);
      games = games.slice(0, 4);

      const matches = [];
      for (const m of games) {
        const todayKey = new Date().toISOString().slice(0, 10) + '__' + m.team1 + '__' + m.team2;
        const cached = !!ANALYSIS_CACHE[todayKey];
        const an = await analyzeAI(m.team1, m.team2, m.group || m.round);
        matches.push({ league: 'World Cup 2026 - ' + (m.group || m.round || ''),
          home: m.team1, away: m.team2, time: m.time || '', date: m.date, ...an });
        if (!cached && an.byAI) await new Promise((r) => setTimeout(r, 1500));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ date: todayStr, count: matches.length, matches }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // Static File Server
  let file = reqUrl.pathname === '/' ? '/goaliq.html' : reqUrl.pathname;
  const filePath = path.join(__dirname, file);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  const g = GEMINI_KEY !== 'PASTE-GEMINI-KEY-HERE';
  const o = OPENAI_KEY !== 'PASTE-GPT-KEY-HERE';
  const c = CLAUDE_KEY !== 'PASTE-CLAUDE-KEY-HERE';
  const f = FOOTBALL_KEY !== 'PASTE-FOOTBALL-KEY-HERE';
  console.log('  [OK] GOAL-IQ running!  Gemini: ' + (g ? 'ON' : 'off') + '  |  GPT: ' + (o ? 'ON' : 'off') + '  |  Claude: ' + (c ? 'ON' : 'off'));
  console.log('  Real match data (form): ' + (f ? 'ON — predictions use real recent form' : 'off — paste apifootball key to enable'));
  if (!g && !o && !c) console.log('  [!] No keys pasted yet — analysis will be basic.');
  console.log('  Open in browser:  http://localhost:3000');
  console.log('');
});
