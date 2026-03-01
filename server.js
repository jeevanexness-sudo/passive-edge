// ============================================================
//  Trading Platform — Full Stack Server
//  Roles: admin / master / client
//  DB: PostgreSQL (Railway)
// ============================================================
const express  = require('express');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Config ───────────────────────────────────────────────────
const JWT_SECRET   = process.env.JWT_SECRET   || 'TRADING_JWT_SECRET_2026';
const ADMIN_PASS   = process.env.ADMIN_PASS   || 'admin123';
const DATABASE_URL = process.env.DATABASE_URL || null;
const PORT         = process.env.PORT         || 8080;

// ── DB Pool ──────────────────────────────────────────────────
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  console.log('✅ PostgreSQL connected');
} else {
  console.log('⚠️  No DATABASE_URL — using in-memory DB');
}

// ── In-memory fallback DB ────────────────────────────────────
const memDB = {
  users:      {},
  strategies: {},
  subscriptions: {},
  news:       {},
  ea_products:{},
  plans:      {
    'plan_1': { id:'plan_1', name:'Starter',    type:'subscription',  price_monthly:999,  percentage:null, description:'Basic copy trading access' },
    'plan_2': { id:'plan_2', name:'Pro',        type:'subscription',  price_monthly:2499, percentage:null, description:'Advanced strategies access' },
    'plan_3': { id:'plan_3', name:'5% Share',   type:'profit_share',  price_monthly:0,    percentage:5,    description:'5% of profits only' },
    'plan_4': { id:'plan_4', name:'10% Share',  type:'profit_share',  price_monthly:0,    percentage:10,   description:'10% of profits only' },
    'plan_5': { id:'plan_5', name:'20% Share',  type:'profit_share',  price_monthly:0,    percentage:20,   description:'20% of profits only' },
  }
};

// Create default admin
const adminId = 'admin_' + uuidv4();
memDB.users[adminId] = {
  id: adminId, name: 'Admin', email: 'admin@platform.com',
  password: bcrypt.hashSync(ADMIN_PASS, 10), role: 'admin',
  created_at: new Date().toISOString()
};

// ── DB Helpers ────────────────────────────────────────────────
async function dbQuery(sql, params = []) {
  if (pool) {
    const r = await pool.query(sql, params);
    return r.rows;
  }
  return null;
}

async function initDB() {
  if (!pool) return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE,
      password TEXT, role TEXT DEFAULT 'client',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY, master_id TEXT, name TEXT, description TEXT,
      risk_level TEXT, plan_type TEXT, price_monthly INTEGER, percentage INTEGER,
      mt5_login TEXT, mt5_server TEXT, broker TEXT,
      total_return NUMERIC DEFAULT 0, monthly_return NUMERIC DEFAULT 0,
      win_rate NUMERIC DEFAULT 0, drawdown NUMERIC DEFAULT 0,
      total_trades INTEGER DEFAULT 0, followers INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, client_id TEXT, strategy_id TEXT,
      mt5_login TEXT, mt5_password TEXT, mt5_server TEXT,
      lot_multiplier NUMERIC DEFAULT 1.0, plan_id TEXT,
      status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY, title TEXT, content TEXT,
      image_url TEXT, category TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ea_products (
      id TEXT PRIMARY KEY, name TEXT, description TEXT,
      image_url TEXT, price NUMERIC, download_url TEXT,
      active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, name TEXT, type TEXT,
      price_monthly INTEGER, percentage INTEGER, description TEXT
    )
  `);
  // seed plans
  const plans = [
    ['plan_1','Starter','subscription',999,null,'Basic copy trading access'],
    ['plan_2','Pro','subscription',2499,null,'Advanced strategies access'],
    ['plan_3','5% Share','profit_share',0,5,'5% of profits only'],
    ['plan_4','10% Share','profit_share',0,10,'10% of profits only'],
    ['plan_5','20% Share','profit_share',0,20,'20% of profits only'],
  ];
  for (const p of plans) {
    await dbQuery(`INSERT INTO plans VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, p);
  }
  // seed admin
  const adminEmail = 'admin@platform.com';
  const existing = await dbQuery(`SELECT id FROM users WHERE email=$1`, [adminEmail]);
  if (!existing.length) {
    await dbQuery(`INSERT INTO users VALUES($1,$2,$3,$4,$5,NOW())`,
      [adminId, 'Admin', adminEmail, bcrypt.hashSync(ADMIN_PASS, 10), 'admin']);
  }
  console.log('✅ DB initialized');
}

