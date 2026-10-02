# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

顶栏「合格率对照」进入厢线合格率小时窗对照台，方便交班核对：上选窗宽，中列各厢线合格量 / 超温量与占比，下挂刷新按钮与口径说明；记录员可调窗宽，值班侧只读不可改窗；点每行「明细」可按厢线展开明细行与总览对拍。

## 统计口径

- 仅统计已办结（`status = 'done'`）且办结时刻落在 **（截止时刻 − 窗宽，截止时刻]** 的读数；待处理、处理中不计入。
- 截止时刻默认为服务端当前时刻，刷新时重取；明细请求带回汇总下发的截止时刻，保证汇总与明细零误差。
- 厢线按探头编号字母段归组（如 `探头A01` → `A` 线）。
- 合格率 = 合格量 ÷（合格量＋超温量），超温占比同理；全部聚合在服务端完成，页面不做本地加总。

## 对照台接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats/pass-rate?window_hours=8&cutoff=<ISO8601 可选>` | 各厢线合格量 / 超温量 / 占比汇总 |
| GET | `/api/stats/pass-rate/detail?window_hours=8&cutoff=<ISO8601>&line=A` | 指定厢线明细行与服务端合计 |

`window_hours` 支持小数（如 `0.0833` ≈ 5 分钟），两接口均需登录。

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python aiohttp + asyncpg |
| 工人 | `worker.py`（psycopg，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Preact + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3197 |
| 接口 | http://localhost:8197 |
| PostgreSQL | localhost:54397（库名 `coldchain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| logger | log123456 | 记录员，可提交读数 |
| watcher | watch123456 | 值班员，只读列表 |

## 启动

```bash
cd projects/18-coldchain-probe-desk
docker compose up --build
```

健康检查：`GET http://localhost:8197/api/health` → `{"status":"ok","service":"coldchain-probe-desk"}`

## 种子数据

| 探头 | 温度 | 结论 |
|------|------|------|
| 探头A01 | 4.2℃ | 合格 |
| 探头B02 | 12.5℃ | 超温 |

## 本地开发（可选）

```bash
# 需本机 PostgreSQL 或仅起 db 容器
cd backend && pip install -r requirements.txt && python api.py
cd backend && python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8197**。
