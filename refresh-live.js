// Usage: node refresh-live.js [--out=path/to/live.txt]
// Requires Node >= 18 (fetch + crypto are built-in)

const crypto = require('crypto');
const fs = require('fs');

// ---- source A ----
const SOURCE_A = {
  API_BASE: 'https://kapi.kankanews.com',
  VERSION: '2.41.6',
  SIGN_SALT: '28c8edde3d61a0411511d3b1866f0636',
  M_UUID: 'WpVSBr0vgkBhWrNMzimQC',
  PUB_KEY: `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI
Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt
wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E
tSqSgXDcJ7yDj5rc7wIDAQAB
-----END PUBLIC KEY-----`,
};

const SOURCE_A_CHANNELS = [
  { id: 10, name: '五星体育', group: '体育' },
  { id: 12, name: '新纪实', group: '纪实' },
];

const SOURCE_A_HEADERS = {
  'Referer': 'https://live.kankanews.com/',
  'Origin': 'https://live.kankanews.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
};

// ---- source B ----
// yibababa 2026-06 改版:(1) 频道名 "体育/赛事" 改成 "线路";(2) 所有 URL 都包了
// 播放器壳 .../player/{tcplayer,dplayer,mpegts}/?url=<真URL> 或 cors-proxy.cooks.fyi/<真URL>,
// 必须 unwrap() 剥壳才能拿到真实可播 URL;(3) ESPN/Eurosport 从 cctv5.txt 移到 sport.txt。
// 故 SOURCE_B 拆成多 feed,每个 wanted 指明从哪个 feed 取。
const SOURCE_B = {
  ORIGIN: 'https://yibababa.com',
  FEEDS: {
    cctv5: 'https://yibababa.com/tv/cctv5/cctv5.txt',
    sport: 'https://yibababa.com/tv/sport/sport.txt',
  },
};

const SOURCE_B_WANTED = [
  { feed: 'cctv5', match: /^[^,]*CCTV-5线路\(\d+\)/, alias: 'CCTV5', headers: { Origin: SOURCE_B.ORIGIN }, multi: true, maxLines: 3, preferContains: 'hlslive-tx-cdn.ysp', prepend: ['http://69.30.245.50/live/cctv5.m3u8'] },
  { feed: 'cctv5', match: /^[^,]*CCTV-5\+线路\(\d+\)/, alias: 'CCTV5+', headers: { Origin: SOURCE_B.ORIGIN }, multi: true, maxLines: 3, preferContains: 'hlslive-tx-cdn.ysp', prepend: ['http://173.208.212.130:8181/1080p/cctv5p.m3u8', 'http://207.56.13.146:81/cdnlive/cctv5p.m3u8'] },
  { feed: 'sport', match: /^Eurosport 1,/, alias: 'Eurosport 1', headers: {} },
  // ESPN: yibababa 已删纯 ESPN,仅剩死的 "ESPN 2"(143.244.60.30 connection refused),暂撤,待新源
];

const SOURCE_B_EXTRA = [];

// ---- source C ----
const SOURCE_C = {
  API_BASE: 'https://emas-api.cctvnews.cctv.com/h5/emas.feed.article.live.detail/1.0.0',
  HMAC_KEY: 'emasgatewayh5',
  APP_KEY: '20000009',
  SCENE_TYPE: 6,
  TIMEOUT_MS: 8000,
};

const SOURCE_C_CHANNELS = [];

const C9_FALLBACKS = [
  { url: 'http://74.91.26.218:82/live/cctv9hd.m3u8', headers: {} },
  { url: 'https://timetv.shop/http://74.91.26.218:82/live/cctv9hd.m3u8', headers: { Origin: 'https://yibababa.com' } },
];

const C13_FALLBACKS = [
  { url: 'http://74.91.26.218:82/live/cctv13hd.m3u8', headers: {} },
  { url: 'https://timetv.shop/http://74.91.26.218:82/live/cctv13hd.m3u8', headers: { Origin: 'https://yibababa.com' } },
];

// ---- static ----
const STATIC_CHANNELS = [
  { alias: '凤凰中文', url: 'http://cdn6.163189.xyz/163189/fhzw' },
  { alias: '凤凰资讯', url: 'http://cdn6.163189.xyz/163189/fhzx' },
];