// ── Auth Middleware ───────────────────────────────────────────
function auth(roles = []) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(decoded.role))
        return res.status(403).json({ error: 'Access denied' });
      req.user = decoded;
      next();
    } catch (e) {
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}

// ── User helpers ──────────────────────────────────────────────
async function findUserByEmail(email) {
  if (pool) {
    const r = await dbQuery(`SELECT * FROM users WHERE email=$1`, [email]);
    return r[0] || null;
  }
  return Object.values(memDB.users).find(u => u.email === email) || null;
}
async function createUser(id, name, email, hashedPass, role) {
  if (pool) {
    await dbQuery(`INSERT INTO users VALUES($1,$2,$3,$4,$5,NOW())`, [id, name, email, hashedPass, role]);
  } else {
    memDB.users[id] = { id, name, email, password: hashedPass, role, created_at: new Date().toISOString() };
  }
}
async function findUserById(id) {
  if (pool) {
    const r = await dbQuery(`SELECT * FROM users WHERE id=$1`, [id]);
    return r[0] || null;
  }
  return memDB.users[id] || null;
}

// ── ROUTES ────────────────────────────────────────────────────

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role = 'client' } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (['admin'].includes(role))
    return res.status(403).json({ error: 'Cannot self-register as admin' });
  const existing = await findUserByEmail(email);
  if (existing) return res.status(400).json({ error: 'Email already registered' });
  const id   = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  await createUser(id, name, email, hash, role);
  const token = jwt.sign({ id, name, email, role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, name, email, role } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await findUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  if (!bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET, { expiresIn: '30d' }
  );
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/auth/me', auth(), async (req, res) => {
  const user = await findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// ── News (public read, admin write) ──────────────────────────
app.get('/api/news', async (req, res) => {
  if (pool) {
    const rows = await dbQuery(`SELECT * FROM news ORDER BY created_at DESC LIMIT 20`);
    return res.json(rows);
  }
  res.json(Object.values(memDB.news).sort((a,b) => new Date(b.created_at)-new Date(a.created_at)));
});

app.post('/api/news', auth(['admin']), async (req, res) => {
  const { title, content, image_url, category = 'General' } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content required' });
  const id = uuidv4();
  const item = { id, title, content, image_url: image_url||'', category, created_at: new Date().toISOString() };
  if (pool) await dbQuery(`INSERT INTO news VALUES($1,$2,$3,$4,$5,NOW())`, [id, title, content, image_url||'', category]);
  else memDB.news[id] = item;
  res.json(item);
});

app.put('/api/news/:id', auth(['admin']), async (req, res) => {
  const { title, content, image_url, category } = req.body;
  if (pool) {
    await dbQuery(`UPDATE news SET title=$1,content=$2,image_url=$3,category=$4 WHERE id=$5`,
      [title, content, image_url, category, req.params.id]);
  } else {
    if (memDB.news[req.params.id])
      Object.assign(memDB.news[req.params.id], { title, content, image_url, category });
  }
  res.json({ success: true });
});

app.delete('/api/news/:id', auth(['admin']), async (req, res) => {
  if (pool) await dbQuery(`DELETE FROM news WHERE id=$1`, [req.params.id]);
  else delete memDB.news[req.params.id];
  res.json({ success: true });
});

// ── EA Products (public read, admin write) ────────────────────
app.get('/api/eas', async (req, res) => {
  if (pool) {
    const rows = await dbQuery(`SELECT * FROM ea_products WHERE active=true ORDER BY created_at DESC`);
    return res.json(rows);
  }
  res.json(Object.values(memDB.ea_products).filter(e => e.active));
});

app.post('/api/eas', auth(['admin']), async (req, res) => {
  const { name, description, image_url, price = 0, download_url } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  const item = { id, name, description:'', image_url:'', price, download_url:'', active:true, created_at: new Date().toISOString(), ...req.body };
  item.id = id;
  if (pool) await dbQuery(`INSERT INTO ea_products VALUES($1,$2,$3,$4,$5,$6,$7,NOW())`,
    [id, item.name, item.description, item.image_url, item.price, item.download_url, true]);
  else memDB.ea_products[id] = item;
  res.json(item);
});

app.put('/api/eas/:id', auth(['admin']), async (req, res) => {
  const { name, description, image_url, price, download_url, active } = req.body;
  if (pool) await dbQuery(`UPDATE ea_products SET name=$1,description=$2,image_url=$3,price=$4,download_url=$5,active=$6 WHERE id=$7`,
    [name, description, image_url, price, download_url, active, req.params.id]);
  else if (memDB.ea_products[req.params.id])
    Object.assign(memDB.ea_products[req.params.id], req.body);
  res.json({ success: true });
});

app.delete('/api/eas/:id', auth(['admin']), async (req, res) => {
  if (pool) await dbQuery(`UPDATE ea_products SET active=false WHERE id=$1`, [req.params.id]);
  else if (memDB.ea_products[req.params.id]) memDB.ea_products[req.params.id].active = false;
  res.json({ success: true });
});

// ── Plans ─────────────────────────────────────────────────────
app.get('/api/plans', async (req, res) => {
  if (pool) {
    const rows = await dbQuery(`SELECT * FROM plans`);
    return res.json(rows);
  }
  res.json(Object.values(memDB.plans));
});

// ── Strategies (public read) ──────────────────────────────────
app.get('/api/strategies', async (req, res) => {
  if (pool) {
    const rows = await dbQuery(`
      SELECT s.*, u.name as master_name FROM strategies s
      JOIN users u ON s.master_id=u.id
      WHERE s.active=true ORDER BY s.followers DESC
    `);
    return res.json(rows);
  }
  const strategies = Object.values(memDB.strategies).filter(s => s.active);
  const result = strategies.map(s => ({
    ...s,
    master_name: memDB.users[s.master_id]?.name || 'Unknown'
  }));
  res.json(result);
});

app.get('/api/strategies/:id', async (req, res) => {
  if (pool) {
    const rows = await dbQuery(`
      SELECT s.*, u.name as master_name FROM strategies s
      JOIN users u ON s.master_id=u.id WHERE s.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json(rows[0]);
  }
  const s = memDB.strategies[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ ...s, master_name: memDB.users[s.master_id]?.name || 'Unknown' });
});

// ── Master — Register strategy ────────────────────────────────
app.post('/api/strategies', auth(['master', 'admin']), async (req, res) => {
  const { name, description, risk_level, plan_type, price_monthly, percentage,
          mt5_login, mt5_server, broker } = req.body;
  if (!name || !mt5_login || !mt5_server)
    return res.status(400).json({ error: 'name, mt5_login, mt5_server required' });
  const id = uuidv4();
  const item = {
    id, master_id: req.user.id, name, description: description||'',
    risk_level: risk_level||'Medium', plan_type: plan_type||'subscription',
    price_monthly: price_monthly||999, percentage: percentage||null,
    mt5_login, mt5_server, broker: broker||'',
    total_return: 0, monthly_return: 0, win_rate: 0, drawdown: 0,
    total_trades: 0, followers: 0, active: true,
    created_at: new Date().toISOString()
  };
  if (pool) {
    await dbQuery(`INSERT INTO strategies VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())`,
      [id,req.user.id,name,item.description,item.risk_level,item.plan_type,item.price_monthly,
       item.percentage,mt5_login,mt5_server,broker||'',0,0,0,0,0,0,true]);
  } else {
    memDB.strategies[id] = item;
  }
  res.json(item);
});

app.put('/api/strategies/:id', auth(['master', 'admin']), async (req, res) => {
  if (pool) {
    const { name, description, risk_level, plan_type, price_monthly, percentage,
            total_return, monthly_return, win_rate, drawdown, total_trades } = req.body;
    await dbQuery(`UPDATE strategies SET name=$1,description=$2,risk_level=$3,plan_type=$4,
      price_monthly=$5,percentage=$6,total_return=$7,monthly_return=$8,win_rate=$9,
      drawdown=$10,total_trades=$11 WHERE id=$12 AND (master_id=$13 OR $14='admin')`,
      [name,description,risk_level,plan_type,price_monthly,percentage,
       total_return,monthly_return,win_rate,drawdown,total_trades,
       req.params.id, req.user.id, req.user.role]);
  } else if (memDB.strategies[req.params.id]) {
    Object.assign(memDB.strategies[req.params.id], req.body);
  }
  res.json({ success: true });
});

// ── Client — Subscribe to strategy ───────────────────────────
app.post('/api/subscriptions', auth(['client']), async (req, res) => {
  const { strategy_id, mt5_login, mt5_password, mt5_server, lot_multiplier, plan_id } = req.body;
  if (!strategy_id || !mt5_login || !mt5_password || !mt5_server)
    return res.status(400).json({ error: 'All fields required' });

  // Check strategy exists
  let strategy;
  if (pool) {
    const r = await dbQuery(`SELECT * FROM strategies WHERE id=$1 AND active=true`, [strategy_id]);
    strategy = r[0];
  } else {
    strategy = memDB.strategies[strategy_id];
  }
  if (!strategy) return res.status(404).json({ error: 'Strategy not found' });

  const id = uuidv4();
  const sub = {
    id, client_id: req.user.id, strategy_id, mt5_login,
    mt5_password, mt5_server,
    lot_multiplier: lot_multiplier||1.0, plan_id: plan_id||'',
    status: 'active', created_at: new Date().toISOString()
  };
  if (pool) {
    await dbQuery(`INSERT INTO subscriptions VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      [id,req.user.id,strategy_id,mt5_login,mt5_password,mt5_server,lot_multiplier||1.0,plan_id||'','active']);
    await dbQuery(`UPDATE strategies SET followers=followers+1 WHERE id=$1`, [strategy_id]);
  } else {
    memDB.subscriptions[id] = sub;
    if (memDB.strategies[strategy_id]) memDB.strategies[strategy_id].followers++;
  }
  res.json(sub);
});

