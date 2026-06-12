/*
 * سيرفر مدينة القنايات 3D — حسابات + لاعبين + محلات + أدمن
 *
 * التشغيل:  npm install  ثم  npm start
 * أول تشغيل بينشئ حساب أدمن افتراضي:  admin / admin123  (غيّر الباسورد!)
 * كل البيانات بتتحفظ في db.json جنب السيرفر.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4173;
const PUBLIC = path.join(__dirname, 'public');
const DB_FILE = path.join(__dirname, 'db.json');
const ENV_FILE = path.join(__dirname, '.env');
const ERROR_LOG = path.join(__dirname, 'server-errors.log');

function logServerError(label, err) {
  const msg = `[${new Date().toISOString()}] ${label}\n${err?.stack || err}\n\n`;
  try { fs.appendFileSync(ERROR_LOG, msg); } catch {}
  console.error(msg);
}

process.on('uncaughtException', (err) => logServerError('uncaughtException', err));
process.on('unhandledRejection', (err) => logServerError('unhandledRejection', err));
process.on('exit', (code) => {
  try { fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] exit ${code}\n\n`); } catch {}
});

try {
  const envText = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const npcHistory = new Map();

/* ================= قاعدة البيانات ================= */
const MONGODB_URI = process.env.MONGODB_URI || '';
let mongoClient = null;
let mongoCollection = null;

let db = {
  users: {},
  stores: [],
  orders: [],
  nextStoreId: 1,
  nextOrderId: 1,
  settings: {
    news: { text: '', everyMinutes: 10, times: 3 },
    education: { videoUrl: '', desc: 'مجمع تعليمي بالقنايات - بث ومحتوى يحدده الأدمن.', mode: 'recorded', liveOn: false, liveStartedAt: 0 },
  },
};

function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 64).toString('hex');
}
function normalizePhone(phone) {
  return String(phone || '').replace(/\s+/g, '').slice(0, 20);
}
function findUserByPhone(phone) {
  const wanted = normalizePhone(phone);
  if (!wanted) return null;
  return Object.values(db.users).find(u => normalizePhone(u.contacts?.phone) === wanted) || null;
}
function makeUser(user, pass, extra = {}) {
  const salt = crypto.randomBytes(16).toString('hex');
  const phone = normalizePhone(extra.contacts?.phone);
  db.users[user] = {
    user, salt, hash: hashPass(pass, salt),
    role: extra.role || 'user',
    style: extra.style === 'galabeya' ? 'galabeya' : 'shirt',
    color: /^#[0-9a-f]{6}$/i.test(extra.color || '') ? extra.color : '#3a6ea5',
    contacts: {
      wa: String(extra.contacts?.wa || '').slice(0, 40),
      fb: String(extra.contacts?.fb || '').slice(0, 80),
      phone,
    },
    createdAt: new Date().toISOString(),
  };
  saveDB();
  return db.users[user];
}

async function initDB() {
  if (MONGODB_URI) {
    console.log('🔌 Connecting to MongoDB Atlas...');
    try {
      const { MongoClient } = require('mongodb');
      mongoClient = new MongoClient(MONGODB_URI);
      await mongoClient.connect();
      const dbName = MONGODB_URI.split('/').pop()?.split('?')[0] || 'qanayat_city';
      const database = mongoClient.db(dbName);
      mongoCollection = database.collection('state');
      
      const doc = await mongoCollection.findOne({ _id: 'qanayat_db' });
      if (doc && doc.data) {
        db = Object.assign(db, doc.data);
        console.log('✅ Loaded data from MongoDB Atlas');
      } else {
        await mongoCollection.updateOne(
          { _id: 'qanayat_db' },
          { $set: { data: db } },
          { upsert: true }
        );
        console.log('✅ Created initial state in MongoDB Atlas');
      }
    } catch (err) {
      console.error('❌ Failed to connect to MongoDB. Using local db.json fallback.', err);
      try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}
    }
  } else {
    console.log('📂 Using local db.json (No MONGODB_URI configured)');
    try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}
  }
  
  db.settings ||= {};
  db.settings.news = Object.assign({ text: '', everyMinutes: 10, times: 3 }, db.settings.news || {});
  db.settings.education = Object.assign({ videoUrl: '', desc: 'مجمع تعليمي بالقنايات - بث ومحتوى يحدده الأدمن.', mode: 'recorded', liveOn: false, liveStartedAt: 0 }, db.settings.education || {});

  /* أدمن افتراضي أول مرة */
  if (!Object.keys(db.users).length) {
    makeUser('admin', '01065584603', { role: 'admin', color: '#e8902e', contacts: { phone: '01022104948' } });
    console.log('⚠ تم إنشاء حساب الأدمن الافتراضي:  01022104948 / 01065584603  — غيّر الباسورد!');
  }
}

