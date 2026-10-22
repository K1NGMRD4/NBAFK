// Pošiljanje push obvestil za NBA Fantasy Koroška - predictions.
// Zažene ga GitHub Action (.github/workflows/predictions-push.yml).
//
//   MODE=open      Če je admin odprl nov krog (polje openedAt, še brez openPushSentAt):
//                  vsem naročenim pošlje "Novi predictioni".
//   MODE=reminder  Ob 19:xx po slovenskem času (ali FORCE=true) pošlje "Opomnik - predictions"
//                  samo tistim, ki za odprt krog še niso oddali napovedi.
//   MODE=test      Vsem naročenim pošlje testno obvestilo.
//
// Zahteva skrivnost FIREBASE_SERVICE_ACCOUNT (JSON ključ iz Firebase konzole).
import { pathToFileURL } from 'node:url';

const TZ = 'Europe/Ljubljana';
const STALE_HOURS = 36;           // krog, odprt pred več kot toliko urami, ne sproži več "novega" obvestila
const INVALID = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

export function localParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')), weekday: g('weekday') };
}

export function roundTitle(r) {
  if (r.kind === 'special') return r.label || 'Special';
  return 'Krog ' + r.number + (r.label ? ' — ' + r.label : '');
}

async function loadTokens(db) {
  const snap = await db.collection('pushTokens').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.token);
}

/** Pošlje isto obvestilo na seznam žetonov (združeno po URL strani) in pobriše neveljavne žetone. */
export async function sendToTokens(db, messaging, tokens, title, body) {
  let sent = 0, failed = 0;
  const byUrl = new Map();
  for (const t of tokens) {
    const key = t.url || '';
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(t);
  }
  for (const [url, list] of byUrl) {
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const message = {
        tokens: chunk.map((t) => t.token),
        notification: { title, body },
        webpush: { headers: { Urgency: 'high', TTL: '7200' } },
      };
      if (url) {
        message.webpush.fcmOptions = { link: url };
        try { message.webpush.notification = { icon: new URL('icon-192.png', url).href }; } catch { /* ignore */ }
      }
      const res = await messaging.sendEachForMulticast(message);
      for (let j = 0; j < res.responses.length; j++) {
        const r = res.responses[j];
        if (r.success) { sent++; continue; }
        failed++;
        const code = r.error && r.error.code;
        console.warn('Neuspešno:', chunk[j].userName || chunk[j].id, code);
        if (INVALID.includes(code)) await db.doc('pushTokens/' + chunk[j].id).delete();
      }
    }
  }
  return { sent, failed };
}

export async function runOpen(db, messaging, now, force = false) {
  const snap = await db.collection('rounds').where('status', '==', 'open').get();
  const pending = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.openedAt && !r.openPushSentAt);
  if (pending.length === 0) { console.log('Ni novih odprtih krogov.'); return { sent: 0 }; }

  const fresh = [], stale = [];
  for (const r of pending) {
    const ageH = (now - new Date(r.openedAt)) / 3.6e6;
    (force || ageH <= STALE_HOURS ? fresh : stale).push(r);
  }
  for (const r of stale) {
    console.log('Preskočeno (odprt predolgo nazaj):', roundTitle(r));
    await db.doc('rounds/' + r.id).update({ openPushSentAt: 'skipped-stale' });
  }
  if (fresh.length === 0) return { sent: 0 };

  const tokens = await loadTokens(db);
  const titles = fresh.sort((a, b) => (a.number || 0) - (b.number || 0)).map(roundTitle);
  const body = titles.length === 1
    ? `Odprt je ${titles[0]} — oddaj svojo napoved!`
    : `Odprti so: ${titles.join(', ')} — oddaj svoje napovedi!`;
  const res = await sendToTokens(db, messaging, tokens, 'Novi predictioni', body);
  console.log(`Novi predictioni: poslano ${res.sent}, neuspešno ${res.failed} (${titles.join(', ')})`);
  for (const r of fresh) await db.doc('rounds/' + r.id).update({ openPushSentAt: now.toISOString() });
  return res;
}

export async function runReminder(db, messaging, now, force = false) {
  const lp = localParts(now);
  if (!force && (lp.weekday !== 'Mon' || lp.hour !== 19)) {
    console.log(`Ni čas za opomnik (lokalno ${lp.weekday} ${lp.hour}:xx).`);
    return { sent: 0 };
  }
  const snap = await db.collection('rounds').where('status', '==', 'open').get();
  const rounds = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => force || r.reminderSentDate !== lp.date);
  if (rounds.length === 0) { console.log('Ni odprtih krogov (ali je opomnik že poslan).'); return { sent: 0 }; }

  const submitted = new Map();
  for (const r of rounds) {
    const s = await db.collection(`rounds/${r.id}/submissions`).get();
    submitted.set(r.id, new Set(s.docs.map((d) => d.id)));
  }
  const tokens = (await loadTokens(db)).filter((t) => t.userId);
  const groups = new Map(); // besedilo -> žetoni
  for (const t of tokens) {
    const missing = rounds.filter((r) => !submitted.get(r.id).has(t.userId)).map(roundTitle);
    if (missing.length === 0) continue;
    const body = `Napoved še ni oddana: ${missing.join(', ')}`;
    if (!groups.has(body)) groups.set(body, []);
    groups.get(body).push(t);
  }
  let sent = 0, failed = 0;
  for (const [body, list] of groups) {
    const res = await sendToTokens(db, messaging, list, 'Opomnik - predictions', body);
    sent += res.sent; failed += res.failed;
  }
  console.log(`Opomnik: poslano ${sent}, neuspešno ${failed}`);
  for (const r of rounds) await db.doc('rounds/' + r.id).update({ reminderSentDate: lp.date });
  return { sent, failed };
}

export async function runTest(db, messaging) {
  const tokens = await loadTokens(db);
  const res = await sendToTokens(db, messaging, tokens, 'Test obvestila', 'Če to vidiš, push obvestila delujejo.');
  console.log(`Test: poslano ${res.sent}, neuspešno ${res.failed}`);
  return res;
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error('Manjka skrivnost FIREBASE_SERVICE_ACCOUNT.'); process.exit(1); }
  const admin = (await import('firebase-admin')).default;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  const messaging = admin.messaging();
  const mode = process.env.MODE || 'open';
  const force = process.env.FORCE === 'true';
  const now = new Date();
  console.log(`MODE=${mode} FORCE=${force} ${now.toISOString()}`);
  if (mode === 'open') await runOpen(db, messaging, now, force);
  else if (mode === 'reminder') await runReminder(db, messaging, now, force);
  else if (mode === 'test') await runTest(db, messaging);
  else { console.error('Neznan MODE:', mode); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
