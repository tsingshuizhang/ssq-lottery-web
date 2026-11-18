/* 双色球 Web —— 前端逻辑
 *
 * 数据来源（优先级从高到低）：
 *   1. static/data/*.json —— 预计算静态文件（由 ssq.export_static 生成，
 *      GitHub Actions 每期开奖后自动更新并提交到 git），GitHub Pages 上同样可用；
 *   2. /api/* —— 本地 python3 ssq_web.py 启动时的后端接口（兜底）。
 *
 * 号码推荐在浏览器端用 weights.json 中的基础得分完成，
 * 与后端 score_weights 模型一致（随机项在每次生成时加入）。
 */

const $ = (id) => document.getElementById(id);

/** 是否部署在 GitHub Pages（静态托管，无后端，数据由 Actions 更新） */
const IS_PAGES = location.hostname.endsWith("github.io");

/** 两位数字格式化 */
const pad = (n) => String(n).padStart(2, "0");

if (IS_PAGES) {
  const btn = $("btnUpdate");
  btn.style.display = "none";
  const note = document.createElement("span");
  note.className = "status";
  note.textContent = "数据由 GitHub Actions 在开奖日自动更新";
  btn.parentNode.appendChild(note);
}

/** 按频率生成红/蓝球热力背景（inline CSS 变量） */
function heatStyle(freq, max, isRed) {
  const t = max > 0 ? freq / max : 0;
  let c1, c2;
  if (isRed) {
    c1 = t > 0.6 ? "#ff8a7a" : t > 0.3 ? "#ffc0b8" : "#ffe3df";
    c2 = t > 0.6 ? "#e60012" : t > 0.3 ? "#f0524a" : "#ff9d94";
  } else {
    c1 = t > 0.6 ? "#7aa5ff" : t > 0.3 ? "#b3ccff" : "#dfeaff";
    c2 = t > 0.6 ? "#1e50a2" : t > 0.3 ? "#4a79c4" : "#8fb0e8";
  }
  const text = t > 0.3 ? "#fff" : "#555";
  return `--c1:${c1};--c2:${c2};color:${text}`;
}

/** 渲染单个号码球 */
function ballEl(num, cls = "", style = "") {
  const el = document.createElement("span");
  el.className = `ball ${cls}`;
  el.textContent = pad(num);
  if (style) el.style.cssText = style;
  return el;
}

