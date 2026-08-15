import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_DAYS = 30;
const UPSTREAM_REDEEM = process.env.REDEEM_API || 'https://ttt9-9-9-9.onrender.com/api/redeem';
if (!DATABASE_URL) console.warn('DATABASE_URL chưa được cấu hình. Server sẽ không khởi động.');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized:false } : false });

const GAME_SECONDS = 30;
const RESULT_GAP_SECONDS = 7;
const START_TTT = 0;
const JACKPOT_START = 100000000;
const PAYOUT = 1.95;
let gameBusy = false;

const now = () => new Date();
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const token = () => crypto.randomBytes(32).toString('hex');
function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}
function passwordVerify(password, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const got = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
async function q(text, params=[]) { return pool.query(text, params); }

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(24) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    ttt BIGINT NOT NULL DEFAULT 0,
    spins BIGINT NOT NULL DEFAULT 0,
    best_win BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS tx_rounds (
    id BIGSERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'open',
    d1 SMALLINT, d2 SMALLINT, d3 SMALLINT,
    total SMALLINT, side VARCHAR(5)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS tx_bets (
    id BIGSERIAL PRIMARY KEY,
    round_id BIGINT NOT NULL REFERENCES tx_rounds(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side VARCHAR(4) NOT NULL CHECK (side IN ('tai','xiu')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled BOOLEAN NOT NULL DEFAULT FALSE,
    win_ttt BIGINT NOT NULL DEFAULT 0
  )`);
  await q(`CREATE TABLE IF NOT EXISTS tx_history (
    id BIGSERIAL PRIMARY KEY,
    round_id BIGINT UNIQUE NOT NULL REFERENCES tx_rounds(id) ON DELETE CASCADE,
    d1 SMALLINT NOT NULL, d2 SMALLINT NOT NULL, d3 SMALLINT NOT NULL,
    total SMALLINT NOT NULL, side VARCHAR(5) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`ALTER TABLE tx_rounds ADD COLUMN IF NOT EXISTS result_until TIMESTAMPTZ`);
  await q(`CREATE INDEX IF NOT EXISTS tx_bets_user_idx ON tx_bets(user_id, id DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS tx_history_id_idx ON tx_history(id DESC)`);
  const r = await q(`SELECT id FROM tx_rounds WHERE status='open' ORDER BY id DESC LIMIT 1`);
  if (!r.rowCount) await createRound();
}

async function createRound() {
  const started = now();
  const ends = new Date(started.getTime() + GAME_SECONDS * 1000);
  await q(`INSERT INTO tx_rounds(started_at,ends_at,status) VALUES($1,$2,'open')`, [started, ends]);
}

async function currentRound() {
  let r=await q(`SELECT * FROM tx_rounds ORDER BY id DESC LIMIT 1`);
  if(!r.rowCount){await createRound();r=await q(`SELECT * FROM tx_rounds ORDER BY id DESC LIMIT 1`);}
  const x=r.rows[0];
  if(x.status==='closed' && x.result_until && new Date(x.result_until)<=now()){
    await createRound(); r=await q(`SELECT * FROM tx_rounds ORDER BY id DESC LIMIT 1`);
  }
  return r.rows[0];
}

function sideOf(d1,d2,d3) {
  const total=d1+d2+d3;
  const triple=d1===d2&&d2===d3;
  return triple ? (d1>=4?'TÀI':'XỈU') : (total>=11?'TÀI':'XỈU');
}

async function settleRound(round) {
  if (gameBusy) return;
  gameBusy = true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rr = await client.query(`SELECT * FROM tx_rounds WHERE id=$1 FOR UPDATE`, [round.id]);
    if (!rr.rowCount || rr.rows[0].status !== 'open') { await client.query('ROLLBACK'); return; }
    const d1=crypto.randomInt(1,7), d2=crypto.randomInt(1,7), d3=crypto.randomInt(1,7);
    const total=d1+d2+d3;
    const side=sideOf(d1,d2,d3);
    await client.query(`UPDATE tx_rounds SET status='closed',d1=$2,d2=$3,d3=$4,total=$5,side=$6,result_until=$7 WHERE id=$1`, [round.id,d1,d2,d3,total,side,new Date(Date.now()+RESULT_GAP_SECONDS*1000)]);
    await client.query(`INSERT INTO tx_history(round_id,d1,d2,d3,total,side) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(round_id) DO NOTHING`, [round.id,d1,d2,d3,total,side]);

    const bets = await client.query(`SELECT * FROM tx_bets WHERE round_id=$1 AND settled=false FOR UPDATE`, [round.id]);
    for (const bet of bets.rows) {
      const win = (bet.side === (side==='TÀI'?'tai':'xiu')) ? Math.floor(Number(bet.amount)*PAYOUT) : 0;
      if (win > 0) {
        await client.query(`UPDATE users SET ttt=ttt+$1, spins=spins+1, best_win=GREATEST(best_win,$1) WHERE id=$2`, [win,bet.user_id]);
      } else {
        await client.query(`UPDATE users SET spins=spins+1 WHERE id=$1`, [bet.user_id]);
      }
      await client.query(`UPDATE tx_bets SET settled=true,win_ttt=$1 WHERE id=$2`, [win,bet.id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('settleRound',e);
  } finally { client.release(); gameBusy=false; }
}

async function gameTick() {
  try {
    const r = await currentRound();
    const t=Date.now();
    if(r.status==='open' && new Date(r.ends_at).getTime()<=t) await settleRound(r);
    else if(r.status==='closed' && r.result_until && new Date(r.result_until).getTime()<=t) await createRound();
  } catch(e){ console.error('gameTick',e); }
}

async function auth(req,res,next) {
  try {
    const raw=req.headers.authorization||'';
    const t=raw.startsWith('Bearer ')?raw.slice(7):'';
    if (!t) return res.status(401).json({ok:false,error:'Chưa đăng nhập.'});
    const r=await q(`SELECT u.id,u.username,u.ttt,u.spins,u.best_win,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1`,[hash(t)]);
    if(!r.rowCount || new Date(r.rows[0].expires_at)<now()) return res.status(401).json({ok:false,error:'Phiên đăng nhập hết hạn.'});
    req.user=r.rows[0]; req.sessionToken=t; next();
  } catch(e){ console.error(e); res.status(500).json({ok:false,error:'Lỗi máy chủ.'}); }
}


app.get('/api/rank', async (_req,res)=>{
  try{
    const r=await q(`SELECT username, best_win AS score FROM users ORDER BY best_win DESC, id ASC LIMIT 20`);
    res.json({ok:true,rank:r.rows});
  }catch(e){res.status(500).json({ok:false,error:'Không lấy được BXH.'})}
});

app.get('/health', async (_req,res)=>{ try { await q('SELECT 1'); res.json({ok:true,game:'running',time:now().toISOString()}); } catch { res.status(503).json({ok:false}); } });
app.post('/api/auth/register', async (req,res)=>{
  const username=String(req.body.username||'').trim(); const password=String(req.body.password||'');
  if(!/^[A-Za-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ok:false,error:'Tên tài khoản 3–24 ký tự.'});
  if(password.length<6) return res.status(400).json({ok:false,error:'Mật khẩu tối thiểu 6 ký tự.'});
  try {
    const r=await q(`INSERT INTO users(username,password_hash,ttt) VALUES($1,$2,$3) RETURNING id,username,ttt,spins,best_win`,[username,passwordHash(password),START_TTT]);
    const t=token(); await q(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')`,[hash(t),r.rows[0].id]);
    res.json({ok:true,token:t,user:r.rows[0]});
  } catch(e){ if(e.code==='23505') return res.status(409).json({ok:false,error:'Tài khoản đã tồn tại.'}); console.error(e); res.status(500).json({ok:false,error:'Không tạo được tài khoản.'}); }
});
app.post('/api/auth/login', async (req,res)=>{
  const username=String(req.body.username||'').trim(); const password=String(req.body.password||'');
  try { const r=await q(`SELECT * FROM users WHERE lower(username)=lower($1)`,[username]); if(!r.rowCount||!passwordVerify(password,r.rows[0].password_hash)) return res.status(401).json({ok:false,error:'Sai tài khoản hoặc mật khẩu.'});
    const t=token(); await q(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')`,[hash(t),r.rows[0].id]);
    res.json({ok:true,token:t,user:{id:r.rows[0].id,username:r.rows[0].username,ttt:r.rows[0].ttt,spins:r.rows[0].spins,best_win:r.rows[0].best_win}});
  } catch(e){console.error(e);res.status(500).json({ok:false,error:'Lỗi máy chủ.'});}
});
app.post('/api/auth/logout',auth,async(req,res)=>{await q(`DELETE FROM sessions WHERE token_hash=$1`,[hash(req.sessionToken)]);res.json({ok:true});});
app.get('/api/me',auth,async(req,res)=>{const r=await q(`SELECT id,username,ttt,spins,best_win FROM users WHERE id=$1`,[req.user.id]);res.json({ok:true,user:r.rows[0]});});

app.get('/api/tx/state',auth,async(req,res)=>{
  const r=await currentRound();
  const h=await q(`SELECT id,round_id,d1,d2,d3,total,side,created_at FROM tx_history ORDER BY id DESC LIMIT 50`);
  const bets=await q(`SELECT side,COALESCE(SUM(amount),0) amount FROM tx_bets WHERE round_id=$1 GROUP BY side`,[r.id]);
  const totals={tai:0,xiu:0}; for(const b of bets.rows) totals[b.side]=Number(b.amount);
  const my=await q(`SELECT COALESCE(SUM(amount),0) amount FROM tx_bets WHERE round_id=$1 AND user_id=$2 AND settled=false`,[r.id,req.user.id]);
  res.json({ok:true,serverNow:Date.now(),round:{id:r.id,endsAt:new Date(r.ends_at).getTime(),resultUntil:r.result_until?new Date(r.result_until).getTime():null,status:r.status,dice:r.status==='closed'?[r.d1,r.d2,r.d3]:null,total:r.total||null,side:r.side||null},totals,myStake:Number(my.rows[0].amount),history:h.rows,user:req.user});
});
app.post('/api/tx/bet',auth,async(req,res)=>{
  const side=req.body.side; const amount=Math.floor(Number(req.body.amount));
  if(!['tai','xiu'].includes(side)||!Number.isFinite(amount)||amount<1000) return res.status(400).json({ok:false,error:'Cược không hợp lệ.'});
  const client=await pool.connect();
  try { await client.query('BEGIN'); const rr=await client.query(`SELECT * FROM tx_rounds WHERE status='open' ORDER BY id DESC LIMIT 1 FOR UPDATE`); if(!rr.rowCount||new Date(rr.rows[0].ends_at)<=now()) {await client.query('ROLLBACK'); return res.status(409).json({ok:false,error:'Ván đã khóa.'});}
    const u=await client.query(`SELECT ttt FROM users WHERE id=$1 FOR UPDATE`,[req.user.id]); if(Number(u.rows[0].ttt)<amount){await client.query('ROLLBACK');return res.status(400).json({ok:false,error:'Không đủ TTT.'});}
    await client.query(`UPDATE users SET ttt=ttt-$1 WHERE id=$2`,[amount,req.user.id]); await client.query(`INSERT INTO tx_bets(round_id,user_id,side,amount) VALUES($1,$2,$3,$4)`,[rr.rows[0].id,req.user.id,side,amount]); await client.query('COMMIT'); res.json({ok:true});
  } catch(e){try{await client.query('ROLLBACK')}catch{};console.error(e);res.status(500).json({ok:false,error:'Không đặt được cược.'});} finally{client.release();}
});
app.post('/api/tx/cancel',auth,async(req,res)=>{
  const client=await pool.connect(); try{await client.query('BEGIN'); const rr=await client.query(`SELECT * FROM tx_rounds WHERE status='open' ORDER BY id DESC LIMIT 1 FOR UPDATE`); if(!rr.rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,error:'Ván không tồn tại.'});} const bets=await client.query(`SELECT COALESCE(SUM(amount),0) amount FROM tx_bets WHERE round_id=$1 AND user_id=$2 AND settled=false`,[rr.rows[0].id,req.user.id]); const amount=Number(bets.rows[0].amount); if(amount){await client.query(`UPDATE users SET ttt=ttt+$1 WHERE id=$2`,[amount,req.user.id]);await client.query(`DELETE FROM tx_bets WHERE round_id=$1 AND user_id=$2 AND settled=false`,[rr.rows[0].id,req.user.id]);} await client.query('COMMIT');res.json({ok:true,refund:amount});}catch(e){try{await client.query('ROLLBACK')}catch{};res.status(500).json({ok:false,error:'Không hủy được.'});}finally{client.release();}
});

/* ===== XÓC ĐĨA SERVER STATE ===== */
const XD_START_POT = 100000000;
async function initXdDb(){
  await q(`CREATE TABLE IF NOT EXISTS xd_rounds(
    id BIGSERIAL PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'open', result_until TIMESTAMPTZ,
    red_count SMALLINT, side VARCHAR(5), multiplier NUMERIC(8,2)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS xd_bets(
    id BIGSERIAL PRIMARY KEY, round_id BIGINT NOT NULL REFERENCES xd_rounds(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side VARCHAR(4) NOT NULL CHECK(side IN ('chan','le')), amount BIGINT NOT NULL,
    settled BOOLEAN NOT NULL DEFAULT FALSE, win_ttt BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS xd_history(
    id BIGSERIAL PRIMARY KEY, round_id BIGINT UNIQUE NOT NULL REFERENCES xd_rounds(id) ON DELETE CASCADE,
    red_count SMALLINT NOT NULL, white_count SMALLINT NOT NULL, side VARCHAR(5) NOT NULL,
    multiplier NUMERIC(8,2) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const r=await q(`SELECT id FROM xd_rounds ORDER BY id DESC LIMIT 1`);
  if(!r.rowCount) await createXdRound();
}
async function createXdRound(){
  const st=now(), en=new Date(st.getTime()+GAME_SECONDS*1000);
  await q(`INSERT INTO xd_rounds(started_at,ends_at,status) VALUES($1,$2,'open')`,[st,en]);
}
async function currentXdRound(){
  let r=await q(`SELECT * FROM xd_rounds ORDER BY id DESC LIMIT 1`);
  if(!r.rowCount){await createXdRound();r=await q(`SELECT * FROM xd_rounds ORDER BY id DESC LIMIT 1`);}
  const x=r.rows[0];
  if(x.status==='closed' && x.result_until && new Date(x.result_until)<=now()){
    await createXdRound(); r=await q(`SELECT * FROM xd_rounds ORDER BY id DESC LIMIT 1`);
  }
  return r.rows[0];
}
async function settleXdRound(round){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const rr=await c.query(`SELECT * FROM xd_rounds WHERE id=$1 FOR UPDATE`,[round.id]);
    if(!rr.rowCount||rr.rows[0].status!=='open'){await c.query('ROLLBACK');return;}
    const red=crypto.randomInt(0,5), white=4-red;
    const side=red%2===0?'CHẴN':'LẺ';
    const multiplier=(red===0||red===4)?16:((red===1||red===3)?4:1.95);
    const until=new Date(Date.now()+RESULT_GAP_SECONDS*1000);
    await c.query(`UPDATE xd_rounds SET status='closed',red_count=$2,side=$3,multiplier=$4,result_until=$5 WHERE id=$1`,
      [round.id,red,side,multiplier,until]);
    await c.query(`INSERT INTO xd_history(round_id,red_count,white_count,side,multiplier)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(round_id) DO NOTHING`,
      [round.id,red,white,side,multiplier]);
    const bets=await c.query(`SELECT * FROM xd_bets WHERE round_id=$1 AND settled=false FOR UPDATE`,[round.id]);
    for(const bet of bets.rows){
      const win=bet.side===(side==='CHẴN'?'chan':'le')?Math.floor(Number(bet.amount)*multiplier):0;
      await c.query(`UPDATE users SET ttt=ttt+$1, spins=spins+1, best_win=GREATEST(best_win,$1) WHERE id=$2`,
        [win,bet.user_id]);
      await c.query(`UPDATE xd_bets SET settled=true,win_ttt=$1 WHERE id=$2`,[win,bet.id]);
    }
    await c.query('COMMIT');
  }catch(e){try{await c.query('ROLLBACK')}catch{};console.error('settleXdRound',e)}
  finally{c.release()}
}
async function xdTick(){
  try{const r=await currentXdRound();if(r.status==='open'&&new Date(r.ends_at)<=now())await settleXdRound(r)}
  catch(e){console.error('xdTick',e)}
}
app.get('/api/xd/state',auth,async(req,res)=>{
  const r=await currentXdRound();
  const h=await q(`SELECT id,round_id,red_count,white_count,side,multiplier,created_at FROM xd_history ORDER BY id DESC LIMIT 50`);
  const my=await q(`SELECT COALESCE(SUM(amount),0) amount FROM xd_bets WHERE round_id=$1 AND user_id=$2 AND settled=false`,[r.id,req.user.id]);
  res.json({ok:true,serverNow:Date.now(),round:{id:r.id,endsAt:new Date(r.ends_at).getTime(),resultUntil:r.result_until?new Date(r.result_until).getTime():null,status:r.status,redCount:r.red_count,whiteCount:r.white_count,side:r.side,multiplier:r.multiplier},myStake:Number(my.rows[0].amount),history:h.rows,user:req.user});
});
app.post('/api/xd/bet',auth,async(req,res)=>{
  const side=req.body.side, amount=Math.floor(Number(req.body.amount));
  if(!['chan','le'].includes(side)||!Number.isFinite(amount)||amount<1000)return res.status(400).json({ok:false,error:'Cược không hợp lệ.'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const rr=await c.query(`SELECT * FROM xd_rounds WHERE status='open' ORDER BY id DESC LIMIT 1 FOR UPDATE`);
    if(!rr.rowCount||new Date(rr.rows[0].ends_at)<=now()){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'Ván đã khóa.'})}
    const u=await c.query(`SELECT ttt FROM users WHERE id=$1 FOR UPDATE`,[req.user.id]);
    if(Number(u.rows[0].ttt)<amount){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'Không đủ TTT.'})}
    await c.query(`UPDATE users SET ttt=ttt-$1 WHERE id=$2`,[amount,req.user.id]);
    await c.query(`INSERT INTO xd_bets(round_id,user_id,side,amount) VALUES($1,$2,$3,$4)`,[rr.rows[0].id,req.user.id,side,amount]);
    await c.query('COMMIT');res.json({ok:true});
  }catch(e){try{await c.query('ROLLBACK')}catch{};res.status(500).json({ok:false,error:'Không đặt được cược.'})}
  finally{c.release()}
});

app.get('/api/my/history',auth,async(req,res)=>{const r=await q(`SELECT b.id,b.amount,b.side,b.win_ttt,b.settled,b.created_at,r.id round_id,r.d1,r.d2,r.d3,r.total,r.side result_side FROM tx_bets b JOIN tx_rounds r ON r.id=b.round_id WHERE b.user_id=$1 ORDER BY b.id DESC LIMIT 50`,[req.user.id]);res.json({ok:true,history:r.rows});});

app.post('/api/redeem',auth,async(req,res)=>{
  const code=String(req.body.code||'').trim(); if(!code)return res.status(400).json({ok:false,error:'Thiếu code.'});
  try{const upstream=await fetch(UPSTREAM_REDEEM,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,deviceId:`user-${req.user.id}`})});const d=await upstream.json().catch(()=>({}));if(!upstream.ok||!d.ok)return res.status(upstream.status||400).json({ok:false,error:d.error||'Code không hợp lệ.'});const reward=Math.floor(Number(d.reward)||0);await q(`UPDATE users SET ttt=ttt+$1 WHERE id=$2`,[reward,req.user.id]);res.json({ok:true,reward});}catch(e){console.error(e);res.status(502).json({ok:false,error:'Không kết nối được máy chủ code.'});}
});

app.get('/{*splat}',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(()=>initXdDb()).then(()=>{
  app.listen(PORT,()=>console.log(`SCT Rank Arena server listening on ${PORT}`));
  setInterval(gameTick,1000);
  setInterval(xdTick,1000);
  gameTick(); xdTick();
}).catch(e=>{console.error('DB INIT FAILED',e);process.exit(1);});
