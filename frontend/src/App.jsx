import { Fragment } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

const TOKEN_KEY = "coldchain_token";
const USER_KEY = "coldchain_user";
const HOUR_OPTIONS = [1, 2, 4, 8, 24];

function verdictClass(v, status) {
  if (v === "合格") return "tag pass";
  if (v === "超温") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function fmtTs(s) {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

function pct(r) {
  return `${((r || 0) * 100).toFixed(1)}%`;
}

function PassBoard({ user, authHeaders }) {
  const isWriter = user?.role === "writer";
  const [hours, setHours] = useState(1);
  const [endInput, setEndInput] = useState(""); // datetime-local，空 = 截止此刻
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpandedState] = useState(null);
  const [detail, setDetail] = useState({ line: null, rows: null });
  const [detailErr, setDetailErr] = useState("");
  const expandedRef = useRef(null);

  function setExpanded(line) {
    expandedRef.current = line;
    setExpandedState(line);
  }

  const fetchDetail = useCallback(
    async (line, win) => {
      setDetailErr("");
      try {
        // 记录员：带上汇总返回的同一窗口端点重查，保证与汇总零误差；
        // 值班员：服务端只允许默认窗口，按默认窗宽查询。
        const p = isWriter
          ? new URLSearchParams({ line, start: win.start, end: win.end })
          : new URLSearchParams({ line, hours: String(hours) });
        const res = await fetch(`/api/summary/details?${p}`, {
          headers: authHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setDetailErr(data.detail || "明细加载失败");
          return;
        }
        setDetail({ line, rows: data.rows || [] });
      } catch {
        setDetailErr("明细加载失败");
      }
    },
    [isWriter, hours, authHeaders]
  );

  const fetchSummary = useCallback(async () => {
    setErr("");
    setRefreshing(true);
    try {
      const p = new URLSearchParams();
      if (isWriter) {
        p.set("hours", String(hours));
        if (endInput) {
          const d = new Date(endInput);
          if (!Number.isNaN(d.getTime())) p.set("end", d.toISOString());
        }
      }
      const res = await fetch(`/api/summary?${p}`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.detail || "汇总加载失败");
        return null;
      }
      setSummary(data);
      return data;
    } catch {
      setErr("汇总加载失败");
      return null;
    } finally {
      setRefreshing(false);
    }
  }, [isWriter, hours, endInput, authHeaders]);

  // 进入页面与调窗后立即重算，之后每 3 秒自动刷新；数字全部来自服务端
  useEffect(() => {
    let alive = true;
    async function tick() {
      const data = await fetchSummary();
      if (alive && data && expandedRef.current) {
        fetchDetail(expandedRef.current, data.window);
      }
    }
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fetchSummary, fetchDetail]);

  function toggleLine(line) {
    if (expanded === line) {
      setExpanded(null);
      setDetail({ line: null, rows: null });
      return;
    }
    setExpanded(line);
    setDetail({ line, rows: null });
    if (summary) fetchDetail(line, summary.window);
  }

  return (
    <div class="card">
      <div class="board-head">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>合格率对照</h2>
        {isWriter ? (
          <div class="win-controls">
            <span class="ctl-label">窗宽</span>
            {HOUR_OPTIONS.map((h) => (
              <button
                key={h}
                type="button"
                class={h === hours ? "seg active" : "seg"}
                onClick={() => setHours(h)}
              >
                {h}小时
              </button>
            ))}
            <label class="ctl-label">
              截止时刻
              <input
                type="datetime-local"
                value={endInput}
                onInput={(e) => setEndInput(e.target.value)}
              />
            </label>
            {endInput && (
              <button type="button" class="seg" onClick={() => setEndInput("")}>
                回到此刻
              </button>
            )}
          </div>
        ) : (
          <p class="sub" style={{ margin: 0 }}>
            窗宽 1 小时 · 截止当前时刻（值班侧只读，不可调窗）
          </p>
        )}
      </div>

      {err && <p class="err">{err}</p>}

      {summary && (
        <Fragment>
          <p class="sub winline">
            窗口 {fmtTs(summary.window.start)} ~ {fmtTs(summary.window.end)}
            （服务端生成于 {fmtTs(summary.generated_at)}）
          </p>
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
              {summary.lines.map((l) => (
                <Fragment key={l.line}>
                  <tr class="line-row" onClick={() => toggleLine(l.line)}>
                    <td>厢线{l.line}</td>
                    <td>{l.pass_count}</td>
                    <td>{l.over_count}</td>
                    <td>{l.total}</td>
                    <td>{pct(l.pass_ratio)}</td>
                    <td class={l.over_count > 0 ? "over-hot" : ""}>
                      {pct(l.over_ratio)}
                    </td>
                    <td>
                      <button type="button" class="seg">
                        {expanded === l.line ? "收起" : "明细"}
                      </button>
                    </td>
                  </tr>
                  {expanded === l.line && (
                    <tr class="detail-row">
                      <td colspan="7">
                        {detailErr && <p class="err">{detailErr}</p>}
                        {detail.rows === null || detail.line !== l.line ? (
                          <p class="sub" style={{ margin: "0.25rem 0" }}>
                            明细加载中…
                          </p>
                        ) : (
                          <table class="detail-table">
                            <thead>
                              <tr>
                                <th>编号</th>
                                <th>探头</th>
                                <th>温度℃</th>
                                <th>结论</th>
                                <th>办结时刻</th>
                                <th>提交人</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.rows.map((r) => (
                                <tr key={r.id}>
                                  <td>{r.id}</td>
                                  <td>{r.probe_id}</td>
                                  <td>{r.temp_c}</td>
                                  <td>
                                    <span
                                      class={verdictClass(r.verdict, r.status)}
                                    >
                                      {displayVerdict(r)}
                                    </span>
                                  </td>
                                  <td>{fmtTs(r.processed_at)}</td>
                                  <td>{r.created_by}</td>
                                </tr>
                              ))}
                              {detail.rows.length === 0 && (
                                <tr>
                                  <td colspan="6">本窗内该厢线暂无已办结行</td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {summary.lines.length === 0 && (
                <tr>
                  <td colspan="7">本窗口内暂无已办结读数</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr class="total-row">
                <td>合计</td>
                <td>{summary.totals.pass_count}</td>
                <td>{summary.totals.over_count}</td>
                <td>{summary.totals.total}</td>
                <td>{pct(summary.totals.pass_ratio)}</td>
                <td>{pct(summary.totals.over_ratio)}</td>
                <td>—</td>
              </tr>
            </tfoot>
          </table>
        </Fragment>
      )}

      <div class="board-foot">
        <button type="button" onClick={fetchSummary} disabled={refreshing}>
          {refreshing ? "刷新中…" : "刷新"}
        </button>
        <p class="sub caliber">
          口径：仅统计已办结行（待处理/处理中不计入），按办结时刻落入窗口
          [起点, 截止] 计；厢线取探头编号中首段英文字母（无字母取完整编号）；合格
          = 温度 ≤ 8℃，超温 = ＞8℃；占比 = 对应数量 ÷
          该线合计。汇总与明细均由服务端按同一口径实时查询，页面不做本地加总。
        </p>
      </div>
    </div>
  );
}

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  });
  const [view, setView] = useState("readings");
  const [loginForm, setLoginForm] = useState({ username: "logger", password: "log123456" });
  const [submitForm, setSubmitForm] = useState({ probe_id: "", temp_c: "" });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const authHeaders = useCallback(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadReadings = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/readings", { headers: authHeaders() });
    if (!res.ok) {
      setError("加载列表失败，请重新登录");
      return;
    }
    setRows(await res.json());
  }, [token, authHeaders]);

  useEffect(() => {
    if (!token || view !== "readings") return undefined;
    loadReadings();
    const t = setInterval(loadReadings, 3000);
    return () => clearInterval(t);
  }, [loadReadings, token, view]);

  async function onLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      if (!res.ok) {
        setError("用户名或密码错误");
        return;
      }
      const data = await res.json();
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(
        USER_KEY,
        JSON.stringify({ username: data.username, role: data.role })
      );
      setToken(data.access_token);
      setUser({ username: data.username, role: data.role });
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    setRows([]);
    setView("readings");
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setMsg("");
    setLoading(true);
    try {
      const res = await fetch("/api/readings", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          probe_id: submitForm.probe_id,
          temp_c: parseFloat(submitForm.temp_c),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "提交失败");
        return;
      }
      setMsg(data.message || "已提交");
      setSubmitForm({ probe_id: "", temp_c: "" });
      await loadReadings();
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div class="wrap">
        <h1>冷链探头超温台</h1>
        <p class="sub">记录员提交探头编号与摄氏温度，后台工人认领后判定合格或超温。</p>
        <div class="card">
          <form onSubmit={onLogin}>
            <div class="row">
              <label>
                用户名
                <input
                  value={loginForm.username}
                  onInput={(e) =>
                    setLoginForm({ ...loginForm, username: e.target.value })
                  }
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={loginForm.password}
                  onInput={(e) =>
                    setLoginForm({ ...loginForm, password: e.target.value })
                  }
                />
              </label>
              <button type="submit" disabled={loading}>
                登录
              </button>
            </div>
            {error && <p class="err">{error}</p>}
          </form>
          <p class="sub" style={{ marginBottom: 0 }}>
            记录员 logger / log123456 · 值班员 watcher / watch123456
          </p>
        </div>
      </div>
    );
  }

  const isWriter = user?.role === "writer";

  return (
    <div class="wrap">
      <div class="topbar">
        <div>
          <h1>冷链探头超温台</h1>
          <p class="sub">温度不超过 8℃ 为合格，否则为超温。</p>
        </div>
        <div class="user">
          {user?.username}（{isWriter ? "记录员" : "值班员"}）
          <button
            type="button"
            style={{ marginLeft: "0.5rem" }}
            onClick={() => setView(view === "board" ? "readings" : "board")}
          >
            {view === "board" ? "返回读数列表" : "合格率对照"}
          </button>
          <button type="button" class="secondary" style={{ marginLeft: "0.5rem" }} onClick={logout}>
            退出
          </button>
        </div>
      </div>

      {view === "board" ? (
        <PassBoard user={user} authHeaders={authHeaders} />
      ) : (
        <Fragment>
          {isWriter && (
            <div class="card">
              <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>提交读数</h2>
              <form onSubmit={onSubmit}>
                <div class="row">
                  <label>
                    探头编号
                    <input
                      required
                      value={submitForm.probe_id}
                      onInput={(e) =>
                        setSubmitForm({ ...submitForm, probe_id: e.target.value })
                      }
                      placeholder="例如 探头C03"
                    />
                  </label>
                  <label>
                    温度（℃）
                    <input
                      required
                      type="number"
                      step="0.1"
                      value={submitForm.temp_c}
                      onInput={(e) =>
                        setSubmitForm({ ...submitForm, temp_c: e.target.value })
                      }
                    />
                  </label>
                  <button type="submit" disabled={loading}>
                    提交
                  </button>
                </div>
                {error && <p class="err">{error}</p>}
                {msg && <p class="ok">{msg}</p>}
              </form>
            </div>
          )}

          <div class="card">
            <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>读数列表</h2>
            <table>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>探头</th>
                  <th>温度℃</th>
                  <th>结论</th>
                  <th>说明</th>
                  <th>状态</th>
                  <th>提交人</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.probe_id}</td>
                    <td>{r.temp_c}</td>
                    <td>
                      <span class={verdictClass(r.verdict, r.status)}>
                        {displayVerdict(r)}
                      </span>
                    </td>
                    <td>{r.reason || "—"}</td>
                    <td>{r.status}</td>
                    <td>{r.created_by}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colspan="7">暂无数据</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Fragment>
      )}
    </div>
  );
}
