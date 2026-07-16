/**
 * TaskUp — server tomonidagi tanga mantiqi (anti-cheat).
 * Barcha tanga o'zgarishlari faqat shu funksiyalar orqali bo'ladi;
 * Firestore qoidalari foydalanuvchiga tanga maydonlarini yozishni taqiqlaydi.
 */
process.env.TZ = 'Asia/Tashkent';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

const XP_PER_LEVEL = 1000;
const DAILY_CAP_BASE = 3000;
const DAILY_CAP_PER_LEVEL = 250;
const DAILY_CAP_MAX_LEVEL = 10;
const CASHOUT_MIN = 10000;
const COIN_TO_SOM = 1.2;
const REFERRAL_BONUS_REFERRER = 1000; // taklif qilgan odamga
const REFERRAL_BONUS_NEWUSER = 500;   // kodni kiritgan yangi foydalanuvchiga
const PAY_METHODS = ['uzcard', 'humo', 'payme', 'click'];

// index.html'dagi standart (Firestore'da bo'lmagan) vazifalar bilan bir xil
const DEFAULT_TASKS = {
  video:    { reward: 50,   dailyLimit: 8,  label: "Video ko'rish" },
  download: { reward: 120,  dailyLimit: 3,  label: 'Ilova yuklash' },
  survey:   { reward: 80,   dailyLimit: 1,  label: "So'rovnomada ishtirok etish" },
  ad:       { reward: 40,   dailyLimit: 10, label: "Reklama ko'rish" },
  telegram: { reward: 70,   dailyLimit: 1,  label: 'Telegram kanalga obuna' },
  rate:     { reward: 150,  dailyLimit: 1,  label: "O'yin o'ynab baho berish" }
};

function levelOf(lifetimeCoins) { return Math.floor((lifetimeCoins || 0) / XP_PER_LEVEL) + 1; }
function dailyCap(level) {
  return DAILY_CAP_BASE + (Math.min(Math.max(1, level), DAILY_CAP_MAX_LEVEL) - 1) * DAILY_CAP_PER_LEVEL;
}
function requireAuth(req) {
  if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'login-required');
  return req.auth.uid;
}

/* ---------- Vazifani bajarish ---------- */
exports.completeTask = onCall(async (req) => {
  const uid = requireAuth(req);
  const taskId = String((req.data && req.data.taskId) || '').trim();
  if (!taskId || taskId.length > 100) throw new HttpsError('invalid-argument', 'bad-task-id');

  const taskRef = db.collection('tasks').doc(taskId);
  const preSnap = await taskRef.get();
  if (!preSnap.exists && !DEFAULT_TASKS[taskId]) throw new HttpsError('not-found', 'task-not-found');
  const isCatalogTask = preSnap.exists;

  const userRef = db.collection('users').doc(uid);
  return db.runTransaction(async (tx) => {
    const userDoc = await tx.get(userRef);
    const taskDoc = isCatalogTask ? await tx.get(taskRef) : null;

    if (!userDoc.exists) throw new HttpsError('not-found', 'user-not-found');
    const d = userDoc.data();
    if (d.banned === true) throw new HttpsError('permission-denied', 'banned');

    let reward, limit, label, td = null;
    if (taskDoc && taskDoc.exists) {
      td = taskDoc.data();
      if (td.active !== true) throw new HttpsError('failed-precondition', 'task-inactive');
      const now = Date.now();
      if (td.startAt && now < td.startAt) throw new HttpsError('failed-precondition', 'not-started');
      if (td.endAt && now > td.endAt) throw new HttpsError('failed-precondition', 'ended');
      if ((td.totalLimit || 0) > 0 && (td.completedCount || 0) >= td.totalLimit) {
        throw new HttpsError('resource-exhausted', 'total-limit');
      }
      reward = Math.floor(Number(td.reward)) || 0;
      limit = Math.floor(Number(td.dailyLimit)) || 1;
      label = td.name || taskId;
    } else if (DEFAULT_TASKS[taskId]) {
      ({ reward, dailyLimit: limit, label } = DEFAULT_TASKS[taskId]);
    } else {
      throw new HttpsError('not-found', 'task-not-found');
    }
    if (reward <= 0) throw new HttpsError('failed-precondition', 'bad-task');

    const today = new Date().toDateString();
    let taskCounts = d.taskCounts || {};
    let dailyEarned = d.dailyEarned || 0;
    if (d.lastReset !== today) { taskCounts = {}; dailyEarned = 0; }

    const count = taskCounts[taskId] || 0;
    if (count >= limit) throw new HttpsError('resource-exhausted', 'limit');

    const cap = dailyCap(levelOf(d.lifetimeCoins));
    if (dailyEarned >= cap) throw new HttpsError('resource-exhausted', 'dailycap');

    const actual = Math.min(reward, cap - dailyEarned);
    tx.update(userRef, {
      coins: (d.coins || 0) + actual,
      lifetimeCoins: (d.lifetimeCoins || 0) + actual,
      tasksCompletedTotal: (d.tasksCompletedTotal || 0) + 1,
      dailyEarned: dailyEarned + actual,
      taskCounts: { ...taskCounts, [taskId]: count + 1 },
      lastReset: today
    });
    if (td && (td.totalLimit || 0) > 0) {
      tx.update(taskRef, { completedCount: (td.completedCount || 0) + 1 });
    }
    tx.set(userRef.collection('history').doc(), {
      label, amount: actual, at: FieldValue.serverTimestamp()
    });
    return { reward: actual };
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
      lastStreakClaim: today
    });
    tx.set(userRef.collection('history').doc(), {
      label: `Kunlik bonus (${newStreak})`, amount: bonus, at: FieldValue.serverTimestamp()
    });
    return { bonus, streak: newStreak };
  });
});

