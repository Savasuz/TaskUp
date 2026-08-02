/**
 * TaskUp — server tomonidagi tanga mantiqi (anti-cheat).
 * Barcha tanga o'zgarishlari faqat shu funksiyalar orqali bo'ladi;
 * Firestore qoidalari foydalanuvchiga tanga maydonlarini yozishni taqiqlaydi.
 */
process.env.TZ = 'Asia/Tashkent';

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');

initializeApp();
const db = getFirestore();

/* ---------- Karta ma'lumotlarini shifrlash (AES-256-GCM) ----------
   Kalit Secret Manager'da saqlanadi va faqat unga muhtoj funksiyalarga
   ulanadi (requestCashout — yozish, revealCashoutCard — o'qish).
   Kalitni o'rnatish:  firebase functions:secrets:set CARD_ENC_KEY
   Kalit istalgan uzunlikdagi matn bo'lishi mumkin — SHA-256 orqali
   32 baytga keltiriladi. */
const CARD_ENC_KEY = defineSecret('CARD_ENC_KEY');

function encKey() {
  const raw = CARD_ENC_KEY.value();
  if (!raw) throw new HttpsError('failed-precondition', 'enc-key-missing');
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest();
}
/* Format: "v1:" + base64(iv[12] || authTag[16] || ciphertext) */
function encryptCard(plainText) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(String(plainText), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decryptCard(blob) {
  if (typeof blob !== 'string' || blob.indexOf('v1:') !== 0) throw new Error('bad-cipher-format');
  const buf = Buffer.from(blob.slice(3), 'base64');
  if (buf.length < 29) throw new Error('bad-cipher-length');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

async function requireAdmin(uid) {
  const doc = await db.collection('admins').doc(uid).get();
  if (!doc.exists) throw new HttpsError('permission-denied', 'admin-only');
}

const XP_PER_LEVEL = 1000;
const DAILY_CAP_BASE = 3000;
const DAILY_CAP_PER_LEVEL = 250;
const DAILY_CAP_MAX_LEVEL = 10;
const CASHOUT_MIN = 10000;
const COIN_TO_SOM = 1.2;
const REFERRAL_BONUS_REFERRER = 1000; // taklif qilgan odamga
const REFERRAL_BONUS_NEWUSER = 500;   // kodni kiritgan yangi foydalanuvchiga
const PAY_METHODS = ['uzcard', 'humo', 'payme', 'click'];

/* DIQQAT: bu yerda avval DEFAULT_TASKS (video/download/survey/ad/telegram/rate)
   bor edi va Firestore'da bunday vazifa umuman bo'lmasa ham mukofot berilardi.
   Ya'ni admin vazifani o'chirgandan keyin ham foydalanuvchi o'sha id bilan
   haqiqiy tanga yiga olardi. Endi mukofot FAQAT Firestore'dagi mavjud va
   active:true vazifa uchun beriladi. */

function levelOf(lifetimeCoins) { return Math.floor((lifetimeCoins || 0) / XP_PER_LEVEL) + 1; }
function dailyCap(level) {
  return DAILY_CAP_BASE + (Math.min(Math.max(1, level), DAILY_CAP_MAX_LEVEL) - 1) * DAILY_CAP_PER_LEVEL;
}
function requireAuth(req) {
  if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'login-required');
  return req.auth.uid;
}

/* Haftalik reyting uchun ISO hafta belgisi (masalan "2026-W29") */
function weekStampNow() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}
/* Haftalik tanga hisobini yangilash uchun patch */
function weeklyPatch(d, amount) {
  const ws = weekStampNow();
  return { weekStamp: ws, weeklyCoins: (d.weekStamp === ws ? (d.weeklyCoins || 0) : 0) + amount };
}
/* Reytingda email maxfiyligini saqlash: jas***@ emas, faqat jas*** */
function maskEmail(email) {
  const name = String(email || '').split('@')[0] || 'User';
  return name.length <= 3 ? name + '***' : name.slice(0, 3) + '***';
}

/* ---------- Vazifani bajarish ----------

   Progress har bir vazifa uchun alohida hujjatda saqlanadi:
   users/{uid}/taskProgress/{taskId} = { count, lastResetDate, updatedAt }

   Avval hammasi users/{uid}.taskCounts map'ida edi va har bir bajarishda
   butun map qayta yozilardi. Alohida hujjat per-task qoidani ham imkon
   beradi: tasks hujjatidagi `repeat` 'daily' bo'lsa lastResetDate bugungi
   sana bilan solishtirilib hisoblagich nolga tushadi, 'once' bo'lsa u
   hech qachon tiklanmaydi.

   MOSLIK: eski taskCounts map'i endi YOZILMAYDI, lekin O'SHA KUN ichida
   hali ham hisobga olinadi. Aks holda deploy kunida allaqachon 3/3 qilgan
   foydalanuvchi bo'sh taskProgress tufayli limitni yana boshidan
   aylanib o'tishi mumkin edi. Yarim tundan keyin map ahamiyatsiz qoladi. */

/* completeTask FAQAT mustaqil tekshiruv talab qilmaydigan turlarni bajaradi.
   'telegram' verifyTelegram orqali, 'admob' esa AdMob SSV callback orqali
   keladi — aks holda mijoz shunchaki completeTask chaqirib tekshiruvni
   butunlay chetlab o'tardi. */
const SELF_SERVE_VERIFY = ['auto', 'manual', 'trust'];