/** 获取统计数据的静态文件优先，后端接口兜底 */
async function fetchStats(win) {
  try {
    const r = await fetch(`data/stats_${win}.json`);
    if (r.ok) return await r.json();
  } catch (e) { /* 静态文件不存在时走后端 */ }
  const r = await fetch(`/api/stats?window=${win}`);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/** 加载并渲染统计数据（切换窗口时只读取对应的静态 JSON 文件） */
async function loadStats() {
  const windowSize = $("window").value;
  $("status").textContent = "统计数据加载中…";
  try {
    const s = await fetchStats(windowSize);

    $("dataRange").textContent =
      `共 ${s.total} 期历史数据（${s.range[0]} ~ ${s.range[1]}），开奖结果来自中国福彩官网`;
    $("windowLabel").textContent = `（第 ${s.window_range[0]} ~ ${s.window_range[1]} 期）`;

    renderTags($("hotRed"), s.hot_red, "hot");
    renderTags($("coldRed"), s.cold_red, "cold");
    renderTags($("hotBlue"), s.hot_blue, "hot");
    renderTags($("coldBlue"), s.cold_blue, "cold");

    $("omitRed").innerHTML = s.omit_red
      .map(([n, v]) => `<span class="tag hot">${pad(n)} 遗漏${v}</span>`).join("");
    $("omitBlue").innerHTML = s.omit_blue
      .map(([n, v]) => `<span class="tag cold">${pad(n)} 遗漏${v}</span>`).join("");

    renderOddEven(s.odd_even);
    renderHeat(s);
    renderRecent(s.recent);

    $("status").textContent = "";
    loadDataInfo();
  } catch (err) {
    $("status").innerHTML = "统计数据加载失败：" + err.message +
      "<br>💡 本地运行请使用 <code>python3 ssq_web.py</code> 并访问 " +
      "<code>http://127.0.0.1:8000</code>，不要直接双击打开 html 文件。";
  }
}

/** 读取数据生成时间并附加到数据概况后（info.json 不可用时静默忽略） */
async function loadDataInfo() {
  try {
    const r = await fetch("data/info.json");
    if (!r.ok) return;
    const info = await r.json();
    if (info.generated_at) {
      $("dataRange").textContent += `，数据更新于 ${info.generated_at.replace("T", " ")}`;
    }
  } catch (e) { /* 忽略 */ }
}

function renderTags(container, pairs, cls) {
  container.innerHTML = "";
  pairs.forEach(([n, c]) => {
    const tag = document.createElement("span");
    tag.className = `tag ${cls}`;
    tag.textContent = `${pad(n)} × ${c}`;
    container.appendChild(tag);
  });
}

function renderOddEven(oe) {
  const total = oe.odd + oe.even + oe.balanced || 1;
  const pct = (v) => ((v / total) * 100).toFixed(1) + "%";
  $("oddEvenBar").innerHTML =
    `<span class="b-odd" style="width:${pct(oe.odd)}">奇多 ${oe.odd}</span>` +
    `<span class="b-balance" style="width:${pct(oe.balanced)}">均衡 ${oe.balanced}</span>` +
    `<span class="b-even" style="width:${pct(oe.even)}">偶多 ${oe.even}</span>`;
  $("oddEvenLegend").textContent = "统计期内红球奇偶形态占比";
}

function renderHeat(s) {
  const redMax = Math.max(...Object.values(s.red_freq), 1);
  const blueMax = Math.max(...Object.values(s.blue_freq), 1);

  const redGrid = $("redGrid");
  redGrid.innerHTML = "";
  for (let n = 1; n <= 33; n++) {
    const f = s.red_freq[n] || 0;
    const el = ballEl(n, "heat-red", heatStyle(f, redMax, true));
    el.title = `出现 ${f} 次，当前遗漏 ${s.red_omit[n]} 期`;
    redGrid.appendChild(el);
  }

  const blueGrid = $("blueGrid");
  blueGrid.innerHTML = "";
  for (let n = 1; n <= 16; n++) {
    const f = s.blue_freq[n] || 0;
    const el = ballEl(n, "heat-blue", heatStyle(f, blueMax, false));
    el.title = `出现 ${f} 次，当前遗漏 ${s.blue_omit[n]} 期`;
    blueGrid.appendChild(el);
  }
}

function renderRecent(recent) {
  const tbody = $("recentBody");
  tbody.innerHTML = "";
  [...recent].reverse().forEach((d) => {
    const tr = document.createElement("tr");
    const reds = d.red.map((n) => `<span class="ball small red">${pad(n)}</span>`).join("");
    tr.innerHTML =
      `<td>${d.issue}</td><td>${d.date}</td>` +
      `<td>${reds}</td><td><span class="ball small blue">${pad(d.blue)}</span></td>`;
    tbody.appendChild(tr);
  });
}

/* ---------------- 号码推荐（客户端实现，与后端模型一致） ---------------- */

let weightsCache = null;

/** 读取推荐基础得分（静态文件优先，后端兜底由 genPicks 处理） */
async function getWeights() {
  if (weightsCache) return weightsCache;
  try {
    const r = await fetch("data/weights.json");
    if (r.ok) {
      weightsCache = await r.json();
      return weightsCache;
    }
  } catch (e) { /* 忽略，走后端接口 */ }
  return null;
}

/** 在基础得分上加入随机扰动（对应后端 score_weights 的随机项，每次生成时重新扰动） */
function jitterPool(entries) {
  return entries.map(([n, w]) => [n, w + 0.2 * Math.random()]);
}

/** 按权重不放回抽取 k 个号码（轮盘赌算法） */
function weightedPick(pool, k) {
  const p = pool.slice();
  const out = [];
  for (let i = 0; i < k; i++) {
    const total = p.reduce((s, e) => s + e[1], 0);
    let r = Math.random() * total;
    let acc = 0;
    let hit = -1;
    for (let j = 0; j < p.length; j++) {
      acc += p[j][1];
      if (r <= acc) {
        hit = j;
        break;
      }
    }
    if (hit < 0) hit = p.length - 1;   // 浮点边界兜底
    out.push(p[hit][0]);
    p.splice(hit, 1);
  }
  return out.sort((a, b) => a - b);
}

/** 结构过滤：与历史形态保持大体一致（移植自后端 structurally_sane） */
function structurallySane(reds) {
  const odd = reds.filter((n) => n % 2).length;
  if (odd === 0 || odd === 6) return false;              // 全奇/全偶
  const sum = reds.reduce((s, n) => s + n, 0);
  if (sum < 60 || sum > 130) return false;               // 和值极端
  let consecutive = 0;
  for (let i = 1; i < reds.length; i++) {
    if (reds[i] - reds[i - 1] === 1) consecutive++;
  }
  return consecutive < 3;                                 // 3 组以上连号
}

let lastPicks = [];

function renderPicks(picks) {
  lastPicks = picks;
  const box = $("picks");
  box.innerHTML = "";
  picks.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "pick";
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = pad(i + 1);
    row.appendChild(idx);
    p.reds.forEach((n) => row.appendChild(ballEl(n, "red")));
    const plus = document.createElement("span");
    plus.className = "plus";
    plus.textContent = "+";
    row.appendChild(plus);
    row.appendChild(ballEl(p.blue, "blue"));
    box.appendChild(row);
  });
  $("recSection").hidden = false;
  $("recSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** 生成推荐号码：优先客户端用静态权重计算，失败时回退后端接口 */
async function genPicks() {
  const btn = $("btnRecommend");
  btn.disabled = true;
  $("status").textContent = "正在计算推荐号码…";
  try {
    const w = await getWeights();
    if (w) {
      const seen = new Set();
      const picks = [];
      let attempts = 0;
      while (picks.length < 10 && attempts < 5000) {
        attempts++;
        // 每组抽取前重新加入随机扰动，保证组间多样性（与后端 recommend 一致）
        const redPool = jitterPool(w.red);
        const reds = weightedPick(redPool, 6);
        const key = reds.join(",");
        if (seen.has(key) || !structurallySane(reds)) continue;
        seen.add(key);
        picks.push({ reds, blue: weightedPick(jitterPool(w.blue), 1)[0] });
      }
      renderPicks(picks);
      $("status").textContent = "";
    } else {
      const res = await fetch("/api/recommend?n=10");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      renderPicks(data.picks);
      $("status").textContent = "";
    }
  } catch (err) {
    $("status").textContent = "推荐生成失败：" + err.message +
      "（请先确认服务已启动：python3 ssq_web.py）";
  } finally {
    btn.disabled = false;
  }
}

/** 联网更新数据（仅本地后端模式可用；Pages 由 GitHub Actions 自动更新） */
async function updateData() {
  const btn = $("btnUpdate");
  btn.disabled = true;
  $("status").textContent = "正在从福彩官网更新数据，请稍候…";
  try {
    const res = await fetch("/api/update", { method: "POST" });
    const data = await res.json();
    $("status").textContent = data.message;
    if (data.ok) {
      weightsCache = null;   // 权重更新后清除缓存
      await loadStats();
    }
  } catch (err) {
    $("status").textContent = "更新失败：" + err.message;
  } finally {
    btn.disabled = false;
  }
}

/** 一键复制全部推荐号码（剪贴板 API 不可用时降级为 execCommand） */
async function copyPicks() {
  if (!lastPicks.length) return;
  const lines = lastPicks.map((p, i) =>
    `${pad(i + 1)}. 红球 ${p.reds.map(pad).join(" ")} + 蓝球 ${pad(p.blue)}`);
  const text = "双色球推荐号码（仅供娱乐参考，不构成投注建议）\n" + lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  $("status").textContent = "✅ 已复制 10 组号码到剪贴板";
}

/* ---------------- 历史回测（模型 vs 纯随机基线） ---------------- */

/** 读取回测结果（静态文件优先，本地后端兜底） */
async function fetchBacktest() {
  try {
    const r = await fetch("data/backtest.json");
    if (r.ok) return await r.json();
  } catch (e) { /* 静态文件不存在时走后端 */ }
  const r = await fetch("/api/backtest?window=20");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/** 渲染一注号码，命中实际开奖的号码高亮 */
function pickHtml(pick, actualReds, actualBlue) {
  const reds = pick.reds.map((n) => {
    const hit = actualReds.includes(Number(n)) ? " hit" : "";
    return `<span class="ball small red${hit}">${pad(n)}</span>`;
  }).join("");
  const blueHit = Number(pick.blue) === Number(actualBlue) ? " hit" : "";
  return `${reds}<span class="ball small blue${blueHit}">${pad(pick.blue)}</span>`;
}

async function loadBacktest() {
  try {
    const bt = await fetchBacktest();
    const ms = bt.summary.model, rs = bt.summary.random;
    $("btLabel").textContent =
      `（第 ${bt.range[0]} ~ ${bt.range[1]} 期，每期 ${bt.count} 组，模型 vs 随机基线）`;
    $("btAvg").innerHTML = `模型 <b>${ms.avg_red_hits}</b> 个<small> vs 随机 ${rs.avg_red_hits} 个</small>`;
    $("btMax").innerHTML = `模型 <b>${ms.max_red_hits}</b> 个<small> vs 随机 ${rs.max_red_hits} 个</small>`;
    $("btBlue").innerHTML = `模型 <b>${Math.round(ms.blue_any_rate * 100)}%</b><small> vs 随机 ${Math.round(rs.blue_any_rate * 100)}%</small>`;

    const tbody = $("btBody");
    tbody.innerHTML = "";
    [...bt.draws].reverse().forEach((r) => {
      const tr = document.createElement("tr");
      const actual = r.actual.red.map((n) => `<span class="ball small red">${pad(n)}</span>`).join("") +
        `<span class="ball small blue">${pad(r.actual.blue)}</span>`;
      const m = r.model;
      const hit = `${m.red_hits}红` + (m.blue_hit ? "+蓝" : "");
      tr.innerHTML = `<td>${r.issue}</td><td>${actual}</td>` +
        `<td>${pickHtml(m, r.actual.red, r.actual.blue)}</td>` +
        `<td><span class="tag ${m.red_hits >= 3 ? "hot" : "cold"}">${hit}</span></td>`;
      tbody.appendChild(tr);
    });
  } catch (e) { /* 回测数据不可用时静默（不影响主功能） */ }
}

$("btnRecommend").addEventListener("click", genPicks);
$("btnCopy").addEventListener("click", copyPicks);
$("btnUpdate").addEventListener("click", updateData);
$("window").addEventListener("change", loadStats);

loadStats();
loadBacktest();
