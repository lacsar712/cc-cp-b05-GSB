"""厢线合格率小时窗统计：窗宽/截止时刻解析与占比计算的纯函数部分。

汇总与明细两个接口共用这里的 SQL 片段，保证同一口径、同一截止时刻，
专页数字与按窗重查明细误差为零。
"""

from datetime import datetime, timedelta, timezone

# 厢线归组：取探头编号中的字母段（如 探头A01 -> A），无字母时按完整编号自成一线。
LINE_SQL = "COALESCE(substring(probe_id from '[A-Za-z]+'), probe_id)"

# 入桶条件：已办结且办结时刻落在 (截止-窗宽, 截止]；待处理/处理中不计入。
WINDOW_WHERE_SQL = (
    "status = 'done' AND processed_at IS NOT NULL "
    "AND processed_at > $1 AND processed_at <= $2"
)

DEFAULT_WINDOW_HOURS = 8.0
MAX_WINDOW_HOURS = 24.0 * 30  # 最长 30 天


def parse_window_hours(raw) -> float:
    """解析窗宽（小时），支持小数（如 0.0833 表示 5 分钟）；非法抛 ValueError。"""
    if raw is None or str(raw).strip() == "":
        return DEFAULT_WINDOW_HOURS
    try:
        hours = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("窗宽必须是数字（小时）") from exc
    if not 0 < hours <= MAX_WINDOW_HOURS:
        raise ValueError(f"窗宽需在 0 到 {MAX_WINDOW_HOURS:g} 小时之间")
    return hours


def parse_cutoff(raw) -> datetime:
    """解析截止时刻（ISO 8601）；缺省取当前 UTC 时间。非法抛 ValueError。"""
    if raw is None or str(raw).strip() == "":
        return datetime.now(timezone.utc)
    text = str(raw).strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("截止时刻必须是 ISO 8601 时间") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def window_start(cutoff: datetime, window_hours: float) -> datetime:
    return cutoff - timedelta(hours=window_hours)


def _ratio(part: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round(part / total, 6)


def line_stats(line: str, pass_count: int, overtemp_count: int) -> dict:
    """合格率/超温占比的分母均为 合格量+超温量，全服务唯一口径。"""
    total = pass_count + overtemp_count
    return {
        "line": line,
        "pass_count": pass_count,
        "overtemp_count": overtemp_count,
        "total": total,
        "pass_ratio": _ratio(pass_count, total),
        "overtemp_ratio": _ratio(overtemp_count, total),
    }