/* Mukofot maydonining nomi ikki xil: admin panel `reward` yozadi, bazaga
   seed qilingan 16 ta vazifada esa u `coin` deb nomlangan. Ikkalasi ham
   qabul qilinadi, `reward` ustunroq.

   Bu FAQAT ko'rinish masalasi emas edi: bu yerda qiymat topilmasa
   reward 0 bo'lib, vazifa 'bad-task' bilan rad etilardi — ya'ni `coin`
   maydonli vazifalar bosilganda umuman mukofot bermasdi. */
function taskRewardOf(td) {
  const raw = (td && td.reward != null && td.reward !== '') ? td.reward : (td ? td.coin : 0);
  return Math.max(0, Math.floor(Number(raw)) || 0);
}

function taskProgressCount(pd, td, today) {
  if (!pd) return 0;
  if (td.repeat !== 'once' && pd.lastResetDate !== today) return 0;
  return Math.max(0, Math.floor(Number(pd.count)) || 0);
}

/* Vazifani yakunlash — barcha yo'llar (completeTask, verifyTelegram,
   AdMob SSV) shu bitta tranzaksiyadan o'tadi, shuning uchun limit, kunlik
   chegara va mukofot hisobi hamma joyda bir xil. Mukofot MIQDORI faqat
   `tasks` hujjatidan olinadi — chaqiruvchi uni yubora olmaydi. */
async function grantTask(uid, taskId, allowVerify) {
  if (!taskId || taskId.length > 100) throw new HttpsError('invalid-argument', 'bad-task-id');

  const taskRef = db.collection('tasks').doc(taskId);
  const preSnap = await taskRef.get();
  if (!preSnap.exists) throw new HttpsError('not-found', 'task-not-found');

  const userRef = db.collection('users').doc(uid);
  const progRef = userRef.collection('taskProgress').doc(taskId);

  return db.runTransaction(async (tx) => {
    const userDoc = await tx.get(userRef);
    const taskDoc = await tx.get(taskRef);
    const progDoc = await tx.get(progRef);

    if (!userDoc.exists) throw new HttpsError('not-found', 'user-not-found');
    const d = userDoc.data();
    if (d.banned === true) throw new HttpsError('permission-denied', 'banned');

    // Vazifa tranzaksiya ichida qayta o'qiladi — orada o'chirilgan bo'lishi mumkin
    if (!taskDoc.exists) throw new HttpsError('not-found', 'task-not-found');
    const td = taskDoc.data();
    if (td.active !== true) throw new HttpsError('failed-precondition', 'task-inactive');

    const verify = String(td.verify || 'auto');
    if (allowVerify.indexOf(verify) === -1) {
      throw new HttpsError('failed-precondition', 'needs-verification');
    }

    const now = Date.now();
    if (td.startAt && now < td.startAt) throw new HttpsError('failed-precondition', 'not-started');
    if (td.endAt && now > td.endAt) throw new HttpsError('failed-precondition', 'ended');
    if ((td.totalLimit || 0) > 0 && (td.completedCount || 0) >= td.totalLimit) {
      throw new HttpsError('resource-exhausted', 'total-limit');
    }
    const reward = taskRewardOf(td);
    const limit = Math.floor(Number(td.dailyLimit)) || 1;
    const label = td.name || taskId;
    if (reward <= 0) throw new HttpsError('failed-precondition', 'bad-task');

    const today = new Date().toDateString();
    const dailyEarned = d.lastReset === today ? (d.dailyEarned || 0) : 0;

    const legacy = (d.lastReset === today && td.repeat !== 'once')
      ? Math.max(0, Math.floor(Number((d.taskCounts || {})[taskId])) || 0)
      : 0;
    const count = Math.max(taskProgressCount(progDoc.exists ? progDoc.data() : null, td, today), legacy);
    if (count >= limit) throw new HttpsError('resource-exhausted', 'limit');

    const cap = dailyCap(levelOf(d.lifetimeCoins));
    if (dailyEarned >= cap) throw new HttpsError('resource-exhausted', 'dailycap');

    const actual = Math.min(reward, cap - dailyEarned);
    tx.update(userRef, {
      coins: (d.coins || 0) + actual,
      lifetimeCoins: (d.lifetimeCoins || 0) + actual,
      tasksCompletedTotal: (d.tasksCompletedTotal || 0) + 1,
      dailyEarned: dailyEarned + actual,
      lastReset: today,
      ...weeklyPatch(d, actual)
    });
    tx.set(progRef, {
      count: count + 1,
      lastResetDate: today,
      repeat: td.repeat === 'once' ? 'once' : 'daily',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if ((td.totalLimit || 0) > 0) {
      tx.update(taskRef, { completedCount: (td.completedCount || 0) + 1 });
    }
    tx.set(userRef.collection('history').doc(), {
      label, amount: actual, at: FieldValue.serverTimestamp()
    });
    return { reward: actual };
  });
}

exports.completeTask = onCall(async (req) => {
  const uid = requireAuth(req);
  const taskId = String((req.data && req.data.taskId) || '').trim();
  return grantTask(uid, taskId, SELF_SERVE_VERIFY);
});

/* ---------- Telegram kanal a'zoligini tekshirish ----------
   Vazifa hujjatida `tgChat` bo'lishi shart (masalan "@taskup_kanal"), va bot
   o'sha kanalda administrator bo'lishi kerak — aks holda getChatMember
   javob bermaydi.

   Bot tokeni Secret Manager'da: TELEGRAM_BOT_TOKEN (CARD_ENC_KEY bilan bir
   xil uslub). Yangilash:
     firebase functions:secrets:set TELEGRAM_BOT_TOKEN

   Foydalanuvchining Telegram ID'si users/{uid}.telegramId da saqlanadi —
   uni quyidagi telegramWebhook funksiyasi yozadi. */
const TELEGRAM_BOT_TOKEN = defineSecret('TELEGRAM_BOT_TOKEN');
const TG_MEMBER_STATUSES = ['creator', 'administrator', 'member'];

function tgApi(token, method, params) {
  return fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  }).then((r) => r.json());
}