/* ---------- Pul yechish so'rovi ---------- */
exports.requestCashout = onCall(async (req) => {
  const uid = requireAuth(req);
  const data = req.data || {};
  const cardNumber = String(data.cardNumber || '').replace(/\s/g, '');
  const cardExpiry = String(data.cardExpiry || '').trim();
  const cardHolder = String(data.cardHolder || '').trim().slice(0, 60);
  const payMethod = PAY_METHODS.includes(data.payMethod) ? data.payMethod : 'uzcard';

  if (!/^\d{16}$/.test(cardNumber)) throw new HttpsError('invalid-argument', 'bad-card-number');
  if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(cardExpiry)) throw new HttpsError('invalid-argument', 'bad-card-expiry');
  if (cardHolder.length < 3) throw new HttpsError('invalid-argument', 'bad-card-holder');

  const userRef = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (!doc.exists) throw new HttpsError('not-found', 'user-not-found');
    const d = doc.data();
    if (d.banned === true) throw new HttpsError('permission-denied', 'banned');
    if ((d.coins || 0) < CASHOUT_MIN) throw new HttpsError('failed-precondition', 'insufficient');

    tx.update(userRef, {
      coins: d.coins - CASHOUT_MIN,
      cashedOutTotal: (d.cashedOutTotal || 0) + CASHOUT_MIN
    });
    tx.set(db.collection('cashout_requests').doc(), {
      uid,
      email: d.email || '',
      amountCoins: CASHOUT_MIN,
      amountSom: Math.round(CASHOUT_MIN * COIN_TO_SOM),
      payMethod, cardNumber, cardExpiry, cardHolder,
      status: 'pending',
      requestedAt: FieldValue.serverTimestamp()
    });
    tx.set(userRef.collection('history').doc(), {
      label: "Pul yechish so'rovi", amount: -CASHOUT_MIN, at: FieldValue.serverTimestamp()
    });
  });
  return { ok: true };
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

  const q = await db.collection('users').where('referralCode', '==', code).limit(1).get();
  if (q.empty) throw new HttpsError('not-found', 'code-not-found');
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
      lifetimeCoins: (me.data().lifetimeCoins || 0) + REFERRAL_BONUS_NEWUSER
    });
    tx.set(meRef.collection('history').doc(), {
      label: 'Referral bonus', amount: REFERRAL_BONUS_NEWUSER, at: FieldValue.serverTimestamp()
    });
    tx.update(refUserRef, {
      coins: (rd.coins || 0) + REFERRAL_BONUS_REFERRER,
      lifetimeCoins: (rd.lifetimeCoins || 0) + REFERRAL_BONUS_REFERRER,
      friendsCount: (rd.friendsCount || 0) + 1,
      friendsBonus: (rd.friendsBonus || 0) + REFERRAL_BONUS_REFERRER
    });
    tx.set(refUserRef.collection('history').doc(), {
      label: "Do'st taklifi bonusi", amount: REFERRAL_BONUS_REFERRER, at: FieldValue.serverTimestamp()
    });
  });
  return { bonus: REFERRAL_BONUS_NEWUSER };
});
