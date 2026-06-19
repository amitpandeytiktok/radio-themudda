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

// Shape one manifest entry from a ready (cached or freshly voiced) clip.
function shapeSeg(kind, name, text, meta, bytes, cached) {
  return {
    id: name,
    kind,
    cat: meta.cat || null,
    verdictHi: meta.verdictHi || '',
    title: meta.title || '',
    titleHi: meta.titleHi || '',
    source: meta.source || '',
    link: meta.link || '',
    beat: meta.beat || '',
    text,
    audio: `/api/audio/${name}.mp3`,
    durationMs: tts.durationFromBytes(bytes),
    cached: !!cached,
  };
}

// Build + persist the program. Bounded + resumable: the F0 free tier rate-limits
// synthesis (~20 calls/60s) and the SWA gateway caps a request at ~45s, so a
// cold program of ~40 segments cannot be voiced in one request. Each run voices
// at most `maxNew` not-yet-cached clips (within a wall-clock budget), assembles
// the playlist from whatever audio is ready, and defers editorials whose audio
// is still warming. Repeated refreshes (manual + the 3-hourly cron) converge to
// the full program; every clip is content-hash cached, so nothing is voiced
// twice and a warm cache reassembles instantly.
async function buildProgram(opts = {}) {
  const log = opts.log || (() => {});
  const maxNew = Math.max(1, parseInt(opts.maxNew || process.env.RADIO_MAX_NEW || '14', 10));
  const budgetMs = Math.max(10000, parseInt(opts.budgetMs || process.env.RADIO_BUDGET_MS || '36000', 10));
  const started = Date.now();
  const overBudget = () => (Date.now() - started) > budgetMs;

  const index = await fetchIndex();
  const picks = selectEditorials(index);
  log(`selected ${picks.length} editorials (index: ${(index.editorials || []).length} total)`);
  if (!picks.length) throw new Error('no editorials from feed');

  // Load the full bodies up front (cheap HTTP, no synthesis).
  const eds = [];
  for (const meta of picks) {
    try {
      const blob = await fetchEditorial(meta.slug);
      if (blob && blob.slug) eds.push({ meta, blob });
    } catch (e) {
      log(`  ! could not load editorial ${meta.slug}: ${e.message}`);
    }
  }
  if (!eds.length) throw new Error('no editorial bodies from feed');

  const hourSeed = Math.floor(Date.now() / 3600000);
  let made = 0;            // new (paid) synth calls this run
  let budgetHit = false;

  // Return a ready manifest entry for this text, or null. Cache first; only
  // spend a synth call (and only while under the per-run cap + time budget) when
  // the clip isn't cached yet. Never throws — a hiccup just defers the clip to a
  // later refresh.
  async function ensureSeg(kind, text, meta) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const name = tts.clipName(clean, tts.VOICE_DEFAULT);
    try {
      const info = await store.audioInfo(name);
      if (info && info.exists && info.size > 0) return shapeSeg(kind, name, clean, meta, info.size, true);
    } catch (e) { /* fall through and try to synthesise */ }
    if (made >= maxNew || overBudget()) { budgetHit = true; return null; }
    try {
      const out = await tts.speak(clean);
      made++;
      return shapeSeg(kind, out.name, clean, meta, out.bytes, out.cached);
    } catch (e) {
      log(`  ! skipped ${kind} (${String((meta && meta.title) || '').slice(0, 40)}): ${e.message}`);
      return null;
    }
  }

  const segments = [];
  let aired = 0;
  let pending = 0;
  let newest = 0;

  const ident = await ensureSeg('ident', pick(BUMPERS.ident, hourSeed), { title: STATION });
  if (ident) segments.push(ident);

  for (let i = 0; i < eds.length; i++) {
    const { meta, blob } = eds[i];
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

    // The full editorial: opening (headline + dek) → each section → pullquote.
    const beats = [];
    beats.push([editorialOpen(blob), firstSentence(blob.headlineHi || blob.dekHi)]);
    for (const sec of (blob.sections || [])) {
      beats.push([sectionLine(sec), sanitize(sec.hHi || sec.h || blob.headlineHi)]);
    }
    const pull = pullLine(blob);
    if (pull) beats.push([pull, firstSentence(blob.headlineHi)]);

    // Keep the editorial atomic: only air it once ALL its audio is ready, so a
    // listener never hears a clipped argument. Missing beats are still voiced
    // (up to the cap) so the editorial completes on a later refresh.
    const beatSegs = [];
    let complete = true;
    for (const [text, titleHi] of beats) {
      const seg = await ensureSeg('story', text, { ...baseMeta, titleHi });
      if (seg) beatSegs.push(seg);
      else complete = false;
    }

    if (complete && beatSegs.length) {
      if (aired > 0) {
        const segue = await ensureSeg('segue', pick(BUMPERS.segue, hourSeed + i), { title: STATION });
        if (segue) segments.push(segue);
      }
      segments.push(...beatSegs);
      aired++;
      newest = Math.max(newest, blob.ts || meta.ts || 0);
      log(`  [${aired}] ${(headline || '').slice(0, 50)} · ${beatSegs.length} segs`);
    } else {
      pending++;
      log(`  … warming "${(headline || '').slice(0, 40)}" (${beatSegs.length}/${beats.length} ready)`);
    }
  }

  // Sign-off, then the player loops back to the ident.
  const signoff = await ensureSeg('signoff', pick(BUMPERS.signoff, hourSeed), { title: STATION });
  if (signoff) segments.push(signoff);

  if (!segments.length) throw new Error('no editorial audio produced yet');

  const program = {
    station: STATION,
    tagline: TAGLINE,
    voice: tts.VOICE_DEFAULT,
    updatedAt: new Date().toISOString(),
    source: EDITORIAL_INDEX,
    newsUpdatedAt: newest ? new Date(newest).toISOString() : null,
    partial: pending > 0 || budgetHit,
    aired,
    pending,
    count: segments.length,
    totalDurationMs: segments.reduce((a, s) => a + (s.durationMs || 0), 0),
    segments,
  };
  await store.writeProgram(program);
  log(`program written: ${segments.length} segs · ${aired} editorials aired · ${pending} warming · ${made} new synths · ${Math.round(program.totalDurationMs / 1000)}s`);
  return program;
}

module.exports = { buildProgram, selectEditorials, fetchIndex, fetchEditorial, N_EDITORIALS };