exports.verifyTelegram = onCall({ secrets: [TELEGRAM_BOT_TOKEN] }, async (req) => {
  const uid = requireAuth(req);
  const taskId = String((req.data && req.data.taskId) || '').trim();
  if (!taskId || taskId.length > 100) throw new HttpsError('invalid-argument', 'bad-task-id');

  const taskSnap = await db.collection('tasks').doc(taskId).get();
  if (!taskSnap.exists) throw new HttpsError('not-found', 'task-not-found');
  const td = taskSnap.data();
  if (String(td.verify || '') !== 'telegram') throw new HttpsError('failed-precondition', 'wrong-verify');

  const chat = String(td.tgChat || '').trim();
  if (!chat) throw new HttpsError('failed-precondition', 'tg-chat-missing');

  const userSnap = await db.collection('users').doc(uid).get();
  const tgId = userSnap.exists ? userSnap.data().telegramId : null;
  if (!tgId) throw new HttpsError('failed-precondition', 'tg-not-linked');

  const token = TELEGRAM_BOT_TOKEN.value();
  if (!token) throw new HttpsError('failed-precondition', 'tg-token-missing');

  let body;
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/getChatMember'
      + '?chat_id=' + encodeURIComponent(chat)
      + '&user_id=' + encodeURIComponent(String(tgId)));
    body = await r.json();
  } catch (e) {
    throw new HttpsError('unavailable', 'tg-unreachable');
  }
  if (!body || body.ok !== true) throw new HttpsError('failed-precondition', 'tg-check-failed');
  if (TG_MEMBER_STATUSES.indexOf(body.result && body.result.status) === -1) {
    throw new HttpsError('failed-precondition', 'not-subscribed');
  }

  return grantTask(uid, taskId, ['telegram']);
});

/* ---------- Telegram hisobini bog'lash (bot webhook) ----------
   Ilova foydalanuvchini t.me/<bot>?start=<uid> ga yo'naltiradi. Telegram
   "/start <uid>" xabarini shu funksiyaga yuboradi, biz esa xabar
   egasining Telegram ID'sini users/{uid}.telegramId ga yozamiz.

   XAVFSIZLIK — ikkala nuqta ham majburiy:

   1) Bu ochiq HTTP endpoint. Imzosiz bo'lsa istalgan odam soxta "update"
      yuborib, O'ZINING telegramId'sini BEGONA uid'ga yozib qo'yishi va
      shu orqali boshqa hisobga obuna vazifasini "bajarib" berishi mumkin
      edi. Telegram setWebhook'dagi secret_token'ni har so'rovda
      X-Telegram-Bot-Api-Secret-Token sarlavhasida qaytaradi — shuni
      tekshiramiz. Secret sifatida bot tokenining SHA-256 hex yig'indisi
      ishlatiladi: yangi Secret Manager kaliti kerak emas (kalit
      yaratilmagan bo'lsa `firebase deploy --only functions` BUTUN
      deploy'ni rad etadi), va tokenning o'zi hech qayerda ochilmaydi.
      Telegram secret_token uchun faqat [A-Za-z0-9_-] ruxsat beradi,
      shuning uchun tokenni to'g'ridan-to'g'ri qo'yib bo'lmaydi (unda ':' bor).

   2) Bitta Telegram hisobi ko'p akkauntga bog'lanmasligi kerak, aks holda
      bitta obuna bilan cheksiz akkauntga mukofot olinardi. telegram_links
      teskari indeksi tranzaksiya ichida tekshiriladi.

   Webhook'ni ro'yxatdan o'tkazish (bir marta):
     TOKEN='<bot tokeni>'
     SEC=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
     curl -sS "https://api.telegram.org/bot$TOKEN/setWebhook" \
       -d "url=https://us-central1-taskup-df8ee.cloudfunctions.net/telegramWebhook" \
       -d "secret_token=$SEC" */
const TG_UID_RE = /^[A-Za-z0-9_-]{6,128}$/;

