// Road to Glory Golf - PGA Tour Leaderboard Proxy Server
// Run: node server.js
// Then open road-to-glory-golf.html in your browser

const http = require('http');
const https = require('https');

const PORT = 3747;

// ESPN scoreboard endpoint (no auth required)
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

function fetchESPN() {
  return new Promise((resolve, reject) => {
    const req = https.get(ESPN_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse ESPN response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function parseLeaderboard(espnData) {
  const events = espnData.events || [];
  
  // Find current/most recent active event
  const activeEvent = events.find(e => {
    const compet = e.competitions && e.competitions[0];
    if (!compet) return false;
    const statusName = compet.status && compet.status.type && compet.status.type.name || '';
    return statusName === 'STATUS_IN_PROGRESS' || statusName === 'STATUS_PLAY_COMPLETE';
  }) || events[0];

  if (!activeEvent) {
    return { status: 'no_tournament' };
  }

  const compet = activeEvent.competitions && activeEvent.competitions[0];
  if (!compet) return { status: 'no_tournament' };

  const statusName = compet.status && compet.status.type && compet.status.type.name || '';
  const validStatuses = ['STATUS_IN_PROGRESS', 'STATUS_SCHEDULED', 'STATUS_FINAL', 'STATUS_PLAY_COMPLETE'];
  if (!validStatuses.includes(statusName)) {
    return { status: 'no_tournament' };
  }

  const roundNum = compet.status && compet.status.period || 1;
  const statusDesc = compet.status && compet.status.type && compet.status.type.shortDetail || '';
  const isFinished = statusName === 'STATUS_FINAL' || statusName === 'STATUS_PLAY_COMPLETE';

  const players = (compet.competitors || []).map((c, idx) => {
    const rawScore = c.score || '0';
    const n = parseInt(rawScore);
    const score = isNaN(n) ? 'E' : n === 0 ? 'E' : n < 0 ? String(n) : '+' + n;

    const athleteStatus = (c.status || '').toLowerCase();
    let pos;
    if (athleteStatus === 'cut') {
      pos = 'MC';
    } else if (athleteStatus === 'wd') {
      pos = 'WD';
    } else {
      // Use sortOrder for position, add T prefix
      pos = c.sortOrder ? String(c.sortOrder) : String(idx + 1);
    }

    // Thru: number of linescores completed in current round, or F if done
    let thru = '--';
    if (isFinished) {
      thru = 'F';
    } else if (c.linescores && c.linescores.length > 0) {
      // linescores are per-round; last one is current round
      const currentRound = c.linescores[c.linescores.length - 1];
      if (currentRound && currentRound.linescores) {
        thru = String(currentRound.linescores.length);
      } else {
        thru = 'F'; // completed rounds
      }
    }

    return {
      name: c.athlete && c.athlete.displayName || '',
      score,
      thru,
      position: pos,
    };
  }).filter(p => p.name);

  if (!players.length) return { status: 'no_tournament' };

  return {
    status: 'ok',
    tournament: activeEvent.name || 'PGA Tour Event',
    round: 'Round ' + roundNum,
    roundStatus: statusDesc,
    players,
    fetchedAt: new Date().toISOString(),
  };
}

// Simple in-memory cache (refresh every 60s)
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

async function getLeaderboard() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL) {
    return cache;
  }
  try {
    const raw = await fetchESPN();
    cache = parseLeaderboard(raw);
    cacheTime = now;
    console.log('[' + new Date().toLocaleTimeString() + '] Leaderboard refreshed -', 
      cache.status === 'ok' ? cache.tournament + ' ' + cache.round + ' (' + cache.players.length + ' players)' : cache.status);
    return cache;
  } catch (e) {
    console.error('Fetch error:', e.message);
    if (cache) return cache; // return stale cache on error
    return { status: 'error', message: e.message };
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers - allow requests from any local file or localhost
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/leaderboard' || req.url === '/') {
    try {
      const data = await getLeaderboard();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: e.message }));
    }
  } else if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log('');
  console.log('  Road to Glory Golf - Leaderboard Proxy');
  console.log('  =======================================');
  console.log('  Running at: http://localhost:' + PORT);
  console.log('  Leaderboard: http://localhost:' + PORT + '/leaderboard');
  console.log('');
  console.log('  Keep this window open while using the app.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  // Pre-warm cache
  await getLeaderboard();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Close the other instance and try again.');
  } else {
    console.error('Server error:', e);
  }
  process.exit(1);
});