let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    // Save locally
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), () => {});
    
    // Save to MongoDB
    if (mongoCollection) {
      try {
        await mongoCollection.updateOne(
          { _id: 'qanayat_db' },
          { $set: { data: db } },
          { upsert: true }
        );
      } catch (err) {
        console.error('❌ Failed to save to MongoDB:', err);
      }
    }
  }, 300);
}

/* ================= ملفات اللعبة ================= */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(PUBLIC, urlPath);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

/* ================= الاتصالات ================= */
const wss = new WebSocketServer({ server, path: '/ws' });
const online = new Map();    // id -> { ws, user, x, z, ry, ride }
const tokens = new Map();    // token -> user
let nextConnId = 1;

const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
function broadcast(m, exceptId = null) {
  const s = JSON.stringify(m);
  for (const [id, p] of online) if (id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
}
function publicInfo(id) {
  const p = online.get(id);
  if (!p) return null;
  const u = db.users[p.user];
  return { id, name: p.user, x: p.x, z: p.z, ry: p.ry, ride: p.ride ? 1 : 0, style: u.style, color: u.color, role: u.role };
}
function storesPublic() {
  return db.stores.map(s => ({
    id: s.id,
    name: s.name,
    owner: s.owner,
    ownerPhone: db.users[s.owner]?.contacts?.phone || '',
    desc: s.desc || '',
    signImage: s.signImage || '',
    x: s.x,
    z: s.z,
    items: (s.items || []).map(it => ({
      id: it.id,
      name: it.name,
      price: it.price,
      desc: it.desc || '',
      image: it.image || '',
    })),
  }));
}
function profileOf(user) {
  const u = db.users[user];
  return { user: u.user, role: u.role, style: u.style, color: u.color, contacts: u.contacts };
}
function settingsPublic() {
  return {
    news: {
      text: String(db.settings.news?.text || '').slice(0, 220),
      everyMinutes: Math.max(1, Math.min(240, Number(db.settings.news?.everyMinutes) || 10)),
      times: Math.max(1, Math.min(50, Number(db.settings.news?.times) || 3)),
    },
    education: {
      videoUrl: String(db.settings.education?.videoUrl || '').slice(0, 500),
      desc: String(db.settings.education?.desc || '').slice(0, 400),
      mode: db.settings.education?.mode === 'live' ? 'live' : 'recorded',
      liveOn: !!db.settings.education?.liveOn,
      liveStartedAt: Number(db.settings.education?.liveStartedAt) || 0,
    },
  };
}
function findOnlineByUser(user) {
  for (const [id, p] of online) if (p.user === user) return { id, p };
  return null;
}
async function askNpcAI({ player, npc, text }) {
  if (!GROQ_API_KEY) throw new Error('missing_groq_key');
  const name = String(npc?.name || 'شخصية من القنايات').slice(0, 60);
  const job = String(npc?.job || '').slice(0, 120);
  const story = String(npc?.story || '').slice(0, 900);
  const links = Array.isArray(npc?.links) ? npc.links.slice(0, 8).join('، ') : '';
  const key = `${player}:${name}`;
  const history = npcHistory.get(key) || [];
  const messages = [
    {
      role: 'system',
      content:
        `أنت ${name} من مدينة القنايات. مهنتك/دورك: ${job}. ` +
        `تكلم باللهجة المصرية الطبيعية وباختصار كأنك داخل لعبة مدينة ثلاثية الأبعاد. ` +
        `خليك داخل الشخصية، واستخدم تفاصيل قصتك فقط بدون اختراع بيانات خاصة أو أرقام حقيقية. ` +
        `لو المستخدم طلب شيء إداري أو تقني قل له يكلم الأدمن. ` +
        `قصتك: ${story}` +
        (links ? `\nأشخاص تعرفهم: ${links}.` : '')
    },
    ...history,
    { role: 'user', content: String(text || '').slice(0, 500) }
  ];
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.75,
      max_tokens: 220,
    }),
  });
  if (!res.ok) throw new Error(`groq_${res.status}`);
  const data = await res.json();
  const reply = String(data.choices?.[0]?.message?.content || '').trim().slice(0, 900);
  const nextHistory = [...history, { role: 'user', content: String(text || '').slice(0, 500) }, { role: 'assistant', content: reply }].slice(-8);
  npcHistory.set(key, nextHistory);
  return reply || 'سمعتك، بس مش قادر أرد دلوقتي.';
}