exports.telegramWebhook = onRequest({ secrets: [TELEGRAM_BOT_TOKEN] }, async (req, res) => {
  // Telegram xatolikda qayta yuboradi; mantiqiy rad javoblarida ham 200
  // qaytaramiz, aks holda u bir xil update'ni cheksiz takrorlaydi.
  try {
    if (req.method !== 'POST') { res.status(405).send('method-not-allowed'); return; }

    const token = TELEGRAM_BOT_TOKEN.value();
    if (!token) { res.status(500).send('no-token'); return; }

    const expected = crypto.createHash('sha256').update(token).digest('hex');
    const got = String(req.get('X-Telegram-Bot-Api-Secret-Token') || '');
    // Doimiy vaqtli solishtirish — sarlavha tashqaridan keladi
    const a = Buffer.from(expected), bb = Buffer.from(got.padEnd(expected.length).slice(0, expected.length));
    if (got.length !== expected.length || !crypto.timingSafeEqual(a, bb)) {
      res.status(403).send('bad-secret');
      return;
    }

    const msg = (req.body && (req.body.message || req.body.edited_message)) || null;
    const from = msg && msg.from;
    const text = String((msg && msg.text) || '');
    if (!from || !from.id || !text.startsWith('/start')) { res.status(200).send('ignored'); return; }

    const tgId = String(from.id);
    const uid = text.split(/\s+/)[1] || '';
    const reply = (t) => tgApi(token, 'sendMessage', { chat_id: from.id, text: t }).catch(() => {});

    if (!uid) {
      await reply('Hisobni bog\'lash uchun TaskUp ilovasidagi Telegram vazifasini bosing — havola sizni shu yerga o\'zi olib keladi.');
      res.status(200).send('no-payload');
      return;
    }
    if (!TG_UID_RE.test(uid)) {
      await reply('Havola noto\'g\'ri. Iltimos, TaskUp ilovasidan qaytadan urinib ko\'ring.');
      res.status(200).send('bad-uid');
      return;
    }

    const userRef = db.collection('users').doc(uid);
    const linkRef = db.collection('telegram_links').doc(tgId);

    const outcome = await db.runTransaction(async (tx) => {
      const [userDoc, linkDoc] = [await tx.get(userRef), await tx.get(linkRef)];
      if (!userDoc.exists) return 'no-user';
      if (userDoc.data().banned === true) return 'banned';
      if (linkDoc.exists && linkDoc.data().uid !== uid) return 'taken';

      tx.update(userRef, { telegramId: tgId });
      tx.set(linkRef, { uid, at: FieldValue.serverTimestamp() }, { merge: true });
      return 'ok';
    });

    if (outcome === 'ok') {
      await reply('✅ Telegram hisobingiz TaskUp bilan bog\'landi. Endi ilovaga qaytib "Tekshirish" tugmasini bosing.');
    } else if (outcome === 'taken') {
      await reply('⚠️ Bu Telegram hisobi boshqa TaskUp akkauntiga bog\'langan.');
    } else if (outcome === 'banned') {
      await reply('Hisobingiz bloklangan.');
    } else {
      await reply('TaskUp akkaunti topilmadi. Ilovaga kirib, vazifani qaytadan bosing.');
    }
    res.status(200).send(outcome);
  } catch (err) {
    console.error('telegramWebhook:', err);
    res.status(200).send('error');
  }
});

/* ---------- AdMob server-side verification (SSV) ----------
   AdMob rewarded reklama ko'rilgach Google shu manzilga GET so'rov yuboradi.
   Mukofot MIJOZDAN emas, aynan shu callback'dan beriladi — shuning uchun
   imzo tekshirilmasa har kim URL'ni qo'lda chaqirib tanga yoza olardi.

   Imzo: so'rov satrining boshidan "&signature=" gacha bo'lgan qismi ustidan
   ECDSA-SHA256. Ochiq kalitlar Google'da e'lon qilinadi va key_id bo'yicha
   tanlanadi. Kalitlar xotirada 24 soat keshlanadi.

   AdMob konsolida: SSV callback URL sifatida shu funksiya manzili,
   user_id -> Firebase uid, custom_data -> taskId qilib sozlanadi. */
const ADMOB_KEYS_URL = 'https://gstatic.com/admob/reward/verifier-keys.json';
let admobKeyCache = { at: 0, keys: null };

async function admobKeys() {
  if (admobKeyCache.keys && Date.now() - admobKeyCache.at < 24 * 3600 * 1000) return admobKeyCache.keys;
  const r = await fetch(ADMOB_KEYS_URL);
  const j = await r.json();
  const map = {};
  (j.keys || []).forEach((k) => { map[String(k.keyId)] = k.pem; });
  admobKeyCache = { at: Date.now(), keys: map };
  return map;
}

exports.admobSsv = onRequest(async (req, res) => {
  try {
    const qs = String(req.originalUrl || req.url || '').split('?')[1] || '';
    const cut = qs.indexOf('&signature=');
    if (cut === -1) { res.status(400).send('no-signature'); return; }
    const signed = qs.slice(0, cut);

    const q = req.query || {};
    const keys = await admobKeys();
    const pem = keys[String(q.key_id)];
    if (!pem) { res.status(400).send('unknown-key'); return; }

    const ok = crypto.createVerify('SHA256')
      .update(signed)
      .verify(pem, Buffer.from(String(q.signature), 'base64url'));
    if (!ok) { res.status(403).send('bad-signature'); return; }

    const uid = String(q.user_id || '').trim();
    const taskId = String(q.custom_data || '').trim();
    const txId = String(q.transaction_id || '').trim();
    if (!uid || !taskId || !txId) { res.status(400).send('missing-params'); return; }

    // Takroriy callback ikkinchi marta tanga bermasin
    try {
      await db.collection('admob_ssv').doc(txId).create({
        uid, taskId, at: FieldValue.serverTimestamp()
      });
    } catch (e) {
      res.status(200).send('duplicate');
      return;
    }

    await grantTask(uid, taskId, ['admob']);
    res.status(200).send('ok');
  } catch (err) {
    console.error('admobSsv:', err);
    // Google 5xx da qayta uriniladi; mantiqiy rad javoblari yuqorida 4xx
    res.status(500).send('error');
  }
});