app.get('/api/subscriptions/my', auth(['client']), async (req, res) => {
  if (pool) {
    const rows = await dbQuery(`
      SELECT sub.*, s.name as strategy_name, s.total_return, s.monthly_return,
             s.win_rate, s.risk_level, u.name as master_name
      FROM subscriptions sub
      JOIN strategies s ON sub.strategy_id=s.id
      JOIN users u ON s.master_id=u.id
      WHERE sub.client_id=$1 AND sub.status='active'
    `, [req.user.id]);
    return res.json(rows);
  }
  const subs = Object.values(memDB.subscriptions)
    .filter(s => s.client_id === req.user.id && s.status === 'active')
    .map(s => ({
      ...s,
      strategy_name: memDB.strategies[s.strategy_id]?.name || '',
      total_return:  memDB.strategies[s.strategy_id]?.total_return || 0,
      monthly_return:memDB.strategies[s.strategy_id]?.monthly_return || 0,
      win_rate:      memDB.strategies[s.strategy_id]?.win_rate || 0,
      risk_level:    memDB.strategies[s.strategy_id]?.risk_level || '',
      master_name:   memDB.users[memDB.strategies[s.strategy_id]?.master_id]?.name || ''
    }));
  res.json(subs);
});

app.delete('/api/subscriptions/:id', auth(['client']), async (req, res) => {
  if (pool) {
    const r = await dbQuery(`SELECT strategy_id FROM subscriptions WHERE id=$1 AND client_id=$2`,
      [req.params.id, req.user.id]);
    if (r.length) {
      await dbQuery(`UPDATE subscriptions SET status='cancelled' WHERE id=$1`, [req.params.id]);
      await dbQuery(`UPDATE strategies SET followers=GREATEST(0,followers-1) WHERE id=$1`, [r[0].strategy_id]);
    }
  } else if (memDB.subscriptions[req.params.id]) {
    const sub = memDB.subscriptions[req.params.id];
    if (sub.client_id === req.user.id) {
      sub.status = 'cancelled';
      if (memDB.strategies[sub.strategy_id])
        memDB.strategies[sub.strategy_id].followers = Math.max(0, memDB.strategies[sub.strategy_id].followers - 1);
    }
  }
  res.json({ success: true });
});

