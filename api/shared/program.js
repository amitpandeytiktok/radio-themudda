// Program builder for The Mudda Radio.
//
// Pulls The Mudda's live civic "takes" feed, picks a balanced spread of recent
// takes (mixing verdicts so it is never all-doom), gives each a short spoken
// civic lead-in, synthesises audio, and assembles the on-air playlist manifest
// (<prefix>program.json):
//
//   ident → [segue] take → … → sign-off   (the player loops the whole thing)
//
// Env:
//   TAKES_API     feed URL; default https://themudda.com/api/takes
//   RADIO_STORIES how many takes per program; default 12

const store = require('./store');
const tts = require('./tts');
const { takeLine, firstSentence, VERDICT_HI, BUMPERS, pick } = require('./script');

const TAKES_API = process.env.TAKES_API || 'https://themudda.com/api/takes';
const N_TAKES = Math.max(4, Math.min(24, parseInt(process.env.RADIO_STORIES || '12', 10)));
const STATION = 'The Mudda Radio';
const TAGLINE = 'हर मुद्दे पर एक साफ़ राय · चौबीसों घंटे · हिंदी में';

// Lead with concern but cycle through the rest so a program always carries hope,
// pride and reform too — never twelve worries in a row.
const VERDICT_ORDER = ['concern', 'hope', 'outrage', 'pride', 'reform', 'question', 'idea'];

async function fetchFeed() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(TAKES_API, { signal: ctrl.signal, headers: { 'User-Agent': 'MuddaRadio/1.0' } });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const hasDeva = (s) => /[\u0900-\u097F]/.test(String(s || ''));

// Keep takes that have an authored Hindi take + a real story, dedupe, then
// round-robin across verdicts (newest first within each) for a balanced set.
function selectTakes(feed) {
  const all = Array.isArray(feed && feed.takes) ? feed.takes : [];
  const seen = new Set();
  const buckets = new Map();
  for (const tk of all) {
    if (!tk || !hasDeva(tk.takeHi)) continue;
    const story = tk.story && typeof tk.story === 'object' ? tk.story : null;
    if (!story || !(story.title || story.link)) continue;
    const key = tk.id || story.link || tk.takeHi;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = tk.verdict || 'concern';
    if (!buckets.has(v)) buckets.set(v, []);
    buckets.get(v).push(tk);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const order = [...VERDICT_ORDER, ...[...buckets.keys()].filter((v) => !VERDICT_ORDER.includes(v))];
  const out = [];
  let moved = true;
  while (out.length < N_TAKES && moved) {
    moved = false;
    for (const v of order) {
      const arr = buckets.get(v);
      if (arr && arr.length) {
        out.push(arr.shift());
        moved = true;
        if (out.length >= N_TAKES) break;
      }
    }
  }
  return out;
}

// Build + persist the full program. Returns the manifest.
async function buildProgram(opts = {}) {
  const log = opts.log || (() => {});
  const feed = await fetchFeed();
  const takes = selectTakes(feed);
  log(`selected ${takes.length} takes (takes feed: ${(feed.takes || []).length} total)`);
  if (!takes.length) throw new Error('no takes from feed');

  const hourSeed = Math.floor(Date.now() / 3600000);
  const segments = [];

  // Opening station ident.
  segments.push(await voiceSeg('ident', pick(BUMPERS.ident, hourSeed), { title: STATION }));

  for (let i = 0; i < takes.length; i++) {
    const tk = takes[i];
    if (i > 0 && i % 3 === 0) {
      segments.push(await voiceSeg('segue', pick(BUMPERS.segue, hourSeed + i), { title: STATION }));
    }
    const story = tk.story || {};
    const spoken = takeLine(tk);
    const seg = await voiceSeg('story', spoken, {
      cat: tk.verdict || 'concern',
      verdictHi: VERDICT_HI[tk.verdict] || 'मुद्दा',
      title: story.title || '',
      titleHi: firstSentence(tk.takeHi),
      source: story.source || '',
      link: story.link || '',
      beat: story.beat || (Array.isArray(tk.tags) ? tk.tags[0] : '') || '',
    });
    log(`  [${i + 1}/${takes.length}] ${seg.cached ? 'cached' : 'synth '} ${Math.round(seg.durationMs / 1000)}s · ${tk.verdict} · ${(story.title || '').slice(0, 56)}`);
    segments.push(seg);
  }

  // Sign-off, then the player loops back to the ident.
  segments.push(await voiceSeg('signoff', pick(BUMPERS.signoff, hourSeed), { title: STATION }));

  const program = {
    station: STATION,
    tagline: TAGLINE,
    voice: tts.VOICE_DEFAULT,
    updatedAt: new Date().toISOString(),
    source: TAKES_API,
    newsUpdatedAt: feed.updatedAt || null,
    count: segments.length,
    totalDurationMs: segments.reduce((a, s) => a + (s.durationMs || 0), 0),
    segments,
  };
  await store.writeProgram(program);
  log(`program written: ${segments.length} segments · ${Math.round(program.totalDurationMs / 1000)}s total`);
  return program;
}

// Synthesise one segment and shape its manifest entry.
async function voiceSeg(kind, text, meta = {}) {
  const out = await tts.speak(text);
  return {
    id: out.name,
    kind,
    cat: meta.cat || null,
    verdictHi: meta.verdictHi || '',
    title: meta.title || '',
    titleHi: meta.titleHi || '',
    source: meta.source || '',
    link: meta.link || '',
    beat: meta.beat || '',
    text,
    audio: out.audio,
    durationMs: out.durationMs,
    cached: out.cached,
  };
}

module.exports = { buildProgram, selectTakes, fetchFeed, N_TAKES };
