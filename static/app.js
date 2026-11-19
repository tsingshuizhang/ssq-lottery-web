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
async function fetchBacktest(win) {
  try {
    const r = await fetch(`data/backtest_${win}.json`);
    if (r.ok) return await r.json();
  } catch (e) { /* 静态文件不存在时走后端 */ }
  const r = await fetch(`/api/backtest?window=${win}`);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/** 渲染回测单元格：均值 ± 波动 · 蓝球命中率 */
function btCell(s) {
  return `${s.avg_red_hits}红 <small>±${s.std_red_hits} · 蓝 ${Math.round(s.blue_any_rate * 100)}%</small>`;
}

async function loadBacktest() {
  const win = $("btWindow").value;
  try {
    const bt = await fetchBacktest(win);
    const ms = bt.summary.model, rs = bt.summary.random;
    $("btLabel").textContent =
      `（第 ${bt.range[0]} ~ ${bt.range[1]} 期，每期 ${bt.trials} 次抽样 × ${bt.count} 组取平均）`;
    $("btAvg").innerHTML = `模型 <b>${ms.avg_red_hits}</b> 个<small> vs 随机 ${rs.avg_red_hits} 个（±${ms.std_red_hits} / ±${rs.std_red_hits}）</small>`;
    $("btMax").innerHTML = `模型 <b>${ms.max_red_hits}</b> 个<small> vs 随机 ${rs.max_red_hits} 个</small>`;
    $("btBlue").innerHTML = `模型 <b>${Math.round(ms.blue_any_rate * 100)}%</b><small> vs 随机 ${Math.round(rs.blue_any_rate * 100)}%</small>`;

    const tbody = $("btBody");
    tbody.innerHTML = "";
    [...bt.draws].reverse().forEach((r) => {
      const tr = document.createElement("tr");
      const actual = r.actual.red.map((n) => `<span class="ball small red">${pad(n)}</span>`).join("") +
        `<span class="ball small blue">${pad(r.actual.blue)}</span>`;
      tr.innerHTML = `<td>${r.issue}</td><td>${actual}</td>` +
        `<td>${btCell(r.model)}</td><td>${btCell(r.random)}</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) { /* 回测数据不可用时静默（不影响主功能） */ }
}

/* ---------------- 中奖查询 ---------------- */

/** 双色球奖级表（与后端 ssq.PRIZE_TABLE 一致）："红命中数-蓝是否命中" → [奖项, 奖金说明] */
const PRIZE_TABLE = {
  "6-1": ["一等奖", "浮动奖金（封顶 1000 万元）"],
  "6-0": ["二等奖", "浮动奖金"],
  "5-1": ["三等奖", "3000 元"],
  "5-0": ["四等奖", "200 元"],
  "4-1": ["四等奖", "200 元"],
  "4-0": ["五等奖", "10 元"],
  "3-1": ["五等奖", "10 元"],
  "2-1": ["六等奖", "5 元"],
  "1-1": ["六等奖", "5 元"],
  "0-1": ["六等奖", "5 元"],
};

let drawsCache = null;

/** 读取全量开奖数据（静态文件优先；本地后端兜底时返回 null，走 /api/check） */
async function getDraws() {
  if (drawsCache) return drawsCache;
  try {
    const r = await fetch("data/draws.json");
    if (r.ok) {
      drawsCache = await r.json();
      return drawsCache;
    }
  } catch (e) { /* 走后端 */ }
  return null;
}

/** 解析一行投注：提取数字，前 6 个为红球、第 7 个为蓝球 */
function parseBetLine(line) {
  const nums = extractNums(line);   // 词边界匹配，粘贴内容含期号也不会污染
  if (nums.length < 7) return null;
  const reds = nums.slice(0, 6), blue = nums[6];
  if (new Set(reds).size !== 6 || !reds.every((n) => n >= 1 && n <= 33) || blue < 1 || blue > 16) {
    return null;
  }
  return { reds, blue };
}

/** 计算一注彩票的奖项（与后端 check_prize 一致） */
function checkPrizeJs(reds, blue, draw) {
  const hitReds = reds.filter((n) => draw.red.includes(n)).sort((a, b) => a - b);
  const blueHit = blue === draw.blue;
  const [prize, amount] = PRIZE_TABLE[`${hitReds.length}-${blueHit ? 1 : 0}`] || [null, null];
  return { redHits: hitReds.length, hitReds, blueHit, prize, amount };
}

function renderCheckResult(draw, items) {
  const box = $("ckResult");
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ck-draw";
  head.innerHTML = `<b>${draw.issue}</b> 期开奖号码：` +
    draw.red.map((n) => `<span class="ball small red">${pad(n)}</span>`).join("") +
    `<span class="plus">+</span><span class="ball small blue">${pad(draw.blue)}</span>`;
  box.appendChild(head);
  items.forEach(({ bet, res }) => {
    const row = document.createElement("div");
    row.className = "ck-bet";
    const nums = bet.reds.map((n) =>
      `<span class="ball small red${res.hitReds.includes(n) ? " hit" : ""}">${pad(n)}</span>`
    ).join("") +
      `<span class="plus">+</span>` +
      `<span class="ball small blue${res.blueHit ? " hit" : ""}">${pad(bet.blue)}</span>`;
    const badge = res.prize
      ? `<span class="prize win">🎉 ${res.prize} · ${res.amount}</span>`
      : `<span class="prize none">未中奖</span>`;
    row.innerHTML = `<div class="ck-bet-nums">${nums}</div>${badge}`;
    box.appendChild(row);
  });
}

async function checkTickets() {
  const issue = $("ckIssue").value.trim();
  const lines = $("ckBets").value.split("\n").map((l) => l.trim()).filter(Boolean);
  $("ckResult").innerHTML = "";
  if (!issue) { $("ckStatus").textContent = "请先填写期号"; return; }
  if (!lines.length) { $("ckStatus").textContent = "请输入至少一注彩票号码"; return; }
  const bets = lines.map(parseBetLine);
  if (bets.some((b) => !b)) {
    $("ckStatus").textContent = "有号码行格式不正确：每行需 6 个红球（1-33 不重复）+ 1 个蓝球（1-16）";
    return;
  }
  $("ckStatus").textContent = "";
  const draws = await getDraws();
  if (draws) {
    const draw = draws.find((d) => d.issue === issue);
    if (!draw) {
      $("ckStatus").textContent =
        `未找到 ${issue} 期开奖数据（当前 ${draws[0].issue} ~ ${draws[draws.length - 1].issue}）`;
      return;
    }
    renderCheckResult(draw, bets.map((bet) => ({ bet, res: checkPrizeJs(bet.reds, bet.blue, draw) })));
    return;
  }
  // 本地后端兜底（无静态文件时逐注调用 /api/check）
  try {
    const out = [];
    for (const bet of bets) {
      const r = await fetch(`/api/check?issue=${issue}&red=${bet.reds.join(",")}&blue=${bet.blue}`);
      const data = await r.json();
      if (!data.ok) throw new Error(data.error);
      out.push({ bet, res: data.result, draw: data.draw });
    }
    renderCheckResult(out[0].draw, out);
  } catch (e) {
    $("ckStatus").textContent = e.message;
  }
}

/* ---------------- 拍照识别（浏览器端 OCR，按需加载 Tesseract.js） ---------------- */

let tesseractLoading = null;

const TESSERACT_CDNS = [
  "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
  "https://unpkg.com/tesseract.js@5/dist/tesseract.min.js",
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/** 按需加载 Tesseract.js（多 CDN 兜底），仅在用户点击拍照时下载 */
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractLoading) return tesseractLoading;
  tesseractLoading = (async () => {
    for (const src of TESSERACT_CDNS) {
      try {
        await loadScript(src);
        return;
      } catch (e) { /* 尝试下一个 CDN */ }
    }
    tesseractLoading = null;
    throw new Error("识别引擎加载失败（网络问题），请重试或手动输入");
  })();
  return tesseractLoading;
}

/** 图片预处理：放大 + 灰度 + 二值化，显著提升票面数字识别率 */
function preprocessImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(3, Math.max(1, 2000 / img.width));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = im.data;
      const gray = new Uint8Array(canvas.width * canvas.height);
      let sum = 0;
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        gray[j] = g;
        sum += g;
      }
      const thr = (sum / gray.length) * 0.85;  // 票面偏亮，阈值略低于均值
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        const v = gray[j] > thr ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(im, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error("图片读取失败"));
    img.src = url;
  });
}

/** OCR 常见误读修正：O→0、l/I/|→1、Z→2、S→5、B→8、G→6 */
function cleanOcrLine(line) {
  return line
    .replace(/[OoQq]/g, "0").replace(/[lI|!]/g, "1").replace(/[Zz]/g, "2")
    .replace(/[Ss]/g, "5").replace(/[Bb]/g, "8").replace(/[Gg]/g, "6")
    .replace(/[，。、；;·]/g, " ");
}

/** 从一行文本提取数字序列（先剥离日期，再词边界匹配，期号/日期不会污染） */
function extractNums(line) {
  const cleaned = cleanOcrLine(line)
    .replace(/20\d{2}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/g, " ");
  return (cleaned.match(/\b\d{1,2}\b/g) || []).map(Number);
}

/** 在数字序列中滑动提取合法投注（6 红 + 1 蓝），可识别一行多注 */
function extractBets(nums) {
  const bets = [];
  let i = 0;
  while (i + 7 <= nums.length) {
    const reds = nums.slice(i, i + 6), blue = nums[i + 6];
    if (new Set(reds).size === 6 && reds.every((n) => n >= 1 && n <= 33) && blue >= 1 && blue <= 16) {
      bets.push({ reds, blue });
      i += 7;
    } else {
      i += 1;
    }
  }
  return bets;
}

/** 从 OCR 全文中提取开奖期号与候选投注（去重）。
 *
 * 票面布局规律：投注号码在上方，"开奖期/销售期/上期开奖号码"等页脚信息在下方。
 * 期号取票面上第一个 20XXXXX 形式的 7 位数字；投注只从期号行之前的区域提取，
 * 避免把页脚的"上期开奖号码"误当作用户投注。
 */
function parseOcrText(text) {
  const lines = text.split("\n");
  let issue = null, issueLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = cleanOcrLine(lines[i]).match(/\b20\d{5}\b/);
    if (m) {
      issue = m[0];
      issueLineIdx = i;
      break;
    }
  }
  const betRegion = issueLineIdx > 0 ? lines.slice(0, issueLineIdx) : lines;
  const seen = new Set();
  const bets = [];
  betRegion.forEach((line) => {
    extractBets(extractNums(line)).forEach((bet) => {
      const s = bet.reds.map(pad).join(" ") + " + " + pad(bet.blue);
      if (!seen.has(s)) {
        seen.add(s);
        bets.push(s);
      }
    });
  });
  return { issue, bets };
}

async function ocrPhoto(file) {
  $("ckStatus").textContent = "正在加载识别引擎（首次需几秒）…";
  try {
    await loadTesseract();
    $("ckStatus").textContent = "正在预处理图片…";
    const canvas = await preprocessImage(file);
    const worker = await Tesseract.createWorker("eng");
    await worker.setParameter("tessedit_char_whitelist", " 0123456789");
    await worker.setParameter("tessedit_pageseg_mode", "6");
    $("ckStatus").textContent = "正在识别照片中的号码…";
    const { data } = await worker.recognize(canvas);
    await worker.terminate();
    if ($("ckRaw")) {
      $("ckRaw").textContent = data.text || "（空）";
      $("ckRawWrap").hidden = false;
    }
    const { issue, bets } = parseOcrText(data.text || "");
    if (issue) $("ckIssue").value = issue;
    if (!bets.length) {
      $("ckStatus").textContent = (issue ? `已识别期号 ${issue}，但` : "") +
        "未能识别出有效号码——请对准号码区域、票面放平重拍，或手动输入";
      return;
    }
    $("ckBets").value = bets.join("\n");
    $("ckStatus").textContent =
      (issue ? `已识别期号 ${issue}、` : "") +
      `识别到 ${bets.length} 注号码，请核对无误后再点「查询是否中奖」`;
  } catch (e) {
    $("ckStatus").textContent = "识别失败：" + e.message + "，可改为手动输入";
  }
}

$("btnCheck").addEventListener("click", checkTickets);
$("btnOcr").addEventListener("click", () => $("ckPhoto").click());
$("ckPhoto").addEventListener("change", (e) => {
  if (e.target.files[0]) ocrPhoto(e.target.files[0]);
  e.target.value = "";
});
// 期号默认填最新一期
getDraws().then((d) => {
  if (d && !$("ckIssue").value) $("ckIssue").value = d[d.length - 1].issue;
});

$("btnRecommend").addEventListener("click", genPicks);
$("btnCopy").addEventListener("click", copyPicks);
$("btnUpdate").addEventListener("click", updateData);
$("window").addEventListener("change", loadStats);
$("btWindow").addEventListener("change", loadBacktest);

loadStats();
loadBacktest();