// ── Master — My strategies ────────────────────────────────────
app.get('/api/strategies/my/list', auth(['master', 'admin']), async (req, res) => {
  if (pool) {
    const rows = await dbQuery(`SELECT * FROM strategies WHERE master_id=$1`, [req.user.id]);
    return res.json(rows);
  }
  res.json(Object.values(memDB.strategies).filter(s => s.master_id === req.user.id));
});

// ── Admin ─────────────────────────────────────────────────────
app.get('/api/admin/stats', auth(['admin']), async (req, res) => {
  if (pool) {
    const [users, strategies, subs] = await Promise.all([
      dbQuery(`SELECT COUNT(*),role FROM users GROUP BY role`),
      dbQuery(`SELECT COUNT(*) FROM strategies WHERE active=true`),
      dbQuery(`SELECT COUNT(*) FROM subscriptions WHERE status='active'`),
    ]);
    return res.json({ users, strategies: strategies[0]?.count||0, subscriptions: subs[0]?.count||0 });
  }
  const allUsers = Object.values(memDB.users);
  res.json({
    total_users:   allUsers.length,
    total_clients: allUsers.filter(u => u.role==='client').length,
    total_masters: allUsers.filter(u => u.role==='master').length,
    total_strategies: Object.values(memDB.strategies).filter(s => s.active).length,
    total_subscriptions: Object.values(memDB.subscriptions).filter(s => s.status==='active').length,
  });
});

