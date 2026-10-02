# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

顶栏挂 **合格率对照** 入口：小时窗对照台，按厢线列出合格量、超温量与占比，供交班核对。

## 合格率对照台

- **入口**：登录后顶栏「合格率对照」按钮。
- **窗宽**：页面上方选 1 / 2 / 4 / 8 / 24 小时，默认 1 小时，截止时刻默认当前（可选定截止时刻回看）；**记录员可调窗，值班员只读不可调窗**（接口侧同样拒绝值班员改窗，返回 403）。
- **中部**：各厢线的合格量、超温量、合计、合格率、超温占比；点击某条厢线可展开该窗内明细行，与总览对拍。
- **底部**：刷新按钮与口径说明。
- **口径**：仅统计已办结行（`status='done'` 且 `processed_at` 非空，截止时刻尚未办结的行不进桶），按办结时刻 `processed_at` 落入窗口 `[start, end]`（含两端）计；厢线取探头编号中首段英文字母（无字母取完整编号）；占比 = 对应数量 ÷ 该线合计。
- **一致性**：汇总与明细全部走服务端同一口径 SQL，页面不做浏览器加总；调窗后立即向服务端重算。

### 对照台接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/summary?hours=1&end=<ISO>&start=<ISO>` | 各厢线合格量/超温量/占比 + 合计；`end` 缺省为服务端当前时刻，`start` 缺省为 `end - hours` |
| GET | `/api/summary/details?hours=1&line=A` | 同一窗口口径的明细行，可按 `line` 过滤；与汇总零误差 |

值班员（watcher）调用时带非默认窗宽或自定义起止时刻会被拒绝（403）。

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
