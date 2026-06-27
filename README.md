# 雀阁 · 纸牌房

雀阁是一个基于 Node.js、Socket.IO 和 Vue 2 的在线纸牌房项目。项目最初 fork 自 [laivv/doudizhu](https://github.com/laivv/doudizhu.git)，现在已重构为“房间制 + 多玩法”的纸牌游戏平台，当前支持斗地主和掼蛋，并预留继续接入新玩法的结构。

## 功能概览

- 动态房间：支持公开房、私密房、房号加入、快速入局。
- 斗地主：三人叫分、地主底牌、地主/农民阵营、炸弹与春天倍率、AI 对手、智囊推荐。
- 掼蛋：四人两副牌、固定对家、级牌升级、红桃级牌逢人配、AI 补位、智囊推荐、局内队伍计分板。
- 观战模式：可不入座观看正在进行的房间。
- AI 系统：空位可补 AI，真人可顶替等待态 AI，AI 会自动重新准备。
- 聊天系统：房间内自由文本聊天。
- 音效与特效：出牌、不出、炸弹、王炸、同花顺等有局内反馈，可静音。
- 积分系统：可选 MySQL 持久化，斗地主和掼蛋积分榜独立统计。
- Discuz SSO：可选 JWT 单点登录，支持同步 Discuz 用户名和头像。
- 登录分支：默认首页保留 Discuz 登录/访客入口；普通玩家可访问 `/?auth=guest` 直接输入用户名进入。
- 移动端：大厅可响应式使用；牌桌在手机端要求横屏。

## 快速开始

要求 Node.js 18 或更高版本。

```bash
npm install
npm start
```

默认监听 `8002`：

```text
http://localhost:8002/
```

本地指定端口：

```powershell
$env:PORT='8012'
node server.js
```

## 配置

项目启动时按以下优先级读取配置：

1. 环境变量
2. 根目录 `config.json`
3. 代码默认值

复制示例配置：

```bash
cp config.example.json config.json
```

`config.json` 已加入 `.gitignore`，不要提交真实密钥和数据库密码。

常用配置：

| 字段 / 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | HTTP / Socket.IO 监听端口 | `8002` |
| `JWT_SECRET` | Discuz SSO JWT 密钥，必须与论坛端一致 | `change_this_in_production` |
| `DB_HOST` | MySQL 地址 | `127.0.0.1` |
| `DB_PORT` | MySQL 端口 | `3306` |
| `DB_USER` | MySQL 用户名 | 无 |
| `DB_PASSWORD` | MySQL 密码 | 空 |
| `DB_NAME` | MySQL 数据库名 | 无 |
| `DB_TABLE_PREFIX` | 表前缀，建议与 Discuz 一致 | `pre_` |
| `DB_DISABLE` | 设为 `1` 禁用数据库持久化 | 未启用 |
| `SCORE_BASE` | 每个基础分对应的积分 | `1` |
| `DISCUZ_AVATAR_BASE` | Discuz 头像 URL 模板，支持 `{uid}` | `https://zwwx.club/uc_server/avatar.php?uid={uid}&size=middle` |

## 玩法说明

### 斗地主

- 三人参与。
- 叫分后分为地主与农民两方。
- 地主获得底牌。
- 支持常见斗地主牌型，牌型识别由 `static/js/parser.js` 和 `game.js` 处理。
- 结算时地主按双倍基础分输赢，农民按单倍基础分输赢。

### 掼蛋

- 四人参与，两副牌，每人 27 张。
- 座位 `0/2` 为一队，`1/3` 为一队。
- 当前级牌从 `2` 开始，红桃级牌为逢人配。
- 头游队伍升级：双下 `+3`，二三名 `+2`，其他胜局 `+1`。

第一类牌型：

- 单张：任意一张牌。
- 对子：两张点数相同的牌，包括对大王或对小王。
- 三连对：三对连续对子，例如 `223344`。
- 三同张：三张点数相同的牌。
- 二连三：两组三同张，例如 `333444`。
- 三带二：三同张带一个对子，例如 `55522`。
- 顺子：五张连续单牌，例如 `23456`。

第一类牌型之间必须牌型相同才能压牌；三带二只比较三同张大小。

连续牌型中，`A` 可以作为最小值，也可以作为 `K+1`。例如 `A2345`、`23456`、`10JQKA`、`AA2233`、`QQKKAA` 都是合法连续牌型。

第二类牌型：

- 炸弹：四张或四张以上点数相同的牌。
- 同花顺：五张花色相同的顺子。
- 天王炸：大小王各两张。

第二类可以压任意第一类。第二类内部顺序：

- 天王炸最大。
- 炸弹张数越多越大，张数相同比点数。
- 同花顺按顺子点数比较。
- 同花顺可以压五张及以下炸弹，六张及以上炸弹大于同花顺。

## 智囊与 AI

斗地主智囊由 `static/js/ai-suggest.js` 提供。

掼蛋智囊由 `static/js/guandan-suggest.js` 提供，服务端机器人与前端“智囊”共用同一套规则分析。策略原则：

- 自由出牌时优先减少手数。
- 跟牌时尽量用最小可压牌。
- 队友出牌时通常不压，除非可以直接走完。
- 炸弹和逢人配会尽量保留，除非局势需要。

## 积分系统

数据库持久化是可选能力。未配置数据库时，游戏仍可正常运行，但不会保存积分。

启动时自动创建两张表：

```text
pre_doudizhu_score
pre_guandan_score
```

表前缀由 `DB_TABLE_PREFIX` 决定。

HTTP 查询接口：

| 接口 | 说明 |
| --- | --- |
| `GET /api/score/me?gameType=doudizhu&token=<JWT>` | 当前用户斗地主战绩 |
| `GET /api/score/me?gameType=guandan&token=<JWT>` | 当前用户掼蛋战绩 |
| `GET /api/score/top?gameType=doudizhu&limit=20` | 斗地主积分榜 |
| `GET /api/score/top?gameType=guandan&limit=20` | 掼蛋积分榜 |

只有通过 JWT 登录的真人玩家会计入积分。游客、AI、观战用户不记录。

## Discuz SSO

项目支持通过 Discuz 签发 JWT 进行单点登录。

- 论坛端示例代码在 `discuz-sso/`。
- 游戏端通过 Socket.IO `auth.token` 校验 JWT。
- 登录成功后可同步 Discuz 用户名和头像。

详细部署见 [discuz-sso/README.md](discuz-sso/README.md)。

## 项目结构

```text
.
├── server.js                    # Express + Socket.IO 入口、房间、AI、API
├── game.js                      # 斗地主状态机
├── guandan-game.js              # 掼蛋状态机与服务端判牌
├── db.js                        # 分玩法积分持久化
├── core-ai.js                   # 原斗地主 AI 辅助
├── core-validator.js            # 原斗地主校验辅助
├── config.example.json          # 本地配置示例
├── discuz-sso/                  # Discuz JWT SSO 示例
└── static/
    ├── index.html               # Vue 2 单页应用
    ├── css/
    │   ├── theme.css            # 主题变量
    │   └── style.css            # 主要布局与组件样式
    ├── images/                  # 扑克图、桌面素材
    └── js/
        ├── parser.js            # 斗地主牌型解析
        ├── ai-suggest.js        # 斗地主智囊
        ├── guandan-suggest.js   # 掼蛋智囊
        ├── effects.js           # 音效与特效
        ├── vue.min.js
        ├── jquery.min.js
        └── layer/               # 弹窗组件
```

## 常用 Socket 事件

客户端到服务端：

- `LOGIN`
- `CREATE_ROOM`
- `QUICK_JOIN`
- `JOIN_ROOM`
- `SITDOWN`
- `PREPARE`
- `CALL_SCORE`
- `PLAY_CARD`
- `USER_MESSAGE`
- `SPECTATE`
- `ADD_BOTS`
- `REMOVE_BOTS`

服务端到客户端：

- `LOGIN_SUCCESS`
- `LOGIN_FAIL`
- `REFRESH_LIST`
- `POS_STATUS_CHANGE`
- `GAME_START`
- `CTX_USER_CHANGE`
- `CTX_PLAY_CHANGE`
- `SHOW_TOP_CARD`
- `PLAY_CARD_SUCCESS`
- `PLAY_CARD_ERROR`
- `GAME_OVER`
- `USER_MESSAGE`
- `MY_SCORE`

## 开发与验证

语法检查：

```bash
node --check server.js
node --check db.js
node --check game.js
node --check guandan-game.js
node --check static/js/guandan-suggest.js
node --check static/js/effects.js
```

本地规则回归建议覆盖：

- 掼蛋 `A2345`、`23456`、`10JQKA`
- 掼蛋三连对、二连三、三带二
- 同花顺压五张炸，六张炸压同花顺
- 天王炸压所有牌型
- 斗地主叫分、底牌、出牌、结算

## 部署建议

- 使用 HTTPS，特别是启用 Discuz SSO 时。
- 生产环境必须设置强随机 `JWT_SECRET`。
- 建议用 systemd、pm2 或容器托管 Node 进程。
- 如在 Cloudflare 等代理后运行，保留 WebSocket 支持。
- 数据库账号只授予游戏积分表需要的权限。

systemd 示例：

```ini
[Unit]
Description=Quege Card Room
After=network.target

[Service]
WorkingDirectory=/var/www/quege-card-room
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=8002
Environment=JWT_SECRET=replace-with-a-strong-secret
Environment=DB_HOST=127.0.0.1
Environment=DB_USER=discuz
Environment=DB_PASSWORD=replace-with-db-password
Environment=DB_NAME=discuz
Environment=DB_TABLE_PREFIX=pre_

[Install]
WantedBy=multi-user.target
```

## License

代码以 [MIT License](LICENSE) 发布。

`static/images/` 中的牌面、桌面等素材仅作为演示资源；商业使用请确认素材授权或自行替换。
