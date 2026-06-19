// Civic-commentary script helpers for The Mudda Radio.
//
// The Mudda already publishes a written Hindi "take" (takeHi) on each issue,
// tagged with a verdict (concern / outrage / hope / pride / reform / idea /
// question). The radio simply gives each take a short spoken civic lead-in in
// the station's voice, then reads the take — calm, principled, bebaak. No LLM
// is needed (the take is already authored), which keeps the station free and
// its tone perfectly on-brand.

function clip(s, n) { return String(s || '').slice(0, n); }

// Clean a line so it is safe to feed to TTS.
function sanitize(line) {
  let s = String(line || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

// First sentence of a Hindi take — used as the now-playing "headline" line.
function firstSentence(s) {
  const t = sanitize(s);
  if (!t) return '';
  const i = t.indexOf('।');
  if (i > 8) return t.slice(0, i + 1);
  return clip(t, 90);
}

// Verdict → spoken civic lead-in (precedes the take, in the RJ's voice).
const VERDICT_LEAD = {
  concern:  'एक चिंता का मुद्दा। ',
  outrage:  'ये बात आक्रोश पैदा करती है। ',
  hope:     'उम्मीद की एक किरण। ',
  pride:    'गर्व की एक बात। ',
  reform:   'बदलाव की एक माँग। ',
  idea:     'एक नया विचार। ',
  question: 'एक बड़ा सवाल। ',
};
const LEAD_DEFAULT = 'आज का एक मुद्दा। ';

// Verdict → short Hindi label (shown as the now-playing tag).
const VERDICT_HI = {
  concern: 'चिंता', outrage: 'आक्रोश', hope: 'उम्मीद', pride: 'गर्व',
  reform: 'सुधार', idea: 'विचार', question: 'सवाल',
};

// Compose the spoken line for one take: civic lead-in + the authored Hindi take.
function takeLine(take) {
  const lead = VERDICT_LEAD[take && take.verdict] || LEAD_DEFAULT;
  const body = sanitize(take && (take.takeHi || take.take) || '');
  if (!body) return '';
  return sanitize(lead + body);
}

// Compose the spoken OPENING line for an editorial: civic lead-in + headline + dek.
function editorialOpen(ed) {
  const lead = VERDICT_LEAD[ed && ed.verdict] || LEAD_DEFAULT;
  const head = sanitize(ed && (ed.headlineHi || ed.headline) || '');
  const dek = sanitize(ed && (ed.dekHi || ed.dek) || '');
  if (!head) return '';
  return sanitize(lead + head + (dek ? '। ' + dek : ''));
}

// Compose the spoken line for one editorial section: optional heading + paragraph.
function sectionLine(sec) {
  const h = sanitize(sec && (sec.hHi || sec.h) || '');
  const p = sanitize(sec && (sec.pHi || sec.p) || '');
  if (!p) return '';
  return sanitize(h ? h + '। ' + p : p);
}

// The bebaak closing punch — the editorial's pullquote, read as the last beat.
function pullLine(ed) {
  const q = sanitize(ed && (ed.pullquoteHi || ed.pullquote) || '');
  if (!q) return '';
  return sanitize('और हमारी बेबाक राय यही है — ' + q);
}

// Pre-written station bumpers (no LLM). Idents open the hour, segues bridge
// takes, the sign-off plays just before the loop restarts.
const BUMPERS = {
  ident: [
    'ये है The Mudda Radio — हर मुद्दे पर एक साफ़ और बेबाक राय, चौबीसों घंटे, हिंदी में। चलिए शुरू करते हैं।',
    'आप सुन रहे हैं The Mudda Radio, जहाँ खबरों के पीछे का असली मुद्दा समझाया जाता है।',
    'The Mudda Radio — एक कानून, सरपंच से संसद तक। हर मसले पर हमारी राय, सीधे आपके कानों तक।',
  ],
  segue: [
    'चलिए, अगले मुद्दे की ओर।',
    'और अब, एक और मसला जिस पर बात ज़रूरी है।',
    'आगे बढ़ते हैं — ये भी सुनिए।',
    'अब एक और मुद्दा, हमारी राय के साथ।',
  ],
  signoff: [
    'फ़िलहाल इतने मुद्दे — The Mudda Radio पर बने रहिए, राय जारी रहेगी।',
    'ये थीं अब तक की हमारी राय। The Mudda Radio — सोचिए, सवाल कीजिए, सुनते रहिए।',
  ],
};

function pick(arr, seed) {
  if (!arr.length) return '';
  const i = Math.abs(seed | 0) % arr.length;
  return arr[i];
}

module.exports = {
  sanitize, firstSentence, takeLine, pick,
  editorialOpen, sectionLine, pullLine,
  VERDICT_LEAD, VERDICT_HI, BUMPERS,
};
