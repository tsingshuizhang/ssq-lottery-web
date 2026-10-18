/* 双色球 Web —— 前端逻辑 */

const $ = (id) => document.getElementById(id);

/** 两位数字格式化 */
const pad = (n) => String(n).padStart(2, "0");

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

/** 加载并渲染统计数据 */
async function loadStats() {
  const windowSize = $("window").value;
  $("status").textContent = "统计数据加载中…";
  try {
    const res = await fetch(`/api/stats?window=${windowSize}`);
    const s = await res.json();

    $("dataRange").textContent =
      `共 ${s.total} 期历史数据（${s.range[0]} ~ ${s.range[1]}），开奖结果来自中国福彩官网`;
    $("windowLabel").textContent = `（第 ${s.window_range[0]} ~ ${s.window_range[1]} 期）`;

    renderTags($("hotRed"), s.hot_red, "hot");
    renderTags($("coldRed"), s.cold_red, "cold");
    renderTags($("hotBlue"), s.hot_blue, "hot");
    renderTags($("coldBlue"), s.cold_blue, "cold");
    renderOmit();
    renderOddEven(s.odd_even);
    renderHeat(s);
    renderRecent(s.recent);

    function renderOmit() {
      $("omitRed").innerHTML = s.omit_red
        .map(([n, v]) => `<span class="tag hot">${pad(n)} 遗漏${v}</span>`).join("");
      $("omitBlue").innerHTML = s.omit_blue
        .map(([n, v]) => `<span class="tag cold">${pad(n)} 遗漏${v}</span>`).join("");
    }

    $("status").textContent = "";
  } catch (err) {
    $("status").innerHTML = "统计数据加载失败：" + err.message +
      "<br>💡 请确认已运行 <code>python3 ssq_web.py</code> 并通过 " +
      "<code>http://127.0.0.1:8000</code> 访问页面（不要直接双击打开 html 文件）。";
  }
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
    redGrid.appendChild(ballEl(n, "heat-red", heatStyle(f, redMax, true) + `;`));
    redGrid.lastChild.title = `出现 ${f} 次，当前遗漏 ${s.red_omit[n]} 期`;
  }

  const blueGrid = $("blueGrid");
  blueGrid.innerHTML = "";
  for (let n = 1; n <= 16; n++) {
    const f = s.blue_freq[n] || 0;
    blueGrid.appendChild(ballEl(n, "heat-blue", heatStyle(f, blueMax, false)));
    blueGrid.lastChild.title = `出现 ${f} 次，当前遗漏 ${s.blue_omit[n]} 期`;
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

/** 生成推荐号码 */
async function genPicks() {
  const btn = $("btnRecommend");
  btn.disabled = true;
  $("status").textContent = "正在计算推荐号码…";
  try {
    const res = await fetch("/api/recommend?n=10");
    const data = await res.json();
    const box = $("picks");
    box.innerHTML = "";
    data.picks.forEach((p, i) => {
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
    $("status").textContent = "";
  } catch (err) {
    $("status").textContent = "推荐生成失败：" + err.message +
      "（请先确认服务已启动：python3 ssq_web.py）";
  } finally {
    btn.disabled = false;
  }
}

/** 联网更新数据 */
async function updateData() {
  const btn = $("btnUpdate");
  btn.disabled = true;
  $("status").textContent = "正在从福彩官网更新数据，请稍候…";
  try {
    const res = await fetch("/api/update", { method: "POST" });
    const data = await res.json();
    $("status").textContent = data.message;
    if (data.ok) await loadStats();
  } catch (err) {
    $("status").textContent = "更新失败：" + err.message;
  } finally {
    btn.disabled = false;
  }
}

$("btnRecommend").addEventListener("click", genPicks);
$("btnUpdate").addEventListener("click", updateData);
$("window").addEventListener("change", loadStats);

loadStats();
