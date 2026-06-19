// Program builder for The Mudda Radio.
//
// Reads The Mudda's full long-form editorials aloud — not just headlines. Pulls
// the editorial index, picks a balanced spread of recent editorials (mixing
// verdicts so it is never all-doom), fetches each one's full body, and voices it
// section by section behind a short civic lead-in. Assembles the on-air playlist
// manifest (<prefix>program.json):
//
//   ident → [editorial: open → sections → pullquote] → segue → … → sign-off
//
// Env:
//   EDITORIAL_API    index URL; default https://themudda.com/api/editorial?format=json
//   EDITORIAL_BASE   per-slug base; default https://themudda.com/api/editorial/
//   RADIO_EDITORIALS how many editorials per program; default 5

const store = require('./store');
const tts = require('./tts');
const { editorialOpen, sectionLine, pullLine, firstSentence, sanitize, VERDICT_HI, BUMPERS, pick } = require('./script');

const EDITORIAL_INDEX = process.env.EDITORIAL_API || 'https://themudda.com/api/editorial?format=json';
const EDITORIAL_BASE = process.env.EDITORIAL_BASE || 'https://themudda.com/api/editorial/';
const N_EDITORIALS = Math.max(3, Math.min(12, parseInt(process.env.RADIO_EDITORIALS || '5', 10)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATION = 'The Mudda Radio';
const TAGLINE = 'हर मुद्दे पर एक साफ़ राय · चौबीसों घंटे · हिंदी में';

// Lead with concern but cycle through the rest so a program always carries hope,
// pride and reform too — never twelve worries in a row.
const VERDICT_ORDER = ['concern', 'hope', 'outrage', 'pride', 'reform', 'question', 'idea'];

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'MuddaRadio/1.0', 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const fetchIndex = () => fetchJson(EDITORIAL_INDEX);
const fetchEditorial = (slug) => fetchJson(EDITORIAL_BASE + encodeURIComponent(slug) + '?format=json');

const hasDeva = (s) => /[\u0900-\u097F]/.test(String(s || ''));

// Keep editorials that have an authored Hindi version, dedupe by slug, then
// round-robin across verdicts (newest first within each) for a balanced set.
function selectEditorials(index) {
  const all = Array.isArray(index && index.editorials) ? index.editorials : [];
  const seen = new Set();
  const buckets = new Map();
  for (const ed of all) {
    if (!ed || !ed.slug) continue;
    if (!(ed.hi || hasDeva(ed.headlineHi))) continue;
    if (seen.has(ed.slug)) continue;
    seen.add(ed.slug);
    const v = ed.verdict || 'concern';
    if (!buckets.has(v)) buckets.set(v, []);
    buckets.get(v).push(ed);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const order = [...VERDICT_ORDER, ...[...buckets.keys()].filter((v) => !VERDICT_ORDER.includes(v))];
  const out = [];
  let moved = true;
  while (out.length < N_EDITORIALS && moved) {
    moved = false;
    for (const v of order) {
      const arr = buckets.get(v);
      if (arr && arr.length) {
        out.push(arr.shift());
        moved = true;
        if (out.length >= N_EDITORIALS) break;
      }
    }
  }
  return out;
}

// Synthesise one segment, tolerating TTS hiccups so a cold build never aborts
// midway — a skipped section just fills in on the next scheduled refresh (each
// clip is content-hash cached, so nothing is ever re-synthesised twice).
async function synthSeg(kind, text, meta, log) {
  const clean = (text || '').trim();
  if (!clean) return null;
  try {
    return await voiceSeg(kind, clean, meta);
  } catch (e) {
    log(`  ! skipped ${kind} (${String((meta && meta.title) || '').slice(0, 40)}): ${e.message}`);
    return null;
  }
}

// Build + persist the full program. Returns the manifest.
async function buildProgram(opts = {}) {
  const log = opts.log || (() => {});
  const index = await fetchIndex();
  const picks = selectEditorials(index);
  log(`selected ${picks.length} editorials (index: ${(index.editorials || []).length} total)`);
  if (!picks.length) throw new Error('no editorials from feed');

  const hourSeed = Math.floor(Date.now() / 3600000);
  const segments = [];
  let newest = 0;

  // Opening station ident.
  segments.push(await voiceSeg('ident', pick(BUMPERS.ident, hourSeed), { title: STATION }));

  let aired = 0;
  for (let i = 0; i < picks.length; i++) {
    const meta = picks[i];
    let blob;
    try {
      blob = await fetchEditorial(meta.slug);
    } catch (e) {
      log(`  ! could not load editorial ${meta.slug}: ${e.message}`);
      continue;
    }
    if (!blob || !blob.slug) continue;

    const verdict = blob.verdict || meta.verdict || 'concern';
    const headline = blob.headline || meta.headline || '';
    const baseMeta = {
      cat: verdict,
      verdictHi: VERDICT_HI[verdict] || 'मुद्दा',
      title: headline,
      source: 'The Mudda',
      link: blob.slug ? `https://themudda.com/desk/editorial/${blob.slug}` : '',
      beat: blob.beat || (Array.isArray(blob.tags) ? blob.tags[0] : '') || '',
    };

    // Segue before each editorial except the first one aired.
    if (aired > 0) {
      segments.push(await voiceSeg('segue', pick(BUMPERS.segue, hourSeed + i), { title: STATION }));
    }

    // Voice the whole editorial: opening (headline + dek) → each section → pullquote.
    const beats = [];
    beats.push([editorialOpen(blob), firstSentence(blob.headlineHi || blob.dekHi)]);
    for (const sec of (blob.sections || [])) {
      beats.push([sectionLine(sec), sanitize(sec.hHi || sec.h || blob.headlineHi)]);
    }
    const pull = pullLine(blob);
    if (pull) beats.push([pull, firstSentence(blob.headlineHi)]);

    let any = false;
    let synthCount = 0;
    for (const [text, titleHi] of beats) {
      const seg = await synthSeg('story', text, { ...baseMeta, titleHi }, log);
      if (!seg) continue;
      segments.push(seg);
      any = true;
      if (!seg.cached) { synthCount++; await sleep(150); }
    }
    if (any) {
      aired++;
      newest = Math.max(newest, blob.ts || meta.ts || 0);
      log(`  [${aired}/${picks.length}] ${(headline || '').slice(0, 50)} · ${(blob.sections || []).length} sections · ${synthCount} synth`);
    }
  }
  if (!aired) throw new Error('no editorial audio produced');

  // Sign-off, then the player loops back to the ident.
  segments.push(await voiceSeg('signoff', pick(BUMPERS.signoff, hourSeed), { title: STATION }));

  const program = {
    station: STATION,
    tagline: TAGLINE,
    voice: tts.VOICE_DEFAULT,
    updatedAt: new Date().toISOString(),
    source: EDITORIAL_INDEX,
    newsUpdatedAt: newest ? new Date(newest).toISOString() : null,
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

module.exports = { buildProgram, selectEditorials, fetchIndex, fetchEditorial, N_EDITORIALS };