/* ---------- Vazifa bosqichlari (sandiqlar) ----------
   30 / 50 / 100 ta bajarilgan vazifa uchun bir martalik mukofot.
   Chegara ham, mukofot miqdori ham SERVERDA belgilangan: mijoz faqat
   qaysi sandiqni ochmoqchi ekanini yuboradi. Har bir sandiq bir marta
   olinadi — claimedMilestones ro'yxati tranzaksiya ichida tekshiriladi,
   shuning uchun ikki marta bosish yoki parallel so'rov ikkinchi marta
   to'lamaydi. Kunlik limit (dailyEarned/cap) bu mukofotga TA'SIR QILMAYDI:
   bu vazifa daromadi emas, bir martalik bosqich mukofoti. */
const TASK_MILESTONES = [
  { id: 'm30',  tasks: 30,  reward: 300  },
  { id: 'm50',  tasks: 50,  reward: 500  },
  { id: 'm100', tasks: 100, reward: 1500 }
];

exports.claimMilestone = onCall(async (req) => {
  const uid = requireAuth(req);
  const id = String((req.data && req.data.id) || '').trim();
  const ms = TASK_MILESTONES.find((m) => m.id === id);
  if (!ms) throw new HttpsError('invalid-argument', 'bad-milestone');

  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (!doc.exists) throw new HttpsError('not-found', 'user-not-found');
    const d = doc.data();
    if (d.banned === true) throw new HttpsError('permission-denied', 'banned');

    const done = Math.floor(Number(d.tasksCompletedTotal)) || 0;
    if (done < ms.tasks) throw new HttpsError('failed-precondition', 'not-enough-tasks');

    const claimed = Array.isArray(d.claimedMilestones) ? d.claimedMilestones : [];
    if (claimed.indexOf(ms.id) !== -1) throw new HttpsError('already-exists', 'already-claimed');

    tx.update(userRef, {
      coins: (d.coins || 0) + ms.reward,
      lifetimeCoins: (d.lifetimeCoins || 0) + ms.reward,
      claimedMilestones: claimed.concat([ms.id]),
      ...weeklyPatch(d, ms.reward)
    });
    tx.set(userRef.collection('history').doc(), {
      label: `${ms.tasks} ta vazifa sandig'i`, amount: ms.reward, at: FieldValue.serverTimestamp()
    });
    return { reward: ms.reward, id: ms.id };
  });
});

/* ---------- Kunlik bonus (streak) ---------- */
exports.claimStreak = onCall(async (req) => {
  const uid = requireAuth(req);
  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (!doc.exists) throw new HttpsError('not-found', 'user-not-found');
    const d = doc.data();
    if (d.banned === true) throw new HttpsError('permission-denied', 'banned');

    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (d.lastStreakClaim === today) throw new HttpsError('failed-precondition', 'already-claimed');

    const continuing = d.lastStreakClaim === yesterday;
    const newStreak = continuing ? (d.streakCount || 0) + 1 : 1;
    const bonus = Math.min(500, 200 + (newStreak - 1) * 50);

    tx.update(userRef, {
      coins: (d.coins || 0) + bonus,
      lifetimeCoins: (d.lifetimeCoins || 0) + bonus,
      streakCount: newStreak,
      lastStreakClaim: today,
      ...weeklyPatch(d, bonus)
    });
    tx.set(userRef.collection('history').doc(), {
      label: `Kunlik bonus (${newStreak})`, amount: bonus, at: FieldValue.serverTimestamp()
    });
    return { bonus, streak: newStreak };
  });
});

/* ---------- Pul yechish so'rovi ---------- */
exports.requestCashout = onCall({ secrets: [CARD_ENC_KEY] }, async (req) => {
  const uid = requireAuth(req);
  const data = req.data || {};
  const amount = Math.floor(Number(data.amount)) || 0;
  const cardNumber = String(data.cardNumber || '').replace(/\s/g, '');
  const cardExpiry = String(data.cardExpiry || '').trim();
  const cardHolder = String(data.cardHolder || '').trim().slice(0, 60);
  const payMethod = PAY_METHODS.includes(data.payMethod) ? data.payMethod : 'uzcard';

  if (amount < CASHOUT_MIN) throw new HttpsError('failed-precondition', 'below-min');
  if (!/^\d{16}$/.test(cardNumber)) throw new HttpsError('invalid-argument', 'bad-card-number');
  if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(cardExpiry)) throw new HttpsError('invalid-argument', 'bad-card-expiry');
  if (cardHolder.length < 3) throw new HttpsError('invalid-argument', 'bad-card-holder');

  /* Karta raqami va muddati OCHIQ saqlanmaydi — shifrlangan blob sifatida
     yoziladi. Ochiq holda faqat oxirgi 4 raqam (ko'rsatish uchun) va karta
     egasining ismi (o'tkazmani amalga oshirish uchun) qoladi.
     Shifrni ochish faqat revealCashoutCard (admin) orqali mumkin. */
  const cardLast4 = cardNumber.slice(-4);
  const cardEnc = encryptCard(JSON.stringify({ number: cardNumber, expiry: cardExpiry }));

  const userRef = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (!doc.exists) throw new HttpsError('not-found', 'user-not-found');
    const d = doc.data();
    if (d.banned === true) throw new HttpsError('permission-denied', 'banned');
    if ((d.coins || 0) < amount) throw new HttpsError('failed-precondition', 'insufficient');

    tx.update(userRef, {
      coins: d.coins - amount,
      cashedOutTotal: (d.cashedOutTotal || 0) + amount
    });
    tx.set(db.collection('cashout_requests').doc(), {
      uid,
      email: d.email || '',
      amountCoins: amount,
      amountSom: Math.round(amount * COIN_TO_SOM),
      payMethod, cardHolder, cardLast4, cardEnc,
      status: 'pending',
      requestedAt: FieldValue.serverTimestamp()
    });
    tx.set(userRef.collection('history').doc(), {
      label: "Pul yechish so'rovi", amount: -amount, at: FieldValue.serverTimestamp()
    });
  });
  return { ok: true, amount };
});

