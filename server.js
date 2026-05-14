const express = require('express'),
  app = express(),
  http = require('http').Server(app),
  io = require('socket.io')(http, {
    // CF 橙云代理下，单 WS 连接 100 秒无流量会被切断，缩短心跳避免被切
    pingInterval: 25000,
    pingTimeout: 20000,
  });

// ========== 配置文件（推荐方式）==========
// 在项目根目录创建 config.json（已在 .gitignore），格式：
// {
//   "PORT": 8002,
//   "JWT_SECRET": "与论坛 DISCUZ_SSO_SECRET 完全一致的字符串",
//   "DB_HOST": "127.0.0.1",
//   "DB_PORT": 3306,
//   "DB_USER": "zwwx_dz",
//   "DB_PASSWORD": "数据库密码",
//   "DB_NAME": "zwwx_discuz",
//   "DB_TABLE_PREFIX": "pre_",
//   "SCORE_BASE": 1
// }
// 读取顺序：环境变量 > config.json > 默认值；并把 config.json 中的值塞回 process.env，
// 使下游模块（db.js 等）也能用 process.env.* 读到。
(function loadConfig() {
  try {
    const fs = require('fs');
    const path = require('path');
    const f = path.join(__dirname, 'config.json');
    if (!fs.existsSync(f)) return;
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    Object.keys(cfg).forEach(function (k) {
      if (cfg[k] === null || cfg[k] === undefined) return;
      // 环境变量优先，已设的不覆盖
      if (process.env[k] !== undefined && process.env[k] !== '') return;
      process.env[k] = String(cfg[k]);
    });
    console.log('[config] 已加载 config.json');
  } catch (e) {
    console.error('[config] config.json 解析失败：', e && e.message);
  }
})();

app.use(express.static(`${__dirname}/static`));
app.get('/', function (req, res) {
  res.sendFile(`${__dirname}/index.html`);
});
const Game = require('./game.js');
const AISuggest = require('./static/js/ai-suggest.js').AISuggest;
const db = require('./db.js');

// 底分（每分对应多少积分）。可通过环境变量调整。
const SCORE_BASE = Number(process.env.SCORE_BASE || 1);

// ========== 安全加固：API 防滥用 ==========
// 设计原则：所有"加分/扣分"都只能由服务端 socket 流程里的 game.getResult() 触发，
// 任何 HTTP 写入接口一律不存在；下方中间件确保即使将来误添加也不会被利用。
//
// 1) 任何非 GET 的 /api/* 请求一律拒绝（白名单只允许 GET）。
//    这就把 `POST /api/scores`、`POST /api/score/...`、`PUT /api/...` 等全部封死。
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).type('application/json').send(JSON.stringify({
      error: 'method_not_allowed',
      message: '本服务的积分写入只能由对局结算在服务端触发，不接受任何 HTTP 写入请求。'
    }));
  }
  // 不挂 body parser，确保任何 JSON body 都不会被解析或使用
  next();
});

// 2) /api/* 简单速率限制（按 IP，每 10 秒 30 次），抵御暴力探测/扫表。
const __apiHits = new Map();
app.use('/api', (req, res, next) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress || '').toString().split(',')[0].trim();
  const now = Date.now();
  const winMs = 10 * 1000;
  const max = 30;
  const arr = (__apiHits.get(ip) || []).filter(t => now - t < winMs);
  arr.push(now);
  __apiHits.set(ip, arr);
  // 顺手清理太久没活动的 IP，避免内存膨胀
  if (__apiHits.size > 5000) {
    for (const [k, v] of __apiHits) {
      if (!v.length || now - v[v.length - 1] > 5 * 60 * 1000) __apiHits.delete(k);
    }
  }
  if (arr.length > max) {
    return res.status(429).type('application/json').send(JSON.stringify({ error: 'rate_limited' }));
  }
  next();
});

// HTTP：查询自己积分（需 ?token=JWT）
app.get('/api/score/me', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, proto.JWT_SECRET);
    db.getUserScore(payload.uid).then(row => res.json(row || {}));
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
});
// HTTP：积分榜
app.get('/api/score/top', (req, res) => {
  const limit = Number(req.query.limit || 20);
  db.getTopScores(limit).then(rows => res.json(rows || []));
});

// HTTP：SSO 密钥健康检查（仅返回指纹，不泄漏明文）
// 对比论坛侧同样指纹即可确认两边是否一致
app.get('/api/sso/health', (req, res) => {
  const crypto = require('crypto');
  const s = proto.JWT_SECRET || '';
  const isDefault = (s === 'change_this_in_production');
  const fp = s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 16) : '';
  res.json({
    hasSecret: !!s && !isDefault,
    length: s.length,
    fingerprint: fp,
    source: process.env.JWT_SECRET ? 'env' : (require('fs').existsSync(require('path').join(__dirname, 'sso-secret.txt')) ? 'file' : 'default'),
    warning: isDefault ? 'JWT_SECRET 未配置，使用占位串' : null
  });
});