wss.on('connection', (ws) => {
  let myId = null;     // معرف الاتصال بعد الدخول
  let myUser = null;   // اسم الحساب

  function authed() { return myUser && db.users[myUser]; }
  function isAdmin() { return authed() && db.users[myUser].role === 'admin'; }

  function doJoin(x, z) {
    myId = nextConnId++;
    online.set(myId, { ws, user: myUser, x: Number(x) || 0, z: Number(z) || 0, ry: 0, ride: 0 });
    send(ws, {
      t: 'welcome', id: myId,
      players: [...online.keys()].filter(i => i !== myId).map(publicInfo),
      stores: storesPublic(),
      settings: settingsPublic(),
    });
    broadcast({ t: 'player-joined', player: publicInfo(myId) }, myId);
    console.log(`[+] ${myUser} دخل المدينة (${online.size} متصل)`);
  }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    /* ---------- تسجيل / دخول ---------- */
    if (m.t === 'register') {
      const user = String(m.user || '').trim().slice(0, 24);
      const pass = String(m.pass || '');
      const phone = normalizePhone(m.contacts?.phone);
      if (user.length < 2) return send(ws, { t: 'auth-err', msg: 'الاسم قصير أوي' });
      if (pass.length < 4) return send(ws, { t: 'auth-err', msg: 'الباسورد لازم ٤ حروف على الأقل' });
      if (phone.length < 7) return send(ws, { t: 'auth-err', msg: 'رقم التليفون مطلوب ولازم يكون صحيح' });
      if (db.users[user]) return send(ws, { t: 'auth-err', msg: 'الاسم ده متسجل قبل كده — سجل دخول أو اختار اسم تاني' });
      if (findUserByPhone(phone)) return send(ws, { t: 'auth-err', msg: 'رقم التليفون ده متسجل قبل كده — سجل دخول بيه' });
      m.contacts = { ...(m.contacts || {}), phone };
      makeUser(user, pass, m);
      myUser = user;
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, user);
      send(ws, { t: 'auth-ok', token, profile: profileOf(user), fresh: true });
      return;
    }
    if (m.t === 'login') {
      const u = findUserByPhone(m.phone || m.user);
      if (!u || u.hash !== hashPass(String(m.pass || ''), u.salt)) {
        return send(ws, { t: 'auth-err', msg: 'رقم التليفون أو الباسورد غلط' });
      }
      if (findOnlineByUser(u.user)) return send(ws, { t: 'auth-err', msg: 'الحساب ده داخل بالفعل من مكان تاني' });
      myUser = u.user;
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, u.user);
      send(ws, { t: 'auth-ok', token, profile: profileOf(u.user) });
      return;
    }
    if (m.t === 'login-token') {
      const user = tokens.get(String(m.token || ''));
      if (!user || !db.users[user]) return send(ws, { t: 'auth-err', silent: true });
      if (findOnlineByUser(user)) return send(ws, { t: 'auth-err', silent: true });
      myUser = user;
      send(ws, { t: 'auth-ok', token: m.token, profile: profileOf(user) });
      return;
    }
    if (m.t === 'update-profile') {
      if (!authed()) return;
      const u = db.users[myUser];
      if (m.style) u.style = m.style === 'galabeya' ? 'galabeya' : 'shirt';
      if (/^#[0-9a-f]{6}$/i.test(m.color || '')) u.color = m.color;
      if (m.contacts) {
        const phone = normalizePhone(m.contacts.phone);
        const owner = findUserByPhone(phone);
        if (phone.length < 7) return send(ws, { t: 'auth-err', msg: 'رقم التليفون مطلوب ولازم يكون صحيح' });
        if (owner && owner.user !== myUser) return send(ws, { t: 'auth-err', msg: 'رقم التليفون ده متسجل لحساب تاني' });
        u.contacts.wa = String(m.contacts.wa || '').slice(0, 40);
        u.contacts.fb = String(m.contacts.fb || '').slice(0, 80);
        u.contacts.phone = phone;
      }
      saveDB();
      send(ws, { t: 'profile', profile: profileOf(myUser) });
      return;
    }
    if (m.t === 'join') {
      if (!authed() || myId != null) return;
      doJoin(m.x, m.z);
      return;
    }

    if (myId == null || !online.has(myId)) return;
    const me = online.get(myId);

    switch (m.t) {
      case 'move':
        me.x = Number(m.x) || 0; me.z = Number(m.z) || 0; me.ry = Number(m.ry) || 0;
        me.ride = m.ride ? 1 : 0;
        broadcast({ t: 'player-move', id: myId, x: me.x, z: me.z, ry: me.ry, ride: me.ride }, myId);
        break;

      case 'chat': {
        const text = String(m.text || '').slice(0, 300).trim();
        if (!text) break;
        if (m.to != null && online.has(m.to)) {
          send(online.get(m.to).ws, { t: 'chat', from: myId, name: myUser, text, private: true });
          send(ws, { t: 'chat', from: myId, name: myUser, to: m.to, text, private: true, echo: true });
        } else {
          broadcast({ t: 'chat', from: myId, name: myUser, text, private: false });
        }
        break;
      }

      case 'npc-chat': {
        const text = String(m.text || '').slice(0, 500).trim();
        const npc = {
          name: String(m.npc?.name || '').slice(0, 60),
          job: String(m.npc?.job || '').slice(0, 120),
          story: String(m.npc?.story || '').slice(0, 900),
          links: Array.isArray(m.npc?.links) ? m.npc.links.slice(0, 8).map(x => String(x).slice(0, 60)) : [],
        };
        if (!text || !npc.name) break;
        askNpcAI({ player: myUser, npc, text })
          .then(reply => send(ws, { t: 'npc-reply', name: npc.name, text: reply }))
          .catch(() => send(ws, {
            t: 'npc-reply',
            name: npc.name,
            text: 'مش قادر أرد دلوقتي، جرّب تاني بعد شوية.',
            error: true,
          }));
        break;
      }

      case 'contact-request':
        if (online.has(m.to)) send(online.get(m.to).ws, { t: 'contact-request', from: myId, name: myUser });
        break;
      case 'contact-response':
        if (online.has(m.to)) {
          const target = online.get(m.to);
          if (m.accept) {
            send(target.ws, { t: 'contact-share', from: myId, name: myUser, contacts: db.users[myUser].contacts });
            send(ws, { t: 'contact-share', from: m.to, name: target.user, contacts: db.users[target.user].contacts });
          } else {
            send(target.ws, { t: 'contact-declined', from: myId, name: myUser });
          }
        }
        break;

      case 'call-offer': case 'call-answer': case 'call-ice': case 'call-end': case 'call-decline':
        if (online.has(m.to)) send(online.get(m.to).ws, { ...m, from: myId, name: myUser, to: undefined });
        break;

      /* ---------- المحلات ---------- */
      case 'order': {
        const store = db.stores.find(s => s.id === m.storeId);
        if (!store) break;
        const item = store.items.find(it => it.id === m.itemId);
        if (!item) break;
        const order = {
          id: db.nextOrderId++,
          storeId: store.id, storeName: store.name, owner: store.owner,
          item: item.name, price: item.price,
          qty: Math.max(1, Math.min(99, Number(m.qty) || 1)),
          buyer: {
            user: myUser,
            name: String(m.buyer?.name || myUser).slice(0, 40),
            phone: String(m.buyer?.phone || '').slice(0, 20),
            address: String(m.buyer?.address || '').slice(0, 120),
            note: String(m.buyer?.note || '').slice(0, 200),
          },
          time: new Date().toISOString(),
          status: 'جديد',
        };
        db.orders.push(order);
        saveDB();
        send(ws, { t: 'order-ok', order });
        const ownerOnline = findOnlineByUser(store.owner);
        if (ownerOnline) send(ownerOnline.p.ws, { t: 'new-order', order });
        break;
      }
      case 'store-orders': {
        const store = db.stores.find(s => s.id === m.id);
        if (!store) break;
        if (store.owner !== myUser && !isAdmin()) break;
        send(ws, { t: 'store-orders', id: store.id, orders: db.orders.filter(o => o.storeId === store.id) });
        break;
      }
      case 'store-rename': {
        const store = db.stores.find(s => s.id === m.id);
        if (!store || (store.owner !== myUser && !isAdmin())) break;
        store.name = String(m.name || store.name).slice(0, 40);
        store.desc = String(m.desc || '').slice(0, 300);
        store.signImage = String(m.signImage || '').slice(0, 500);
        saveDB();
        broadcast({ t: 'stores', stores: storesPublic() });
        break;
      }
      case 'store-add-item': {
        const store = db.stores.find(s => s.id === m.id);
        if (!store || (store.owner !== myUser && !isAdmin())) break;
        if (store.items.length >= 30) break;
        store.items.push({
          id: (store.items.at(-1)?.id || 0) + 1,
          name: String(m.name || '').slice(0, 40),
          price: Math.max(0, Number(m.price) || 0),
          desc: String(m.desc || '').slice(0, 240),
          image: String(m.image || '').slice(0, 500),
        });
        saveDB();
        broadcast({ t: 'stores', stores: storesPublic() });
        break;
      }
      case 'store-del-item': {
        const store = db.stores.find(s => s.id === m.id);
        if (!store || (store.owner !== myUser && !isAdmin())) break;
        store.items = store.items.filter(it => it.id !== m.itemId);
        saveDB();
        broadcast({ t: 'stores', stores: storesPublic() });
        break;
      }

      /* ---------- الأدمن ---------- */
      case 'admin-data': {
        if (!isAdmin()) break;
        send(ws, {
          t: 'admin-data',
          users: Object.values(db.users).map(u => ({
            user: u.user, role: u.role, contacts: u.contacts, createdAt: u.createdAt,
            online: !!findOnlineByUser(u.user),
          })),
          stores: storesPublic(),
          orders: db.orders.slice(-200),
          online: [...online.keys()].map(publicInfo),
          settings: settingsPublic(),
        });
        break;
      }
      case 'admin-settings': {
        if (!isAdmin()) break;
        db.settings.news.text = String(m.news?.text || '').slice(0, 220);
        db.settings.news.everyMinutes = Math.max(1, Math.min(240, Number(m.news?.everyMinutes) || 10));
        db.settings.news.times = Math.max(1, Math.min(50, Number(m.news?.times) || 3));
        db.settings.education.videoUrl = String(m.education?.videoUrl || '').slice(0, 500);
        db.settings.education.desc = String(m.education?.desc || '').slice(0, 400);
        const oldLiveOn = !!db.settings.education.liveOn;
        db.settings.education.mode = m.education?.mode === 'live' ? 'live' : 'recorded';
        db.settings.education.liveOn = db.settings.education.mode === 'live' && !!m.education?.liveOn;
        if (db.settings.education.liveOn && !oldLiveOn) db.settings.education.liveStartedAt = Date.now();
        if (!db.settings.education.liveOn) db.settings.education.liveStartedAt = 0;
        saveDB();
        const settings = settingsPublic();
        broadcast({ t: 'settings', settings });
        send(ws, { t: 'settings', settings });
        send(ws, { t: 'admin-ok', msg: 'تم حفظ إعدادات المدينة' });
        break;
      }
      case 'admin-set-role': {
        if (!isAdmin()) break;
        const u = db.users[m.user];
        if (u && m.user !== 'admin') { u.role = m.role === 'admin' ? 'admin' : 'user'; saveDB(); }
        send(ws, { t: 'admin-ok', msg: `صلاحية ${m.user} بقت ${m.role}` });
        break;
      }
      case 'admin-del-user': {
        if (!isAdmin()) break;
        if (m.user === 'admin' || !db.users[m.user]) break;
        delete db.users[m.user];
        db.stores = db.stores.filter(s => s.owner !== m.user);
        saveDB();
        const o = findOnlineByUser(m.user);
        if (o) o.p.ws.close();
        broadcast({ t: 'stores', stores: storesPublic() });
        send(ws, { t: 'admin-ok', msg: `اتمسح حساب ${m.user}` });
        break;
      }
      case 'admin-reset-pass': {
        if (!isAdmin()) break;
        const u = db.users[m.user];
        const np = String(m.pass || '');
        if (u && np.length >= 4) {
          u.salt = crypto.randomBytes(16).toString('hex');
          u.hash = hashPass(np, u.salt);
          saveDB();
          send(ws, { t: 'admin-ok', msg: `باسورد ${m.user} اتغير` });
        }
        break;
      }
      case 'admin-make-store': {
        if (!isAdmin()) break;
        const owner = findUserByPhone(m.ownerPhone) || db.users[m.owner];
        if (!owner) { send(ws, { t: 'admin-ok', msg: `مفيش حساب بالرقم ده` }); break; }
        const store = {
          id: db.nextStoreId++,
          name: String(m.name || 'محل جديد').slice(0, 40),
          owner: owner.user,
          x: Number(m.x) || 0, z: Number(m.z) || 0,
          desc: '',
          signImage: '',
          items: [],
          createdAt: new Date().toISOString(),
        };
        db.stores.push(store);
        saveDB();
        broadcast({ t: 'stores', stores: storesPublic() });
        send(ws, { t: 'admin-ok', msg: `اتعمل محل «${store.name}» لـ ${owner.user}` });
        const o = findOnlineByUser(owner.user);
        if (o) send(o.p.ws, { t: 'store-granted', store: { id: store.id, name: store.name } });
        break;
      }
      case 'admin-del-store': {
        if (!isAdmin()) break;
        db.stores = db.stores.filter(s => s.id !== m.id);
        saveDB();
        broadcast({ t: 'stores', stores: storesPublic() });
        send(ws, { t: 'admin-ok', msg: 'المحل اتمسح' });
        break;
      }
      case 'admin-del-order': {
        if (!isAdmin()) break;
        db.orders = db.orders.filter(o => o.id !== m.id);
        saveDB();
        send(ws, { t: 'admin-ok', msg: 'الأوردر اتمسح' });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myId != null && online.has(myId)) {
      console.log(`[-] ${myUser} خرج (${online.size - 1} متصل)`);
      online.delete(myId);
      broadcast({ t: 'player-left', id: myId });
    }
  });
});

async function startServer() {
  await initDB();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('================================================');
    console.log('  🏙  مدينة القنايات 3D شغالة!');
    console.log(`  العب من الجهاز ده:   http://localhost:${PORT}`);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  من أجهزة الشبكة:     http://${net.address}:${PORT}`);
        }
      }
    }
    console.log('  حساب الأدمن: 01022104948 / 01065584603 (لو أول تشغيل)');
    console.log('================================================');
  });
}
startServer();