/* ---------- Karta ma'lumotini ochish (FAQAT ADMIN) ----------
   To'lovni amalga oshirish paytida admin to'liq karta raqamini ko'rishi kerak.
   Har bir ochish hujjatga yozib boriladi (audit izi). */
exports.revealCashoutCard = onCall({ secrets: [CARD_ENC_KEY] }, async (req) => {
  const uid = requireAuth(req);
  await requireAdmin(uid);

  const requestId = String((req.data && req.data.requestId) || '').trim();
  if (!requestId || requestId.length > 200) throw new HttpsError('invalid-argument', 'bad-request-id');

  const ref = db.collection('cashout_requests').doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'request-not-found');
  const d = snap.data();

  let cardNumber, cardExpiry, legacy = false;
  if (d.cardEnc) {
    let parsed;
    try {
      parsed = JSON.parse(decryptCard(d.cardEnc));
    } catch (e) {
      // Kalit noto'g'ri yoki ma'lumot buzilgan — sababini oshkor qilmaymiz
      console.error('decrypt failed for', requestId, e && e.message);
      throw new HttpsError('failed-precondition', 'decrypt-failed');
    }
    cardNumber = String(parsed.number || '');
    cardExpiry = String(parsed.expiry || '');
  } else {
    // Shifrlash joriy qilinishidan OLDIN yaratilgan yozuvlar
    cardNumber = String(d.cardNumber || '');
    cardExpiry = String(d.cardExpiry || '');
    legacy = true;
  }

  await ref.update({
    lastRevealedBy: uid,
    lastRevealedAt: FieldValue.serverTimestamp(),
    revealCount: FieldValue.increment(1)
  });

  return { cardNumber, cardExpiry, cardHolder: d.cardHolder || '', legacy };
});

/* ---------- Hisobni butunlay o'chirish (foydalanuvchining o'z so'rovi bilan) ----------
   Google Play "Data deletion" talabi. Tartib: avval ma'lumotlar, eng oxirida
   Auth hisobi — agar oraliqda xato bo'lsa, foydalanuvchi qayta urinib ko'ra oladi. */
async function deleteSubcollection(parentRef, name) {
  let removed = 0;
  for (;;) {
    const snap = await parentRef.collection(name).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    removed += snap.size;
    if (snap.size < 400) break;
  }
  return removed;
}

exports.deleteAccount = onCall(async (req) => {
  const uid = requireAuth(req);

  // Kutilayotgan to'lov bo'lsa o'chirmaymiz — aks holda pul yo'qoladi
  const pending = await db.collection('cashout_requests')
    .where('uid', '==', uid).where('status', '==', 'pending').limit(1).get();
  if (!pending.empty) throw new HttpsError('failed-precondition', 'pending-cashout');

  const userRef = db.collection('users').doc(uid);

  // 1) Tranzaksiya tarixi (subkolleksiya)
  const historyDeleted = await deleteSubcollection(userRef, 'history');

  // 2) Yakunlangan to'lov so'rovlari — buxgalteriya uchun summa/sana qoladi,
  //    lekin shaxsni aniqlaydigan va karta ma'lumotlari o'chiriladi
  const oldReqs = await db.collection('cashout_requests').where('uid', '==', uid).get();
  let anonymized = 0;
  for (let i = 0; i < oldReqs.size; i += 400) {
    const batch = db.batch();
    oldReqs.docs.slice(i, i + 400).forEach(doc => {
      batch.update(doc.ref, {
        uid: FieldValue.delete(), email: FieldValue.delete(),
        cardEnc: FieldValue.delete(), cardNumber: FieldValue.delete(),
        cardExpiry: FieldValue.delete(), cardHolder: FieldValue.delete(),
        cardLast4: FieldValue.delete(),
        accountDeleted: true, accountDeletedAt: FieldValue.serverTimestamp()
      });
      anonymized++;
    });
    await batch.commit();
  }

  // 3) Qurilma reyestridan uid ni olib tashlaymiz
  const devs = await db.collection('devices').where('uids', 'array-contains', uid).get();
  if (!devs.empty) {
    const batch = db.batch();
    devs.docs.forEach(doc => batch.update(doc.ref, { uids: FieldValue.arrayRemove(uid) }));
    await batch.commit();
  }

  // 4) Storage'dagi profil rasmlari
  let storageDeleted = true;
  try {
    await getStorage().bucket().deleteFiles({ prefix: `avatars/${uid}/` });
  } catch (e) {
    storageDeleted = false;
    console.error('storage delete failed for', uid, e && e.message);
  }

  // 5) Foydalanuvchi hujjati
  await userRef.delete();

  // 6) Auth hisobi — eng oxirida
  await getAuth().deleteUser(uid);

  console.log('account deleted', uid, { historyDeleted, anonymized, devices: devs.size, storageDeleted });
  return { ok: true, historyDeleted, cashoutsAnonymized: anonymized, devicesCleaned: devs.size, storageDeleted };
});

