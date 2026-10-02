import { useCallback, useEffect, useState } from "preact/hooks";

// 窗宽选项（小时）；记录员可切换，值班侧只读
const WINDOW_OPTIONS = [
  { hours: 5 / 60, label: "5 分钟" },
  { hours: 1, label: "1 小时" },
  { hours: 4, label: "4 小时" },
  { hours: 8, label: "8 小时" },
  { hours: 24, label: "24 小时" },
];
const DEFAULT_WINDOW_HOURS = 8;

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function StatsView({ authHeaders, isWriter }) {
  const [windowHours, setWindowHours] = useState(DEFAULT_WINDOW_HOURS);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [openLine, setOpenLine] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState("");

  const loadSummary = useCallback(
    async (hours) => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(
          `/api/stats/pass-rate?window_hours=${encodeURIComponent(hours)}`,
          { headers: authHeaders() }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSummary(null);
          setOpenLine(null);
          setDetail(null);
          setError(data.detail || "加载合格率汇总失败");
          return;
        }
        setSummary(data);
        setOpenLine(null);
        setDetail(null);
      } finally {
        setLoading(false);
      }
    },
    [authHeaders]
  );

  // 调窗后立即向服务端重算；页面不做任何本地加总
  useEffect(() => {
    loadSummary(windowHours);
  }, [windowHours, loadSummary]);

  async function toggleDetail(line) {
    if (openLine === line) {
      setOpenLine(null);
      setDetail(null);
      return;
    }
    setOpenLine(line);
    setDetail(null);
    setDetailErr("");
    if (!summary) return;
    // 明细必须与总览同一截止时刻：把汇总下发的 cutoff 原样带回服务端重查，误差为零
    const params = new URLSearchParams({
      window_hours: String(summary.window_hours),
      cutoff: summary.cutoff,
      line,
    });
    const res = await fetch(`/api/stats/pass-rate/detail?${params.toString()}`, {
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setDetailErr(data.detail || "加载明细失败");
      return;
    }
    setDetail(data);
  }

  return (
    <div class="card">
      <div class="stats-head">
        <h2>厢线合格率对照</h2>
        <div class="seg" title={isWriter ? "选择窗宽" : "值班侧只读，不可调整窗宽"}>
          {WINDOW_OPTIONS.map((o) => (
            <button
              key={o.label}
              type="button"
              class={windowHours === o.hours ? "seg-btn active" : "seg-btn"}
              disabled={!isWriter}
              onClick={() => setWindowHours(o.hours)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {!isWriter && <p class="hint">值班侧只读，窗宽由记录员调整。</p>}
      {error && <p class="err">{error}</p>}
      {summary && (
        <p class="hint">
          窗口：{fmtTime(summary.window_start)} ~ {fmtTime(summary.cutoff)}
          （截止为服务端时刻，窗宽 {summary.window_hours >= 1 ? `${summary.window_hours} 小时` : `${Math.round(summary.window_hours * 60)} 分钟`}）
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>厢线</th>
            <th>合格量</th>
            <th>超温量</th>
            <th>合计</th>
            <th>合格率</th>
            <th>超温占比</th>
            <th>明细</th>
          </tr>
        </thead>
        <tbody>
          {summary &&
            summary.lines.map((l) => (
              <tr key={l.line} class={openLine === l.line ? "line-row open" : "line-row"}>
                <td>{l.line} 线</td>
                <td>{l.pass_count}</td>
                <td>{l.overtemp_count}</td>
                <td>{l.total}</td>
                <td>{fmtPct(l.pass_ratio)}</td>
                <td>{fmtPct(l.overtemp_ratio)}</td>
                <td>
                  <button type="button" class="link" onClick={() => toggleDetail(l.line)}>
                    {openLine === l.line ? "收起" : "明细"}
                  </button>
                </td>
              </tr>
            ))}
          {summary && summary.lines.length === 0 && (
            <tr>
              <td colspan="7">本窗口内暂无已办结读数</td>
            </tr>
          )}
          {summary && summary.lines.length > 0 && (
            <tr class="totals-row">
              <td>全部</td>
              <td>{summary.totals.pass_count}</td>
              <td>{summary.totals.overtemp_count}</td>
              <td>{summary.totals.total}</td>
              <td>{fmtPct(summary.totals.pass_ratio)}</td>
              <td>{fmtPct(summary.totals.overtemp_ratio)}</td>
              <td>—</td>
            </tr>
          )}
        </tbody>
      </table>

      {openLine && (
        <div class="detail-panel">
          <h3>{openLine} 线明细（与总览同一截止时刻）</h3>
          {detailErr && <p class="err">{detailErr}</p>}
          {!detail && !detailErr && <p class="hint">加载中…</p>}
          {detail && (
            <div>
              <p class="hint">
                服务端合计：合格 {detail.totals.pass_count} · 超温 {detail.totals.overtemp_count} ·
                合格率 {fmtPct(detail.totals.pass_ratio)} · 超温占比 {fmtPct(detail.totals.overtemp_ratio)}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>编号</th>
                    <th>探头</th>
                    <th>温度℃</th>
                    <th>结论</th>
                    <th>办结时刻</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.id}</td>
                      <td>{r.probe_id}</td>
                      <td>{r.temp_c}</td>
                      <td>
                        <span class={r.verdict === "合格" ? "tag pass" : "tag fail"}>
                          {r.verdict}
                        </span>
                      </td>
                      <td>{fmtTime(r.processed_at)}</td>
                    </tr>
                  ))}
                  {detail.rows.length === 0 && (
                    <tr>
                      <td colspan="5">本窗口内该厢线暂无已办结读数</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div class="stats-foot">
        <button type="button" onClick={() => loadSummary(windowHours)} disabled={loading}>
          {loading ? "刷新中…" : "刷新"}
        </button>
        <p class="note">
          口径说明：仅统计已办结且办结时刻落在（截止时刻 − 窗宽，截止时刻] 内的读数；
          待处理、处理中的读数不计入。厢线按探头编号字母段归组（如 探头A01 → A 线）。
          合格率 = 合格量 ÷（合格量＋超温量），超温占比 = 超温量 ÷（合格量＋超温量）。
          汇总与明细均由服务端按同一截止时刻计算，页面不做本地加总。
        </p>
      </div>
    </div>
  );
}