// 体育组静态频道(非 yibababa,Cloudflare 前置,带 UA)
const STATIC_SPORTS = [
  { alias: 'ESPN', url: 'https://t.freetv.fun/live/espn.m3u8', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
  { alias: 'ESPN2', url: 'https://t.freetv.fun/live/espn-2.m3u8', headers: { 'User-Agent': SOURCE_A_HEADERS['User-Agent'] } },
];

// ============================================================

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function hmacSha256(s, k) {
  return crypto.createHmac('sha256', k).update(s, 'utf8').digest('hex');
}

function aesDecryptCbc(b64Cipher, keyStr, ivStr) {
  const key = Buffer.from(keyStr, 'utf8');
  const iv = Buffer.from(ivStr, 'utf8');
  const cipher = Buffer.from(b64Cipher, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
}

function signA(userParams, apiVersion = 'v1') {
  const common = {
    platform: 'pc',
    version: SOURCE_A.VERSION,
    nonce: Math.random().toString(36).slice(-8),
    timestamp: Math.floor(Date.now() / 1000),
    'Api-Version': apiVersion,
  };
  const merged = { ...userParams, ...common };
  const sortedKeys = Object.keys(merged).sort();
  let qs = '';
  for (const k of sortedKeys) {
    if (merged[k] != null) qs += k + '=' + merged[k] + '&';
  }
  qs += SOURCE_A.SIGN_SALT;
  const sign = md5(md5(qs));
  return {
    'm-uuid': SOURCE_A.M_UUID,
    'timestamp': String(common.timestamp),
    'sign': sign,
    'nonce': common.nonce,
    'api-version': apiVersion,
    'version': common.version,
    'platform': common.platform,
    'referer': 'https://live.kankanews.com/',
    'origin': 'https://live.kankanews.com',
    'user-agent': SOURCE_A_HEADERS['User-Agent'],
    'accept': 'application/json, text/plain, */*',
  };
}

function decryptAddr(base64Cipher) {
  const cipherBytes = Buffer.from(base64Cipher, 'base64');
  let plain = '';
  for (let i = 0; i < cipherBytes.length; i += 128) {
    const block = cipherBytes.subarray(i, i + 128);
    if (block.length !== 128) continue;
    const decrypted = crypto.publicDecrypt(
      { key: SOURCE_A.PUB_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      block,
    );
    plain += decrypted.toString('utf8');
  }
  return plain;
}

async function fetchA(channelId) {
  const url = `${SOURCE_A.API_BASE}/content/pc/tv/channel/detail?channel_id=${channelId}`;
  const headers = signA({ channel_id: channelId }, 'v1');
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${channelId}`);
  const data = await resp.json();
  if (data.code !== '1000') {
    throw new Error(`code=${data.code} message=${data.message} for ${channelId}`);
  }
  const cipher = data.result?.live_address;
  if (!cipher) throw new Error(`no payload for ${channelId}`);
  const m3u8 = decryptAddr(cipher);
  if (!m3u8.startsWith('http')) throw new Error(`bad payload (got: ${m3u8.slice(0, 50)})`);
  return m3u8;
}

async function probe(url, originHeader) {
  try {
    const resp = await fetch(url, {
      headers: {
        Origin: originHeader,
        'User-Agent': SOURCE_A_HEADERS['User-Agent'],
        'Accept': 'application/vnd.apple.mpegurl,*/*',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return false;
    const body = await resp.text();
    return body.startsWith('#EXTM3U') && body.includes('#EXTINF');
  } catch {
    return false;
  }
}

// 剥掉 yibababa 的播放器壳,拿到真实可播 URL:
//   https://www.yibababa.com/player/tcplayer/?url=<real>  → <real>
//   https://cors-proxy.cooks.fyi/<real>                   → <real>
// 两层可能叠加(player 壳里再套 cors-proxy),顺序剥。裸 URL 原样返回。
function unwrap(u) {
  const m = u.match(/[?&]url=(.+)$/);
  if (m) u = decodeURIComponent(m[1]);
  u = u.replace(/^https?:\/\/cors-proxy\.cooks\.fyi\//i, '');
  return u;
}

async function pickMulti(allLines, wanted) {
  const prepend = wanted.prepend || [];
  const candidates = [...prepend];
  for (const line of allLines) {
    if (!wanted.match.test(line)) continue;
    const commaIdx = line.indexOf(',');
    if (commaIdx < 0) continue;
    candidates.push(unwrap(line.slice(commaIdx + 1).trim()));
  }
  // 去重:剥壳后不同壳可能指向同一真 URL(如 line4 cors-proxy 包的 69.30 == prepend)
  const seen = new Set();
  const uniq = candidates.filter(u => (seen.has(u) ? false : (seen.add(u), true)));
  if (uniq.length === 0) return [];

  uniq.sort((a, b) => {
    const aPre = prepend.includes(a) ? 0 : 2;
    const bPre = prepend.includes(b) ? 0 : 2;
    if (aPre !== bPre) return aPre - bPre;
    const aPref = wanted.preferContains && a.includes(wanted.preferContains) ? 0 : 1;
    const bPref = wanted.preferContains && b.includes(wanted.preferContains) ? 0 : 1;
    return aPref - bPref;
  });

  const probed = await Promise.all(
    uniq.map(async u => ({ url: u, alive: await probe(u, SOURCE_B.ORIGIN) }))
  );

  const alive = probed.filter(r => r.alive).map(r => r.url);
  const dead = probed.filter(r => !r.alive).map(r => r.url);
  const picked = alive.slice(0, wanted.maxLines);
  if (picked.length < wanted.maxLines) {
    picked.push(...dead.slice(0, wanted.maxLines - picked.length));
  }

  for (const u of picked) {
    const ok = alive.includes(u);
    console.error(`[${wanted.alias}] ${ok ? 'ok  ' : 'dead'} ${u.slice(0, 90)}`);
  }
  return picked.map(url => ({ alias: wanted.alias, url, headers: wanted.headers || {} }));
}

async function fetchBFeed(name) {
  const resp = await fetch(SOURCE_B.FEEDS[name], {
    headers: {
      'User-Agent': SOURCE_A_HEADERS['User-Agent'],
      'Accept': 'text/plain,*/*;q=0.9',
    },
  });
  if (!resp.ok) throw new Error(`B feed ${name} HTTP ${resp.status}`);
  return (await resp.text()).split(/\r?\n/);
}

async function fetchB() {
  // 每个 feed 只拉一次;单个 feed 挂掉不连累其他频道(返回空行,multi 频道仍能用 prepend)
  const feedCache = {};
  async function getFeed(name) {
    if (name in feedCache) return feedCache[name];
    try {
      feedCache[name] = await fetchBFeed(name);
    } catch (e) {
      console.error(`[warn] B feed ${name} failed: ${e.message}`);
      feedCache[name] = [];
    }
    return feedCache[name];
  }

  const out = [];
  for (const wanted of SOURCE_B_WANTED) {
    const lines = await getFeed(wanted.feed);
    if (wanted.multi) {
      const picked = await pickMulti(lines, wanted);
      if (picked.length === 0) console.error(`[warn] no match for ${wanted.alias}`);
      out.push(...picked);
      continue;
    }
    const hit = lines.find(l => wanted.match.test(l));
    if (!hit) {
      console.error(`[warn] no match for ${wanted.alias}`);
      continue;
    }
    const commaIdx = hit.indexOf(',');
    if (commaIdx < 0) continue;
    const url = unwrap(hit.slice(commaIdx + 1).trim());
    out.push({ alias: wanted.alias, url, headers: wanted.headers || {} });
  }
  return out;
}

async function fetchC(articleId) {
  const tt = Date.now().toString();
  const t = tt.substr(0, 10);
  const sail = md5(`articleId=${articleId}&scene_type=${SOURCE_C.SCENE_TYPE}`);
  const w = `&&&${SOURCE_C.APP_KEY}&${sail}&${t}&emas.feed.article.live.detail&1.0.0&&&&&`;
  const sign = hmacSha256(w, SOURCE_C.HMAC_KEY);
  const clientId = md5(t);
  const url = `${SOURCE_C.API_BASE}?articleId=${articleId}&scene_type=${SOURCE_C.SCENE_TYPE}`;

  const resp = await fetch(url, {
    headers: {
      cookieuid: clientId,
      'from-client': 'h5',
      'x-emas-gw-appkey': SOURCE_C.APP_KEY,
      'x-emas-gw-pv': '6.1',
      'x-emas-gw-sign': sign,
      'x-emas-gw-t': t,
      'x-req-ts': tt,
      'Referer': 'https://www.nettv.live/',
      'User-Agent': SOURCE_A_HEADERS['User-Agent'],
    },
    signal: AbortSignal.timeout(SOURCE_C.TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`C HTTP ${resp.status}`);
  const outer = await resp.json();
  if (!outer.response) throw new Error(`C: missing response`);
  const inner = JSON.parse(Buffer.from(outer.response, 'base64').toString('utf8'));
  const data = inner.data;
  if (!data || !data.dk) throw new Error(`C: missing dk`);

  const dk = data.dk.toString();
  const key = dk.substr(0, 8) + t.substr(-8);
  const iv = dk.substr(-8) + t.substr(0, 8);

  const cam = data.live_room && data.live_room.liveCameraList && data.live_room.liveCameraList[0];
  if (!cam) throw new Error(`C: missing cam`);
  const ar = cam.pullUrlList && cam.pullUrlList[0] && cam.pullUrlList[0].authResultUrl && cam.pullUrlList[0].authResultUrl[0];
  if (!ar || !ar.authUrl) throw new Error(`C: missing authUrl`);

  const urls = [aesDecryptCbc(ar.authUrl, key, iv)];
  if (Array.isArray(ar.demote_urls)) {
    for (const d of ar.demote_urls) {
      if (d && d.authUrl) urls.push(aesDecryptCbc(d.authUrl, key, iv));
    }
  }
  return urls.filter(u => u && u.startsWith('http'));
}

function suffix(headers) {
  return '|' + Object.entries(headers).map(([k, v]) => `${k}=${v}`).join('&');
}

function build({ aResults, bResults, bExtra, c9Lines, c13Lines, statics }) {
  const aSuffix = suffix(SOURCE_A_HEADERS);
  const bSuffix = suffix({ Origin: SOURCE_B.ORIGIN });

  const lines = [];

  lines.push('体育,#genre#');
  for (const ch of aResults.filter(c => (c.group || '体育') === '体育')) lines.push(`${ch.name},${ch.url}${aSuffix}`);
  for (const ch of bResults) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }
  for (const ch of STATIC_SPORTS) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }

  lines.push('央视,#genre#');
  for (const ch of bExtra) lines.push(`${ch.alias},${ch.url}${bSuffix}`);
  for (const ch of c9Lines) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }
  for (const ch of c13Lines) {
    const s = ch.headers && Object.keys(ch.headers).length > 0 ? suffix(ch.headers) : '';
    lines.push(`${ch.alias},${ch.url}${s}`);
  }
  for (const ch of statics.filter(c => c.alias.startsWith('CCTV'))) lines.push(`${ch.alias},${ch.url}`);

  lines.push('港澳台,#genre#');
  for (const ch of statics.filter(c => c.alias.startsWith('凤凰'))) lines.push(`${ch.alias},${ch.url}`);

  const jishi = aResults.filter(c => (c.group || '体育') === '纪实');
  if (jishi.length) {
    lines.push('纪实,#genre#');
    for (const ch of jishi) lines.push(`${ch.name},${ch.url}${aSuffix}`);
  }

  return lines.join('\n') + '\n';
}

async function main() {
  console.error('[info] A...');
  const aResults = [];
  for (const ch of SOURCE_A_CHANNELS) {
    try {
      const m3u8 = await fetchA(ch.id);
      console.error(`[ok] ${ch.name}: ${m3u8.slice(0, 80)}...`);
      aResults.push({ name: ch.name, url: m3u8, group: ch.group || '体育' });
    } catch (e) {
      console.error(`[fail] ${ch.name}: ${e.message}`);
    }
  }

  console.error('[info] B...');
  let bResults = [];
  try {
    bResults = await fetchB();
    for (const ch of bResults) console.error(`[ok] ${ch.alias}: ${ch.url.slice(0, 80)}...`);
  } catch (e) {
    console.error(`[fail] B: ${e.message}`);
  }

  const bExtra = SOURCE_B_EXTRA;
  const statics = STATIC_CHANNELS;
  for (const ch of bExtra) console.error(`[static] ${ch.alias}`);
  for (const ch of statics) console.error(`[static] ${ch.alias}`);

  console.error('[info] C...');
  const c9Lines = [];
  for (const cfg of SOURCE_C_CHANNELS) {
    try {
      const urls = await fetchC(cfg.articleId);
      for (const u of urls.slice(0, cfg.maxLines)) {
        console.error(`[ok] ${cfg.alias} (C): ${u.slice(0, 90)}...`);
        c9Lines.push({ alias: cfg.alias, url: u, headers: {} });
      }
    } catch (e) {
      console.error(`[fail] C ${cfg.alias}: ${e.message}`);
    }
  }
  for (const fb of C9_FALLBACKS) {
    c9Lines.push({ alias: 'CCTV9', url: fb.url, headers: fb.headers });
    console.error(`[static] CCTV9 fallback: ${fb.url.slice(0, 90)}...`);
  }

  const c13Lines = [];
  for (const fb of C13_FALLBACKS) {
    c13Lines.push({ alias: 'CCTV13', url: fb.url, headers: fb.headers });
    console.error(`[static] CCTV13 fallback: ${fb.url.slice(0, 90)}...`);
  }

  const totalDynamic = aResults.length + bResults.length;
  if (totalDynamic === 0) {
    console.error('[fatal] no dynamic channels resolved, aborting');
    process.exit(2);
  }

  const txt = build({ aResults, bResults, bExtra, c9Lines, c13Lines, statics });

  const outArg = process.argv.find(a => a.startsWith('--out='));
  if (outArg) {
    const path = outArg.slice('--out='.length);
    fs.writeFileSync(path, txt, 'utf8');
    console.error(`[info] wrote ${txt.length} bytes to ${path}`);
  } else {
    process.stdout.write(txt);
  }
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