// 3) /api/* 兜底 404：任何未在上方显式声明的 /api/* GET 路径，统一返回 JSON 404。
//    例如：GET /api/scores、GET /api/admin 等。
app.all(/^\/api(\/.*)?$/, (req, res) => {
  res.status(404).type('application/json').send(JSON.stringify({ error: 'not_found' }));
});

const BOT_NAMES = ['玉狐', '青龙', '白鹭', '墨鸢', '朱雀', '碧波', '苍髯'];
function createDeskList(n) {
  n = n || 50;
  const ret = [];
  for (let i = 1; i <= n; i++) {
    const desk = {
      deskId: i,
      state: 0,
      positions: []
    }
    for (let j = 0; j < 3; j++) {
      desk.positions.push({
        posId: j,
        state: 0,
        userName: ''
      })
    }
    ret.push(desk);
  }
  return ret;
}

function time() {
  return (new Date()).toLocaleTimeString();
}


var guid = function () {
  var n = 0;
  return function () {
    return ++n;
  }
}();


function GameServer(port) {
  this.clients = [];
  this.port = port;
  this.desks = createDeskList(20);
  this.gameDatas = {};
  this.botTimers = {};
}
const proto = {
  // JWT secret used to validate tokens issued by Discuz (or other auth provider)
  // 优先级：环境变量 JWT_SECRET > sso-secret.txt 文件内容 > 占位串
  JWT_SECRET: (function () {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    try {
      const fs = require('fs');
      const path = require('path');
      const f = path.join(__dirname, 'sso-secret.txt');
      if (fs.existsSync(f)) {
        const s = fs.readFileSync(f, 'utf8').trim();
        if (s) return s;
      }
    } catch (e) {}
    return 'change_this_in_production';
  })(),
  broadCastHouse(event, data, socket) {
    socket = socket === undefined ? null : socket;
    this.clients.forEach((client, index) => {
      if (client.deskId === '') {
        client.socket.emit(event, data);
      }
    });
  },
  broadCastRoom(event, deskId, data, socket) {
    socket = socket === undefined ? null : socket;

    this.clients.forEach((client, index) => {
      if (client.deskId === deskId && client.socket !== socket) {
        client.socket.emit(event, data);
      }
    });
  },
  getDesk(deskId) {
    for (let i = 0, len = this.desks.length; i < len; i++) {
      let desk = this.desks[i];
      if (desk.deskId == deskId) {
        return desk;
      }
    }
    return null;
  },
  getOtherPosInfo(deskId, posId) {
    let desk = this.getDesk(deskId);
    if (desk) {
      let positions = desk.positions;
      return positions.filter(function (pos) {
        return pos.posId !== posId;
      })
    }
    return [];
  },
  updateOtherPosStatus(deskId, posId, state) {
    let desk = this.getDesk(deskId);
    if (desk) {
      let positions = desk.positions;
      positions.forEach(function (pos) {
        if (pos.posId !== posId) {
          pos.state = state;
        }
      }.bind(this));
    }

  },
  getPosition(desk, posId) {
    for (let i = 0, len = desk.positions.length; i < len; i++) {
      let position = desk.positions[i];
      if (position.posId == posId) {
        return position;
      }
    }
    return null;
  },
  isEmptyPos(deskId, posId) {
    const desk = this.getDesk(deskId);
    if (!desk) {
      return false;
    }
    const position = this.getPosition(desk, posId);
    return position && position.state === 0;
  },
  updatePosStatus(deskId, posId, state, userName) {
    const desk = this.getDesk(deskId);
    if (desk) {
      const position = this.getPosition(desk, posId);
      if (position) {
        position.state = state;
        if (userName === '' || userName) {
          position.userName = userName;
        }
      }
    }
  },
  updateRoomStatus(deskId, state) {
    const desk = this.getDesk(deskId);
    if (desk) {
      desk.state = state;
      return true;
    }
    return false;
  },
  removeClient(socket) {
    for (let i = 0, len = this.clients.length; i < len; i++) {
      if (this.clients[i].socket === socket) {
        this.clients.splice(i, 1);
        break;
      }
    }
  },
  addClient(socket, data) {
    this.clients.push({ userName: data.userName, uid: data.uid || 0, socket: socket, deskId: '', posId: '' });
  },
  getClient(socket) {
    for (let i = 0, len = this.clients.length; i < len; i++) {
      let client = this.clients[i];
      if (client.socket == socket) {
        return client;
      }
    }
    return null;
  },
  updateClientState(socket, deskId, posId) {
    let client = this.getClient(socket)
    if (client) {
      client.deskId = deskId !== undefined ? deskId : '';
      client.posId = posId !== undefined ? posId : '';
    }
  },
  getUserName(socket) {
    for (let i = 0, len = this.clients.length; i < len; i++) {
      if (this.clients[i].socket == socket) {
        return this.clients[i].userName;
      }
    }
    return null;
  },
  checkUserName(userName) {
    for (let i = 0, len = this.clients.length; i < len; i++) {
      if (this.clients[i].userName === userName) {
        return false;
      }
    }
    return true;
  },
  checkPrepareAll(deskId) {
    const desk = this.getDesk(deskId);
    if (desk) {
      const positions = desk.positions;
      for (let i = 0; i < 3; i++) {
        if (positions[i].state !== 2) {
          return false;
        }
      }
      return true;
    }
    return false;
  },
  startGame(deskId) {
    if (this.gameDatas[deskId] === undefined) {
      this.gameDatas[deskId] = new Game();
    }
    const game = this.gameDatas[deskId];
    game.init();
    const cards = game.start().getCards();
    this.broadCastRoom('GAME_START', deskId, { cards });
    this.broadCastRoom('CTX_USER_CHANGE', deskId, { ctxPos: game.getContextPosId(), ctxScore: game.getContextScore(), timeout: 15 });
    this.scheduleBotAction(deskId);
  },
  // ===== AI 机器人 =====
  hasHumanAtDesk(deskId) {
    return this.clients.some(c => c.deskId === deskId && c.posId !== 'spec');
  },
  seatBot(deskId, posId) {
    const desk = this.getDesk(deskId);
    if (!desk) return;
    const pos = this.getPosition(desk, posId);
    if (!pos) return;
    const used = desk.positions.map(x => x.userName).filter(Boolean);
    const name = (BOT_NAMES.find(n => !used.includes(n)) || '清客') + ' 〔AI〕';
    pos.state = 2; pos.userName = name; pos.isBot = true;
    this.broadCastRoom('POS_STATUS_CHANGE', deskId, { posId, state: 2, userName: name, isBot: true });
    this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 2 });
  },
  removeBot(deskId, posId) {
    const desk = this.getDesk(deskId);
    if (!desk) return null;
    const pos = this.getPosition(desk, posId);
    if (!pos || !pos.isBot) return null;
    const name = pos.userName;
    pos.state = 0; pos.userName = ''; pos.isBot = false;
    this.broadCastRoom('POS_STATUS_CHANGE', deskId, { posId, state: 0, userName: '' });
    this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 0 });
    return name;
  },
  removeAllBots(deskId) {
    const desk = this.getDesk(deskId);
    if (!desk) return;
    desk.positions.forEach(p => { if (p.isBot) this.removeBot(deskId, p.posId); });
  },
  isBotPos(deskId, posId) {
    const desk = this.getDesk(deskId);
    if (!desk) return false;
    const p = this.getPosition(desk, posId);
    return !!(p && p.isBot);
  },
  rePrepareBots(deskId) {
    const desk = this.getDesk(deskId);
    if (!desk) return;
    desk.positions.forEach(p => {
      if (p.isBot) {
        p.state = 2;
        this.broadCastRoom('POS_STATUS_CHANGE', deskId, { posId: p.posId, state: 2, userName: p.userName });
      }
    });
    // 若房间内全员（含真人）已就绪则自动开新一局
    if (this.checkPrepareAll(deskId)) {
      this.startGame(deskId);
    }
  },
  // 根据对局结果为带 uid 的真人玩家写入积分
  recordResultToDb(deskId, result) {
    if (!result || !db.isReady()) return;
    const desk = this.getDesk(deskId);
    if (!desk) return;
    // 判断地主 posId： winner/loser 中只含 1 人的那边
    const landlordPosId = result.winner.length === 1 ? result.winner[0] : result.loser[0];
    const base = (Number(result.score) || 1) * (Number(result.ratio) || 1) * SCORE_BASE;
    [0, 1, 2].forEach(posId => {
      // 找到该座位的真人客户端
      const client = this.clients.find(c => c.deskId === deskId && c.posId === posId);
      if (!client || !client.uid) return; // 未登录 / 机器人 / 观战 跳过
      const isLandlord = posId === landlordPosId;
      const win = result.winner.includes(posId);
      // 地主赢：+2*base；地主输：-2*base；农民赢：+base；农民输：-base
      const unit = isLandlord ? 2 : 1;
      const delta = (win ? 1 : -1) * unit * base;
      db.recordPlayer({
        uid: client.uid,
        username: client.userName,
        delta,
        win,
        isLandlord,
      }).then(() => db.getUserScore(client.uid))
        .then(row => { if (row) { try { client.socket.emit('MY_SCORE', row); } catch (e) {} } });
    });
  },
  clearBotTimer(deskId) {
    if (this.botTimers[deskId]) { clearTimeout(this.botTimers[deskId]); this.botTimers[deskId] = null; }
  },
  scheduleBotAction(deskId) {
    this.clearBotTimer(deskId);
    const game = this.gameDatas[deskId];
    if (!game) return;
    const status = game.getStatus();
    if (status !== 1 && status !== 2) return;
    const posId = game.getContextPosId();
    if (!this.isBotPos(deskId, posId)) return;
    const delay = 900 + Math.floor(Math.random() * 1100);
    this.botTimers[deskId] = setTimeout(() => {
      this.botTimers[deskId] = null;
      if (!this.isBotPos(deskId, posId)) return;
      const g = this.gameDatas[deskId];
      if (!g) return;
      if (g.getStatus() === 1 && g.getContextPosId() === posId) {
        this.botCallScore(deskId, posId);
      } else if (g.getStatus() === 2 && g.getContextPosId() === posId) {
        this.botPlayCard(deskId, posId);
      }
    }, delay);
  },
  botCallScore(deskId, posId) {
    const game = this.gameDatas[deskId];
    if (!game) return;
    const ctxScore = game.getContextScore() || [];
    let score = 0;
    if (Math.random() < 0.65 && ctxScore.length) {
      score = ctxScore[Math.floor(Math.random() * ctxScore.length)];
    }
    const status = game.next(posId, score).getStatus();
    if (status == 1) {
      this.broadCastRoom('CTX_USER_CHANGE', deskId, {
        ctxPos: game.getContextPosId(),
        ctxScore: game.getContextScore(),
        calledScores: game.getCalledScores(),
        timeout: 15
      });
      this.scheduleBotAction(deskId);
    }
    if (status == 2) {
      const topCards = game.getTopCards();
      const dizhuPosId = game.getDiZhuPosId();
      this.broadCastRoom('SHOW_TOP_CARD', deskId, { topCards, dizhuPosId, timeout: 15 });
      this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
        ctxData: { len: 0, key: '', type: '', cards: [], posId: dizhuPosId },
        posId: dizhuPosId, timeout: 30, isPass: false
      });
      this.scheduleBotAction(deskId);
    }
    if (status == 4) {
      this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: '本局无人叫分，重新发牌', id: guid(), time: time() });
      this.startGame(deskId);
    }
  },
  botPlayCard(deskId, posId) {
    const game = this.gameDatas[deskId];
    if (!game) return;
    const handRaw = (game.getCardsByPosId(posId) || []).slice(0);
    const hand = handRaw.map(c => ({ value: c.value, type: c.type }));
    const last = game.lastCardInfo || {};
    const lastInfo = (last.posId === posId || !last.len) ? { len: 0, ctxPos: 'self' } : {
      len: last.len, key: last.key, type: last.type, ctxPos: 'other'
    };
    let picks = [];
    try { picks = (AISuggest.suggest(hand, lastInfo)) || []; } catch (e) { picks = []; }
    // 解析为真实牌实例（按下标占用避免重复）
    const used = new Set();
    let data = [];
    picks.forEach(p => {
      for (let i = 0; i < handRaw.length; i++) {
        if (used.has(i)) continue;
        const c = handRaw[i];
        if (c.value === p.value && c.type === p.type) {
          data.push(c); used.add(i); break;
        }
      }
    });
    let isPass = !data.length;
    let ret = isPass ? { status: true, key: '', type: '' } : game.validate(posId, data);
    if (!ret.status && !isPass) {
      // 兜底：若可不出则不出，否则随便出最小一张
      if (last.posId !== posId && last.len > 0) {
        data = []; isPass = true; ret = { status: true, key: '', type: '' };
      } else {
        data = [handRaw[0]]; isPass = false; ret = game.validate(posId, data);
        if (!ret.status) { data = []; isPass = true; ret = { status: true, key: '', type: '' }; }
      }
    }
    game.next(posId, data);
    this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
      ctxData: { len: data.length, key: ret.key, type: ret.type, cards: data, posId },
      posId: game.getContextPosId(), timeout: 15, isPass
    });
    if (game.getStatus() === 3) {
      const result = game.getResult();
      this.broadCastRoom('GAME_OVER', deskId, result);
      this.recordResultToDb(deskId, result);
      this.updatePosStatus(deskId, 0, 1);
      this.updatePosStatus(deskId, 1, 1);
      this.updatePosStatus(deskId, 2, 1);
      game.init();
      this.clearBotTimer(deskId);
      this.rePrepareBots(deskId);
      return;
    }
    this.scheduleBotAction(deskId);
  },
  init() {
    // 启动期完整性自检
    if (this.JWT_SECRET === 'change_this_in_production') {
      console.warn('[WARN] JWT_SECRET 使用默认占位值，跨域 SSO token 必然校验失败。请在启动 node 进程时设置 JWT_SECRET 环境变量，并与论坛侧 DISCUZ_SSO_SECRET 保持一致。');
    }
    try { require.resolve('jsonwebtoken'); }
    catch (e) { console.error('[FATAL] 缺少 jsonwebtoken 依赖，请运行 npm install jsonwebtoken'); }

    // socket.io middleware: verify JWT token if provided during handshake
    io.use((socket, next) => {
      const token = (socket.handshake && (socket.handshake.auth && socket.handshake.auth.token)) || (socket.handshake && socket.handshake.query && socket.handshake.query.token);
      if (!token) return next();
      let jwt;
      try { jwt = require('jsonwebtoken'); }
      catch (e) {
        socket.tokenError = '服务器未安装 jsonwebtoken 模块';
        return next();
      }
      try {
        const payload = jwt.verify(token, this.JWT_SECRET);
        if (!payload || !payload.uid) {
          socket.tokenError = 'token 缺少 uid';
        } else {
          socket.user = { uid: payload.uid, username: payload.username };
        }
      } catch (err) {
        const msg = err && err.message || 'unknown';
        console.warn('JWT verify failed:', msg);
        // 把可读原因翻译给前端
        if (err && err.name === 'TokenExpiredError') socket.tokenError = '登录态已过期，请重新登录';
        else if (err && err.name === 'JsonWebTokenError') socket.tokenError = '登录凭证无效（签名不匹配，请检查服务器 JWT_SECRET）';
        else socket.tokenError = '登录凭证校验失败：' + msg;
      }
      return next();
    });

    io.on('connection', function (socket) {
      console.log('有客户端接入，时间： %s', time());
      // 校验失败 → 立刻通知前端，避免它卡在"正在登录…"
      if (socket.tokenError) {
        socket.emit('LOGIN_FAIL', { msg: socket.tokenError, code: 'TOKEN_INVALID' });
      }
      // if socket was authenticated via token, auto-register client
      if (socket.user) {
        try {
          // 同名旧连接踢掉（页面刷新/双开），避免 checkUserName 死锁
          for (let i = this.clients.length - 1; i >= 0; i--) {
            const c = this.clients[i];
            if (c.userName === socket.user.username && c.socket !== socket) {
              try { c.socket.emit('FORCE_LOGOUT', { msg: '账号在别处登录' }); c.socket.disconnect(true); } catch (e) {}
              this.clients.splice(i, 1);
            }
          }
          this.addClient(socket, { userName: socket.user.username, uid: socket.user.uid });
          socket.emit('WHOAMI', { uid: socket.user.uid, username: socket.user.username });
          socket.emit('LOGIN_SUCCESS', this.desks);
          console.log('已通过 token 自动登录用户：%s (uid=%s)', socket.user.username, socket.user.uid);
          // 推送一次该用户的积分
          db.getUserScore(socket.user.uid).then(row => { if (row) socket.emit('MY_SCORE', row); });
        } catch (e) {
          console.error('自动登录出错', e);
        }
      }
      socket.on('LOGIN', userName => {
        if (this.checkUserName(userName)) {
          this.addClient(socket, { userName });
          socket.emit('LOGIN_SUCCESS', this.desks);
          console.log('有客户端登录，时间： %s', time());
        } else {
          socket.emit('LOGIN_FAIL', { msg: '该用户名已存在' });
        }
      });

      //快速加入
      socket.on('QUICK_JOIN', () => {
        var ret = [];
        this.desks.forEach(desk => {
          let n = 0;
          let item = {
            deskId: desk.deskId,
            positions: []
          };
          const positions = desk.positions;
          positions.forEach(pos => {
            if (pos.state > 0) {
              n++;
            } else {
              item.positions.push(pos.posId)
            }
          });
          if (n <= 2) {
            ret.push(item);
          }
        });
        ret = ret.sort((a, b) => {
          return a.positions.length - b.positions.length;
        });
        const matched = ret.length ? ret[0] : false;
        const data = matched ? { deskId: matched.deskId, posId: matched.positions[0], success: true } : { success: false }
        socket.emit('QUICK_JOIN', data)

      });

      socket.on('SITDOWN', data => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        const { deskId, posId } = data;
        const desk = this.getDesk(deskId);
        const pos = desk && this.getPosition(desk, posId);
        const game = this.gameDatas[deskId];
        const inProgress = !!(game && game.getStatus && game.getStatus() > 0 && game.getStatus() < 3);
        const canTake = pos && (pos.state === 0 || (pos.isBot && !inProgress));
        if (canTake) {
          if (pos.isBot) {
            const oldName = pos.userName;
            this.removeBot(deskId, posId);
            this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: `[${oldName}] 拱手让座`, id: guid(), time: time() });
          }
          console.log('有客户端进入房间，桌号：%s，座位：%s，时间： %s', deskId, posId, time());
          //更新座位状态为占用
          this.updatePosStatus(deskId, posId, 1, this.getUserName(socket));
          //绑定客户端桌号，座位号
          this.updateClientState(socket, deskId, posId);
          //获取除当前房间其它座位信息
          let posInfos = this.getOtherPosInfo(deskId, posId);
          //通知该客户端坐下成功 并发送当前房间的信息给该客户端
          socket.emit('SITDOWN_SUCCESS', { ...data, posInfos });
          //通知在大厅游览的所有客户端当前坐位已被占用
          this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 1 });

          //通知在房间里的其它客户端，更新座位息
          this.broadCastRoom("POS_STATUS_CHANGE", deskId, { posId, state: 1, userName: this.getUserName(socket) }, socket);

          //推送一条无关紧要的消息
          socket.emit('USER_MESSAGE', { type: 'SYS', posId, msg: '欢迎您加入本房间，祝您游戏愉快！', id: guid(), time: time() });
          this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: `玩家[${this.getUserName(socket)}]进入房间`, id: guid(), time: time() }, socket);
        } else {
          //通知该客户端此座位被人占用
          socket.emit('SITDOWN_ERROR', { msg: '该位置已有人' });
          //由于当前位置被占用可能是由于该客户端数据不同步造成，所以再次向该客户端推送一次所有桌数据
          socket.emit('REFRESH_LIST', this.desks);
        }
      });

      socket.on('UNSITDOWN', data => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        const { deskId, posId } = client;
        if (!deskId) {
          return;
        }
        // 观战者走专用退出逻辑
        if (posId === 'spec') {
          this.updateClientState(socket);
          socket.emit('UNSITDOWN_SUCCESS', this.desks);
          return;
        }
        console.log('有客户端退出房间，桌号：%s，座位：%s，时间：', deskId, posId, time());
        //更新座位状态
        this.updatePosStatus(deskId, posId, 0, '');
        //重置房间状态
        this.updateRoomStatus(deskId, posId, 0);
        //解绑座位号 桌号
        this.updateClientState(socket);
        //通知在房间里的其它客户端，更新座位息
        this.broadCastRoom("POS_STATUS_CHANGE", deskId, { posId, state: 0 }, socket);
        //通知大厅其它客户端更新该座位信息
        this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 0 });

        //如果在游戏中，则有玩家强行退出，重置此房间其它玩家的状态为未准备
        //获取此桌游戏数据
        const game = this.gameDatas[deskId];
        //判断是否在进行游戏
        if (game) {
          const status = game.getStatus();
          if (game && status && status !== 3) {
            //更新其它两位玩家的座位状态为未准备
            this.updateOtherPosStatus(deskId, posId, 1);
            //获取其它两位玩家的座位信息
            const otherPosInfo = this.getOtherPosInfo(deskId, posId);
            //通知其它两位玩家重置自己的状态为未准备
            this.broadCastRoom("POS_STATUS_RESET", deskId, { pos: otherPosInfo, state: 1 });
            //通知其它两位玩家重置房间状态
            this.broadCastRoom('ROOM_STATUS_CHANGE', deskId, { state: 0 });
            //通知其它两位玩家当前玩家逃跑
            this.broadCastRoom('FORCE_EXIT_EV', deskId, { msg: '有玩家逃跑，游戏结束', posId });

            game.init();

          }
        }
        //通知当前玩家退出房间成功
        socket.emit('UNSITDOWN_SUCCESS', this.desks);


        //推送一条无关紧要的消息
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: `玩家[${this.getUserName(socket)}]退出房间`, id: guid(), time: time() })

        // 若该桌已无真人，则清退所有 AI、清掉计时器、重置 game
        if (!this.hasHumanAtDesk(deskId)) {
          this.removeAllBots(deskId);
          this.clearBotTimer(deskId);
          if (this.gameDatas[deskId]) this.gameDatas[deskId].init();
        }
      });

      socket.on('PREPARE', data => {
        const client = this.getClient(socket);
        if (!client || client.posId === 'spec') {
          return;
        }
        const { deskId, posId } = client;
        if (!deskId) {
          return;
        }
        //更新座位为准备状态
        this.updatePosStatus(deskId, posId, 2);
        //通知该客户端准备成功
        socket.emit('PREPARE_SUCCESS');
        //通知房间里的其它客户端更新座位信息
        this.broadCastRoom("POS_STATUS_CHANGE", deskId, { posId, state: 2 }, socket);

        //更新房间状态
        this.updateRoomStatus(deskId, 1);

        //检查是否全部准备完毕
        const isPrepareAll = this.checkPrepareAll(deskId);
        if (isPrepareAll) {
          this.startGame(deskId);
        }

      });

      socket.on('CALL_SCORE', data => {
        const { score } = data;
        const client = this.getClient(socket);
        if (!client || client.posId === 'spec') {
          return;
        }
        const { deskId, posId } = client;
        const game = this.gameDatas[deskId];
        if (!game || !deskId) {
          return;
        }
        const status = game.next(posId, score).getStatus();
        if (status == 1) {
          const ctxPos = game.getContextPosId();
          const ctxScore = game.getContextScore();
          const calledScores = game.getCalledScores();
          this.broadCastRoom('CTX_USER_CHANGE', deskId, { ctxPos, ctxScore, calledScores, timeout: 15 });
          this.scheduleBotAction(deskId);
        }
        if (status == 2) {
          const topCards = game.getTopCards();
          const dizhuPosId = game.getDiZhuPosId();
          this.broadCastRoom('SHOW_TOP_CARD', deskId, { topCards, dizhuPosId, timeout: 15 });
          this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
            ctxData: {
              len: 0,
              key: '',
              type: '',
              cards: [],
              posId: dizhuPosId,
            },
            posId: dizhuPosId,
            timeout: 30,
            isPass: false,
          })
          this.scheduleBotAction(deskId);
        }
        if (status == 4) {
          this.broadCastRoom('MESSAGE', deskId, { msg: '没有玩家叫分，重新发牌' });
          this.startGame(deskId);
          //推送一条无关紧要的消息
          this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: '本局游戏无人叫分，重新发牌', id: guid(), time: time() })

        }
      });


      socket.on('PLAY_CARD', data => {
        const client = this.getClient(socket);
        if (!client || client.posId === 'spec') {
          return;
        }
        const { deskId, posId } = client;
        const game = this.gameDatas[deskId];
        if (game && deskId) {
          const ret = game.validate(posId, data);
          const isPass = !data.length;
          const { status } = ret;
          if (status || !data.length) {
            game.next(posId, data);
            this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
              ctxData: {
                len: data.length,
                key: ret.key,
                type: ret.type,
                cards: data,
                posId
              },
              posId: game.getContextPosId(),
              timeout: 15,
              isPass
            })
            socket.emit('PLAY_CARD_SUCCESS', data)
            if (game.getStatus() === 3) {
              const result = game.getResult();
              this.broadCastRoom('GAME_OVER', deskId, result)
              this.recordResultToDb(deskId, result);
              this.updatePosStatus(deskId, 0, 1)
              this.updatePosStatus(deskId, 1, 1)
              this.updatePosStatus(deskId, 2, 1)
              game.init();
              this.clearBotTimer(deskId);
              this.rePrepareBots(deskId);
            } else {
              this.scheduleBotAction(deskId);
            }

            if (game.getStatus() === 5) {
              socket.emit('PLAY_CARD_ERROR', '游戏出错')
            }
          } else {
            socket.emit('PLAY_CARD_ERROR', data)
          }
        }
      });

      socket.on('disconnect', data => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        const userName = this.getUserName(socket);
        const { deskId, posId } = client;
        this.removeClient(socket);

        if (deskId) {
          // 观战者断连：不动座位/游戏状态
          if (posId === 'spec') {
            const userName2 = userName || '观众';
            this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: 'spec', msg: `观众[${userName2}]离开房间`, id: guid(), time: time() });
            console.log('观战者断开连接 %s', time());
            return;
          }
          //更新座位状态
          this.updatePosStatus(deskId, posId, 0, '');
          //重置房间状态
          this.updateRoomStatus(deskId, posId, 0);
          //解绑座位号 桌号
          this.updateClientState(socket);
          //通知在房间里的其它客户端，更新座位息
          this.broadCastRoom("POS_STATUS_CHANGE", deskId, { posId, state: 0 }, socket);
          //通知大厅其它客户端更新该座位信息
          this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 0 });

          //如果在游戏中，则有玩家强行退出，重置此房间其它玩家的状态为未准备
          //获取此桌游戏数据
          const game = this.gameDatas[deskId];
          //判断是否在进行游戏
          if (game) {
            const status = game.getStatus();
            if (game && status && status !== 3) {
              //更新其它两位玩家的座位状态为未准备
              this.updateOtherPosStatus(deskId, posId, 1);
              //获取其它两位玩家的座位信息
              const otherPosInfo = this.getOtherPosInfo(deskId, posId);
              //通知其它两位玩家重置自己的状态为未准备
              this.broadCastRoom("POS_STATUS_RESET", deskId, { pos: otherPosInfo, state: 1 });
              //通知其它两位玩家重置房间状态
              this.broadCastRoom('ROOM_STATUS_CHANGE', deskId, { state: 0 });
              //通知其它两位玩家当前玩家逃跑
              this.broadCastRoom('FORCE_EXIT_EV', deskId, { msg: '有玩家逃跑，游戏结束', posId });
              game.init();
            }
          }
          //推送一条无关紧要的消息
          this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: `玩家[${userName}]退出房间`, id: guid(), time: time() })
          console.log('有客户端退出房间，桌号：%s，座位：%s，时间：', deskId, posId, time());

          // 若该桌已无真人，则清退所有 AI
          if (!this.hasHumanAtDesk(deskId)) {
            this.removeAllBots(deskId);
            this.clearBotTimer(deskId);
            if (this.gameDatas[deskId]) this.gameDatas[deskId].init();
          }
        }

        console.log('有客户端断开了连接 %s', time());
      })

      socket.on('USER_MESSAGE', msg => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        const { deskId, posId } = client;
        if (!deskId) {
          return;
        }
        // 观战者发言走特殊通道，不参与方位映射
        if (posId === 'spec') {
          const userName = this.getUserName(socket) || '观众';
          const payload = { type: 'SPEC', posId: 'spec', name: userName, msg, time: time(), id: guid() };
          this.broadCastRoom('USER_MESSAGE', deskId, payload);
          socket.emit('USER_MESSAGE', payload);
          return;
        }
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'USER', posId, msg, time: time(), id: guid() })
      })

      // 观战 加入
      socket.on('SPECTATE', data => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        // 已经在某桌
        if (client.deskId) {
          socket.emit('SPECTATE_ERROR', { msg: '您已在房间内' });
          return;
        }
        const deskId = data && data.deskId;
        const desk = this.getDesk(deskId);
        if (!desk) {
          socket.emit('SPECTATE_ERROR', { msg: '房间不存在' });
          return;
        }
        // 至少要有一名玩家在座
        const seated = desk.positions.filter(p => p.state > 0).length;
        if (seated === 0) {
          socket.emit('SPECTATE_ERROR', { msg: '房间无人，无法观战' });
          return;
        }
        this.updateClientState(socket, deskId, 'spec');
        const game = this.gameDatas[deskId];
        const status = game && game.getStatus ? game.getStatus() : 0;
        const gameInProgress = status >= 1 && status < 3;
        let snapshot = null;
        if (gameInProgress) {
          // 把当前对局快照（叫分中或出牌中）发给观战者，便于无缝接入
          const cards = (game.getCards && game.getCards()) || [];
          // 仅把座位 0/1/2 的手牌打包（id=3 是底牌）
          const handGroups = cards.filter(g => g.id !== 3).map(g => ({
            id: g.id,
            cards: g.cards.map(c => ({ value: c.value, type: c.type }))
          }));
          snapshot = {
            status,
            cards: handGroups,
            callScores: game.getCalledScores ? Object.assign({}, game.getCalledScores()) : {},
            ctxPosId: game.getContextPosId ? game.getContextPosId() : '',
            ctxScore: game.getContextScore ? game.getContextScore() : [],
            lastCardInfo: game.lastCardInfo ? Object.assign({}, game.lastCardInfo) : null,
          };
          if (status >= 2) {
            snapshot.dizhuPosId = game.getDiZhuPosId ? game.getDiZhuPosId() : '';
            const top = (game.getTopCards && game.getTopCards()) || [];
            snapshot.topCards = top.map(c => ({ value: c.value, type: c.type }));
          }
        }
        socket.emit('SPECTATE_SUCCESS', {
          deskId,
          positions: desk.positions,
          gameInProgress,
          snapshot,
        });
        const userName = this.getUserName(socket) || '观众';
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: 'spec', msg: `观众[${userName}]进入房间`, id: guid(), time: time() }, socket);
      });

      // 观战 离开
      socket.on('UNSPECTATE', () => {
        const client = this.getClient(socket);
        if (!client || client.posId !== 'spec') {
          return;
        }
        const { deskId } = client;
        this.updateClientState(socket);
        socket.emit('UNSITDOWN_SUCCESS', this.desks);
        const userName = this.getUserName(socket) || '观众';
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: 'spec', msg: `观众[${userName}]离开房间`, id: guid(), time: time() }, socket);
      });

      // 召唤 AI 对手：把所有空位填满 AI
      socket.on('ADD_BOTS', () => {
        const client = this.getClient(socket);
        if (!client || !client.deskId || client.posId === 'spec') {
          socket.emit('USER_MESSAGE', { type: 'SYS', posId: '', msg: '请先入座再召唤 AI', id: guid(), time: time() });
          return;
        }
        const deskId = client.deskId;
        const desk = this.getDesk(deskId);
        if (!desk) return;
        const game = this.gameDatas[deskId];
        if (game && game.getStatus && game.getStatus() > 0 && game.getStatus() < 3) {
          socket.emit('USER_MESSAGE', { type: 'SYS', posId: client.posId, msg: '游戏中，无法召唤 AI', id: guid(), time: time() });
          return;
        }
        let added = 0;
        desk.positions.forEach(p => {
          if (p.state === 0) { this.seatBot(deskId, p.posId); added++; }
        });
        if (!added) {
          socket.emit('USER_MESSAGE', { type: 'SYS', posId: client.posId, msg: '已无空位，无法召唤 AI', id: guid(), time: time() });
          return;
        }
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: client.posId, msg: 'AI 对手已落座', id: guid(), time: time() });
        if (this.checkPrepareAll(deskId)) {
          this.startGame(deskId);
        }
      });

      // 请走 AI（回到等待真人模式）
      socket.on('REMOVE_BOTS', () => {
        const client = this.getClient(socket);
        if (!client || !client.deskId || client.posId === 'spec') return;
        const deskId = client.deskId;
        const game = this.gameDatas[deskId];
        if (game && game.getStatus && game.getStatus() > 0 && game.getStatus() < 3) {
          socket.emit('USER_MESSAGE', { type: 'SYS', posId: client.posId, msg: '游戏中，无法请走 AI', id: guid(), time: time() });
          return;
        }
        this.removeAllBots(deskId);
        this.clearBotTimer(deskId);
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: client.posId, msg: 'AI 已离席，等待真人入局', id: guid(), time: time() });
      });


    }.bind(this));


    http.listen(this.port, () => {
      console.log(`server is running on port ${this.port}`);
      (require('os').platform() == 'win32') && require('child_process').exec(`start http://localhost:${this.port}/index.html`);
    });
  }
}
Object.assign(GameServer.prototype, proto);
const gameServer = new GameServer(Number(process.env.PORT) || 8002);
db.init().finally(() => gameServer.init());