app.get('/api/admin/users', auth(['admin']), async (req, res) => {
  if (pool) {
    const rows = await dbQuery(`SELECT id,name,email,role,created_at FROM users ORDER BY created_at DESC`);
    return res.json(rows);
  }
  res.json(Object.values(memDB.users).map(u => ({
    id:u.id, name:u.name, email:u.email, role:u.role, created_at:u.created_at
  })));
});

app.put('/api/admin/users/:id/role', auth(['admin']), async (req, res) => {
  const { role } = req.body;
  if (!['client','master','admin'].includes(role))
    return res.status(400).json({ error: 'Invalid role' });
  if (pool) await dbQuery(`UPDATE users SET role=$1 WHERE id=$2`, [role, req.params.id]);
  else if (memDB.users[req.params.id]) memDB.users[req.params.id].role = role;
  res.json({ success: true });
});

app.get('/api/admin/subscriptions', auth(['admin']), async (req, res) => {
  if (pool) {
    const rows = await dbQuery(`
      SELECT sub.*, u.name as client_name, u.email as client_email,
             s.name as strategy_name
      FROM subscriptions sub
      JOIN users u ON sub.client_id=u.id
      JOIN strategies s ON sub.strategy_id=s.id
      ORDER BY sub.created_at DESC
    `);
    return res.json(rows);
  }
  res.json(Object.values(memDB.subscriptions).map(s => ({
    ...s,
    client_name:   memDB.users[s.client_id]?.name || '',
    client_email:  memDB.users[s.client_id]?.email || '',
    strategy_name: memDB.strategies[s.strategy_id]?.name || ''
  })));
});

// Update plans
app.post('/api/admin/plans', auth(['admin']), async (req, res) => {
  const { name, type, price_monthly, percentage, description } = req.body;
  const id = 'plan_' + uuidv4().slice(0,8);
  const plan = { id, name, type, price_monthly:price_monthly||0, percentage:percentage||null, description:description||'' };
  if (pool) await dbQuery(`INSERT INTO plans VALUES($1,$2,$3,$4,$5,$6)`,
    [id, name, type, price_monthly||0, percentage||null, description||'']);
  else memDB.plans[id] = plan;
  res.json(plan);
});

app.delete('/api/admin/plans/:id', auth(['admin']), async (req, res) => {
  if (pool) await dbQuery(`DELETE FROM plans WHERE id=$1`, [req.params.id]);
  else delete memDB.plans[req.params.id];
  res.json({ success: true });
});

// ── Serve frontend ────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Trading Platform Server | Port ${PORT}`);
    console.log(`🔐 Admin: admin@platform.com / ${ADMIN_PASS}`);
  });
}).catch(e => {
  console.error('DB init error:', e.message);
  app.listen(PORT, () => console.log(`✅ Server started (no DB) | Port ${PORT}`));
});
