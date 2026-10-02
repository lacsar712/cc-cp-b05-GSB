import json
import os
from datetime import datetime, timedelta, timezone

import asyncpg
import jwt
from aiohttp import web
from passlib.context import CryptContext

from db import create_pool, ensure_schema_async, seed_if_empty
from rules import judge_temp

SECRET = os.environ.get("JWT_SECRET", "coldchain-probe-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

# 合格率对照台口径：
# - 只统计已办结（status='done' 且 processed_at 非空）的行，未办结行不进桶；
# - 行按办结时刻 processed_at 落入窗口 [start, end]（含两端）计；
# - 厢线取探头编号中首段英文字母，无字母时以完整编号为线；
# - 汇总与明细共用同一条 WHERE，保证两侧数字零误差。
DEFAULT_WINDOW_HOURS = 1.0
MAX_WINDOW_HOURS = 24 * 7
LINE_EXPR = "COALESCE(substring(probe_id from '[A-Za-z]+'), probe_id)"
WINDOW_WHERE = (
    "status = 'done' AND processed_at IS NOT NULL "
    "AND processed_at >= $1 AND processed_at <= $2"
)

USERS = {
    "logger": {"role": "writer", "password_hash": pwd.hash("log123456")},
    "watcher": {"role": "reader", "password_hash": pwd.hash("watch123456")},
}


def _auth_header(request: web.Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def require_user(request: web.Request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        raise web.HTTPUnauthorized(text=json.dumps({"detail": "未登录"}, ensure_ascii=False), content_type="application/json")
    return user


def require_writer(request: web.Request) -> dict:
    user = require_user(request)
    if user["role"] != "writer":
        raise web.HTTPForbidden(
            text=json.dumps({"detail": "仅记录员可提交读数"}, ensure_ascii=False),
            content_type="application/json",
        )
    return user


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "coldchain-probe-desk"})


async def login(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        raise web.HTTPUnauthorized(
            text=json.dumps({"detail": "用户名或密码错误"}, ensure_ascii=False),
            content_type="application/json",
        )
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return web.json_response(
        {"access_token": token, "username": username, "role": user["role"]}
    )


async def list_readings(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        FROM probe_readings
        ORDER BY id DESC
        """
    )
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "probe_id": r["probe_id"],
                "temp_c": r["temp_c"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
            }
        )
    return web.json_response(out)


async def create_reading(request: web.Request) -> web.Response:
    user = require_writer(request)
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    probe_id = str(body.get("probe_id", "")).strip()
    if not probe_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "探头编号不能为空"}, ensure_ascii=False),
            content_type="application/json",
        )
    try:
        temp_c = float(body.get("temp_c"))
    except (TypeError, ValueError) as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "温度必须是数字"}, ensure_ascii=False),
            content_type="application/json",
        ) from exc

    pool: asyncpg.Pool = request.app["pool"]
    row = await pool.fetchrow(
        """
        INSERT INTO probe_readings (probe_id, temp_c, status, created_by, created_at)
        VALUES ($1, $2, 'pending', $3, now())
        RETURNING id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        """,
        probe_id,
        temp_c,
        user["username"],
    )
    return web.json_response(
        {
            "id": row["id"],
            "probe_id": row["probe_id"],
            "temp_c": row["temp_c"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


def _json_error(status: int, msg: str) -> web.HTTPException:
    exc_cls = {
        400: web.HTTPBadRequest,
        403: web.HTTPForbidden,
    }.get(status, web.HTTPInternalServerError)
    return exc_cls(
        text=json.dumps({"detail": msg}, ensure_ascii=False),
        content_type="application/json",
    )


def _parse_instant(raw: str | None, name: str) -> datetime | None:
    if raw is None or raw.strip() == "":
        return None
    s = raw.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as exc:
        raise _json_error(400, f"{name} 时间格式无效，需 ISO 8601") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _window_request(
    request: web.Request,
) -> tuple[dict, float, datetime | None, datetime | None]:
    """解析窗宽参数；值班员（reader）只允许默认窗口，试图改窗一律 403。"""
    user = require_user(request)
    q = request.rel_url.query
    start = _parse_instant(q.get("start"), "start")
    end = _parse_instant(q.get("end"), "end")
    hours = DEFAULT_WINDOW_HOURS
    hours_raw = q.get("hours")
    if hours_raw is not None and hours_raw.strip() != "":
        try:
            hours = float(hours_raw)
        except ValueError as exc:
            raise _json_error(400, "hours 必须是数字") from exc
        if not (0 < hours <= MAX_WINDOW_HOURS):
            raise _json_error(400, f"hours 需在 (0, {MAX_WINDOW_HOURS}] 之间")
    if user["role"] != "writer":
        if start is not None or end is not None or abs(hours - DEFAULT_WINDOW_HOURS) > 1e-9:
            raise _json_error(403, "值班员仅可查看默认窗口，不可调整窗宽")
    return user, hours, start, end


async def _resolve_window(
    pool: asyncpg.Pool,
    hours: float,
    start: datetime | None,
    end: datetime | None,
) -> tuple[datetime, datetime]:
    """在数据库侧落定窗口端点（缺省截止为数据库当前时刻），避免应用时钟偏差。"""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                COALESCE($3::timestamptz, now()) AS end_ts,
                COALESCE(
                    $2::timestamptz,
                    COALESCE($3::timestamptz, now()) - ($1::float8 * INTERVAL '1 hour')
                ) AS start_ts
            """,
            hours,
            start,
            end,
        )
    start_ts = row["start_ts"]
    end_ts = row["end_ts"]
    if start_ts >= end_ts:
        raise _json_error(400, "窗口起点必须早于截止时刻")
    return start_ts, end_ts


def _ratio(part: int, total: int) -> float:
    return round(part / total, 4) if total else 0.0


async def summary(request: web.Request) -> web.Response:
    """合格率对照台汇总：服务端按窗口聚合各厢线合格量/超温量/占比。"""
    _user, hours, start, end = _window_request(request)
    pool: asyncpg.Pool = request.app["pool"]
    start_ts, end_ts = await _resolve_window(pool, hours, start, end)
    rows = await pool.fetch(
        f"""
        SELECT {LINE_EXPR} AS line,
               COUNT(*) FILTER (WHERE verdict = '合格') AS pass_count,
               COUNT(*) FILTER (WHERE verdict = '超温') AS over_count
        FROM probe_readings
        WHERE {WINDOW_WHERE}
        GROUP BY 1
        ORDER BY 1
        """,
        start_ts,
        end_ts,
    )
    lines = []
    tot_pass = 0
    tot_over = 0
    for r in rows:
        p = int(r["pass_count"])
        o = int(r["over_count"])
        tot_pass += p
        tot_over += o
        lines.append(
            {
                "line": r["line"],
                "pass_count": p,
                "over_count": o,
                "total": p + o,
                "pass_ratio": _ratio(p, p + o),
                "over_ratio": _ratio(o, p + o),
            }
        )
    tot = tot_pass + tot_over
    return web.json_response(
        {
            "hours": hours,
            "window": {"start": start_ts.isoformat(), "end": end_ts.isoformat()},
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "lines": lines,
            "totals": {
                "pass_count": tot_pass,
                "over_count": tot_over,
                "total": tot,
                "pass_ratio": _ratio(tot_pass, tot),
                "over_ratio": _ratio(tot_over, tot),
            },
        }
    )


async def summary_details(request: web.Request) -> web.Response:
    """按同一窗口口径重查明细行，供对照台点开厢线与汇总对拍。"""
    _user, hours, start, end = _window_request(request)
    line = request.rel_url.query.get("line") or None
    pool: asyncpg.Pool = request.app["pool"]
    start_ts, end_ts = await _resolve_window(pool, hours, start, end)
    sql = f"""
        SELECT id, probe_id, {LINE_EXPR} AS line, temp_c, verdict, reason, status,
               created_by, created_at, processed_at
        FROM probe_readings
        WHERE {WINDOW_WHERE}
    """
    args: list = [start_ts, end_ts]
    if line is not None:
        sql += f" AND {LINE_EXPR} = $3"
        args.append(line)
    sql += " ORDER BY processed_at, id"
    rows = await pool.fetch(sql, *args)
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "probe_id": r["probe_id"],
                "line": r["line"],
                "temp_c": r["temp_c"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
            }
        )
    return web.json_response(
        {
            "hours": hours,
            "window": {"start": start_ts.isoformat(), "end": end_ts.isoformat()},
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "line": line,
            "rows": out,
        }
    )


async def on_startup(app: web.Application) -> None:
    pool = await create_pool()
    app["pool"] = pool
    await ensure_schema_async(pool)
    await seed_if_empty(pool)


async def on_cleanup(app: web.Application) -> None:
    pool: asyncpg.Pool = app.get("pool")
    if pool:
        await pool.close()


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/api/health", health)
    app.router.add_post("/api/auth/login", login)
    app.router.add_get("/api/readings", list_readings)
    app.router.add_post("/api/readings", create_reading)
    app.router.add_get("/api/summary", summary)
    app.router.add_get("/api/summary/details", summary_details)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=8000)