/* ---------- Referral kodini ishlatish ---------- */
exports.redeemReferral = onCall(async (req) => {
  const uid = requireAuth(req);
  const code = String((req.data && req.data.code) || '').trim().toUpperCase();
  if (!code || code.length > 30) throw new HttpsError('invalid-argument', 'bad-code');

  const meRef = db.collection('users').doc(uid);
  const meSnap = await meRef.get();
  if (!meSnap.exists) throw new HttpsError('not-found', 'user-not-found');
  if (meSnap.data().referredBy) throw new HttpsError('failed-precondition', 'already-redeemed');
  if ((meSnap.data().referralCode || '').toUpperCase() === code) throw new HttpsError('failed-precondition', 'own-code');

  /* limit(2): eski hisoblarda referal kodi uid'ning atigi 4 ta belgisidan
     hosil qilingan va to'qnashishi mumkin. Avval limit(1) ishlatilardi —
     to'qnashuvda bonus jimgina BOSHQA odamga ketardi. Endi noaniqlik
     aniqlanadi va so'rov rad etiladi (admin qo'lda hal qiladi). */
  const q = await db.collection('users').where('referralCode', '==', code).limit(2).get();
  if (q.empty) throw new HttpsError('not-found', 'code-not-found');
  if (q.size > 1) throw new HttpsError('failed-precondition', 'ambiguous-code');
  const refUserRef = q.docs[0].ref;
  if (refUserRef.id === uid) throw new HttpsError('failed-precondition', 'own-code');

  await db.runTransaction(async (tx) => {
    const me = await tx.get(meRef);
    const refUser = await tx.get(refUserRef);
    if (me.data().referredBy) throw new HttpsError('failed-precondition', 'already-redeemed');
    const rd = refUser.data();

    tx.update(meRef, {
      referredBy: refUserRef.id,
      coins: (me.data().coins || 0) + REFERRAL_BONUS_NEWUSER,
      lifetimeCoins: (me.data().lifetimeCoins || 0) + REFERRAL_BONUS_NEWUSER,
      ...weeklyPatch(me.data(), REFERRAL_BONUS_NEWUSER)
    });
    tx.set(meRef.collection('history').doc(), {
      label: 'Referral bonus', amount: REFERRAL_BONUS_NEWUSER, at: FieldValue.serverTimestamp()
    });
    tx.update(refUserRef, {
      coins: (rd.coins || 0) + REFERRAL_BONUS_REFERRER,
      lifetimeCoins: (rd.lifetimeCoins || 0) + REFERRAL_BONUS_REFERRER,
      friendsCount: (rd.friendsCount || 0) + 1,
      friendsBonus: (rd.friendsBonus || 0) + REFERRAL_BONUS_REFERRER,
      ...weeklyPatch(rd, REFERRAL_BONUS_REFERRER)
    });
    tx.set(refUserRef.collection('history').doc(), {
      label: "Do'st taklifi bonusi", amount: REFERRAL_BONUS_REFERRER, at: FieldValue.serverTimestamp()
    });
  });
  return { bonus: REFERRAL_BONUS_NEWUSER };
});

/* ---------- 🎡 Omadli g'ildirak (kuniga 1 marta) ---------- */
const SPIN_PRIZES = [10, 20, 30, 50, 70, 100, 200, 500];
const SPIN_WEIGHTS = [30, 22, 16, 12, 9, 6, 4, 1]; // katta yutuq kamroq chiqadi

exports.spinWheel = onCall(async (req) => {
  const uid = requireAuth(req);
  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (!doc.exists) throw new HttpsError('not-found', 'user-not-found');
    const d = doc.data();
    if (d.banned === true) throw new HttpsError('permission-denied', 'banned');
    const today = new Date().toDateString();
    if (d.lastSpin === today) throw new HttpsError('failed-precondition', 'already-spun');

    let idx;
    if (d.firstSpinUsed !== true) {
      // ENG BIRINCHI aylantirish: har doim eng katta (500) yoki
      // ikkinchi eng katta (200) yutuq — server belgilaydi
      idx = Math.random() < 0.5 ? SPIN_PRIZES.length - 1 : SPIN_PRIZES.length - 2;
    } else {
      // Keyingi aylantirishlar: oddiy og'irlikli tasodif
      const total = SPIN_WEIGHTS.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      idx = 0;
      for (let i = 0; i < SPIN_WEIGHTS.length; i++) { r -= SPIN_WEIGHTS[i]; if (r <= 0) { idx = i; break; } }
    }
    const prize = SPIN_PRIZES[idx];

    tx.update(userRef, {
      coins: (d.coins || 0) + prize,
      lifetimeCoins: (d.lifetimeCoins || 0) + prize,
      lastSpin: today,
      firstSpinUsed: true,
      ...weeklyPatch(d, prize)
    });
    tx.set(userRef.collection('history').doc(), {
      label: "Omadli g'ildirak", amount: prize, at: FieldValue.serverTimestamp()
    });
    return { prize, index: idx };
  });
});

/* ---------- 🎁 Promo kod ---------- */
exports.redeemPromo = onCall(async (req) => {
  const uid = requireAuth(req);
  const code = String((req.data && req.data.code) || '').trim().toUpperCase();
  if (!code || code.length > 30 || !/^[A-Z0-9_-]+$/.test(code)) throw new HttpsError('invalid-argument', 'bad-code');

  const promoRef = db.collection('promo_codes').doc(code);
  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async (tx) => {
    const promoDoc = await tx.get(promoRef);
    const userDoc = await tx.get(userRef);
    if (!promoDoc.exists) throw new HttpsError('not-found', 'code-not-found');
    if (!userDoc.exists) throw new HttpsError('not-found', 'user-not-found');
    const p = promoDoc.data(), d = userDoc.data();
    if (d.banned === true) throw new HttpsError('permission-denied', 'banned');
    if (p.active !== true) throw new HttpsError('failed-precondition', 'code-inactive');
    if ((p.maxUses || 0) > 0 && (p.usedCount || 0) >= p.maxUses) throw new HttpsError('resource-exhausted', 'code-exhausted');
    const used = d.usedPromos || [];
    if (used.includes(code)) throw new HttpsError('failed-precondition', 'already-used');
    const reward = Math.floor(Number(p.reward)) || 0;
    if (reward <= 0) throw new HttpsError('failed-precondition', 'bad-code');

    tx.update(promoRef, { usedCount: (p.usedCount || 0) + 1 });
    tx.update(userRef, {
      coins: (d.coins || 0) + reward,
      lifetimeCoins: (d.lifetimeCoins || 0) + reward,
      usedPromos: [...used, code],
      ...weeklyPatch(d, reward)
    });
    tx.set(userRef.collection('history').doc(), {
      label: 'Promo kod: ' + code, amount: reward, at: FieldValue.serverTimestamp()
    });
    return { reward };
  });
});

/* ---------- 🏆 Reyting (haftalik / umumiy / referal) ---------- */
exports.getLeaderboard = onCall(async (req) => {
  const uid = requireAuth(req);
  const period = String((req.data && req.data.period) || 'all');
  const field = period === 'weekly' ? 'weeklyCoins' : period === 'referrals' ? 'friendsCount' : 'lifetimeCoins';
  const snap = await db.collection('users').orderBy(field, 'desc').limit(25).get();
  const ws = weekStampNow();
  const top = [];
  snap.forEach((doc) => {
    if (top.length >= 10) return;
    const d = doc.data();
    if (d.banned === true) return;
    let value = d[field] || 0;
    if (period === 'weekly' && d.weekStamp !== ws) value = 0;
    if (value <= 0) return;
    top.push({ name: maskEmail(d.email), value, me: doc.id === uid, avatarUrl: d.avatarUrl || '', lifetimeCoins: d.lifetimeCoins || 0 });
  });
  return { period, top };
});

/* ---------- 🏆 Haftalik TOP-3 mukofoti (har dushanba 00:10, Toshkent) ---------- */
exports.weeklyRewards = onSchedule({ schedule: '10 0 * * 1', timeZone: 'Asia/Tashkent' }, async () => {
  const snap = await db.collection('users').orderBy('weeklyCoins', 'desc').limit(30).get();
  const nowWs = weekStampNow();
  const winners = [];
  snap.forEach((doc) => {
    if (winners.length >= 3) return;
    const d = doc.data();
    if (d.banned === true) return;
    if (d.weekStamp === nowWs) return; // yangi hafta hisobiga o'tib bo'lgan
    if ((d.weeklyCoins || 0) <= 0) return;
    winners.push({ ref: doc.ref, d });
  });
  const prizes = [5000, 3000, 2000];
  for (let i = 0; i < winners.length; i++) {
    const { ref, d } = winners[i];
    await ref.update({
      coins: (d.coins || 0) + prizes[i],
      lifetimeCoins: (d.lifetimeCoins || 0) + prizes[i]
    });
    await ref.collection('history').add({
      label: `Haftalik TOP-${i + 1} mukofoti 🏆`, amount: prizes[i], at: FieldValue.serverTimestamp()
    });
  }
  if (winners.length) {
    await db.collection('news').add({
      title: "🏆 Haftalik TOP g'oliblari!",
      text: winners.map((w, i) => `${i + 1}-o'rin: ${maskEmail(w.d.email)} — +${prizes[i]} tanga`).join('\n') +
        "\nSiz ham keyingi hafta g'olib bo'ling — vazifalarni bajaring!",
      createdAt: FieldValue.serverTimestamp()
    });
  }
});

/* ---------- 🛡️ Qurilma nazorati (multi-akkaunt aniqlash) ----------
   Bitta qurilmada 3 va undan ortiq akkaunt ochilsa, ular avtomatik BAN
   qilinmaydi — faqat "tekshiruvda" (flagged) belgisi qo'yiladi, admin
   panelda ko'rinadi va admin o'zi qaror qabul qiladi. */
const DEVICE_ACCOUNT_LIMIT = 3;

exports.registerDevice = onCall(async (req) => {
  const uid = requireAuth(req);
  const deviceId = String((req.data && req.data.deviceId) || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(deviceId)) throw new HttpsError('invalid-argument', 'bad-device');

  const ipRaw = (req.rawRequest && (req.rawRequest.headers['x-forwarded-for'] || req.rawRequest.ip)) || '';
  const ip = String(ipRaw).split(',')[0].trim().slice(0, 45);

  const devRef = db.collection('devices').doc(deviceId);
  const uidsNow = await db.runTransaction(async (tx) => {
    const doc = await tx.get(devRef);
    const d = doc.exists ? doc.data() : {};
    const uids = Array.isArray(d.uids) ? d.uids.slice(0, 20) : [];
    if (!uids.includes(uid)) uids.push(uid);
    tx.set(devRef, { uids, lastSeen: FieldValue.serverTimestamp(), lastIp: ip }, { merge: true });
    return uids;
  });

  let flaggedMe = false;
  if (uidsNow.length >= DEVICE_ACCOUNT_LIMIT) {
    flaggedMe = true;
    for (const u of uidsNow) {
      await db.collection('users').doc(u).update({
        flagged: true, flagReason: 'multi-account', flaggedAt: FieldValue.serverTimestamp()
      }).catch(() => {});
    }
  }
  return { flagged: flaggedMe };
});
