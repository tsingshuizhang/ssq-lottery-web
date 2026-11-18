#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
双色球分析与号码推荐程序

规则：红球 6 个（1-33 不重复）+ 蓝球 1 个（1-16）

功能：
  1. 内置真实历史开奖数据（ssq_data.json），支持联网更新
  2. 统计分析：频率、遗漏值、奇偶比、区间分布
  3. 基于加权概率模型推荐 10 组号码（详见 score 函数说明）

免责声明：每期开奖均为独立随机事件，历史数据不影响未来结果。
本程序仅供娱乐参考，不构成任何投注建议。
"""

import argparse
import json
import random
import re
import ssl
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

RED_MIN, RED_MAX, RED_COUNT = 1, 33, 6
BLUE_MIN, BLUE_MAX = 1, 16
ISSUES_PER_YEAR = 154  # 双色球每年约 153-154 期（每周二/四/日开奖，春节休市）
DATA_FILE = Path(__file__).parent / "ssq_data.json"
STATIC_DIR = Path(__file__).parent / "static" / "data"
WINDOWS = (20, 30, 50, 100)  # 前端可选的统计窗口（与 static/index.html 下拉框一致）
API_URL = (
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/"
    "findDrawNotice?name=ssq&issueCount={count}"
)


# ---------------------------------------------------------------- 数据管理

def validate_draw(d):
    """校验单条开奖记录的合法性，非法数据返回 False（防止异常解析污染数据）。"""
    try:
        reds = d["red"]
        return (
            isinstance(d["issue"], str) and re.fullmatch(r"20\d{5}", d["issue"])
            and len(reds) == RED_COUNT and len(set(reds)) == RED_COUNT
            and all(RED_MIN <= n <= RED_MAX for n in reds)
            and BLUE_MIN <= d["blue"] <= BLUE_MAX
        )
    except (KeyError, TypeError):
        return False


def load_data():
    """加载历史开奖数据，按期号升序返回。"""
    if not DATA_FILE.exists():
        sys.exit(f"未找到数据文件：{DATA_FILE}")
    draws = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    draws.sort(key=lambda d: d["issue"])
    return draws


def _open_with_ssl_fallback(req, timeout):
    """打开 URL；证书校验失败（代理环境）时降级为不校验重试。"""
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except (ssl.SSLError, urllib.error.URLError):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return urllib.request.urlopen(req, timeout=timeout, context=ctx)


def fetch_cwl(count):
    """从中国福彩官网接口拉取最近 count 期数据。"""
    url = API_URL.format(count=count)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with _open_with_ssl_fallback(req, 15) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("state") != 0:
        raise RuntimeError(f"福彩官网接口返回异常：{payload.get('message')}")
    draws = []
    for item in payload["result"]:
        draws.append({
            "issue": item["code"],
            "date": item["date"].split("(")[0],
            "red": sorted(int(x) for x in item["red"].split(",")),
            "blue": int(item["blue"]),
        })
    return [d for d in draws if validate_draw(d)]


def fetch_500(start_issue, end_issue, allow_empty=False):
    """从 500.com 历史数据页抓取特定期号范围（GBK 编码 HTML）。

    作为福彩官网的备用数据源：官网对海外/机房 IP 返回 403（网宿云 WAF），
    GitHub Actions 的 runner 无法直连，500.com 可正常访问。
    页面行结构：<tr class="t_tr1"> 内依次为 期号、6 个红球、蓝球、……、开奖日期。
    注意 500.com 使用短期号（YY+NNN，如 26119），本函数对外统一使用完整期号
    （如 2026119），内部自动转换。
    """
    to_short = lambda s: str(int(s))[2:]  # 2026119 -> 26119
    url = (f"https://datachart.500.com/ssq/history/newinc/history.php"
           f"?start={to_short(start_issue)}&end={to_short(end_issue)}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with _open_with_ssl_fallback(req, 30) as resp:
        text = resp.read().decode("gb18030", errors="ignore")
    draws = []
    for row in re.findall(r'<tr class="t_tr1">(.*?)</tr>', text, re.S):
        cells = [re.sub(r"<[^>]+>", "", c).strip()
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        idx = next((i for i, c in enumerate(cells) if re.fullmatch(r"\d{5,7}", c)), None)
        if idx is None:
            continue
        try:
            reds = sorted(int(c) for c in cells[idx + 1: idx + 7])
            blue = int(cells[idx + 7])
        except ValueError:
            continue
        date = next((c for c in cells if re.fullmatch(r"20\d{2}-\d{2}-\d{2}", c)), "")
        draws.append({"issue": "20" + cells[idx], "date": date, "red": reds, "blue": blue})
    if not draws and not allow_empty:
        raise RuntimeError("500.com 未解析到任何开奖数据")
    return [d for d in draws if validate_draw(d)]


def fetch_500_incremental(latest_issue, back=5, forward=30):
    """围绕已知最新期号做增量抓取，自动处理期号跨年滚动。

    期号格式 YYYYNNN，NNN 每年从 001 重新计数。若 latest + forward 超出
    本年（约 ISSUES_PER_YEAR 期），新一年的期号（如 2027001）不在
    "latest-5 ~ latest+30" 的整数区间内，简单加法会永远抓不到新一年的
    数据，因此拆成"本年尾部 + 次年开头"两段抓取后合并。
    """
    year, nn = int(latest_issue[:4]), int(latest_issue[4:])
    ranges = [(f"{year}{max(nn - back, 1):03d}", f"{year}{nn + forward:03d}")]
    if nn + forward > ISSUES_PER_YEAR:
        overflow = nn + forward - ISSUES_PER_YEAR
        ranges.append((f"{year + 1}001", f"{year + 1}{overflow:03d}"))
    merged = {}
    for start, end in ranges:
        for d in fetch_500(start, end, allow_empty=True):
            merged[d["issue"]] = d
    if not merged:
        raise RuntimeError("500.com 未解析到任何开奖数据")
    return sorted(merged.values(), key=lambda d: d["issue"])


def update_data(count=100):
    """更新历史数据：优先福彩官网，被拦截时回退 500.com；合并去重并重建静态文件。"""
    try:
        fetched = fetch_cwl(count)
        print(f"数据源：福彩官网（{len(fetched)} 期）")
    except Exception as exc:
        print(f"福彩官网获取失败（{exc}），回退 500.com 数据源")
        old_draws = load_data()
        latest = old_draws[-1]["issue"] if old_draws else "2026001"
        # 只需覆盖"已知最新期 → 未来若干期"的增量窗口即可跟上新数据（自动跨年）
        fetched = fetch_500_incremental(latest)
        print(f"数据源：500.com（{len(fetched)} 期）")

    old = {d["issue"]: d for d in load_data()}
    skipped = 0
    for d in fetched:
        if not validate_draw(d):   # 双重保险：异常记录不入库
            skipped += 1
            continue
        if not d["date"] and d["issue"] in old:
            d["date"] = old[d["issue"]]["date"]  # 备用源缺失日期时保留已有值
        old[d["issue"]] = d
    if skipped:
        print(f"⚠️ 跳过 {skipped} 条格式异常的数据")
    merged = sorted(old.values(), key=lambda d: d["issue"])
    DATA_FILE.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    export_static(merged)
    print(f"数据更新完成，共 {len(merged)} 期（{merged[0]['issue']} ~ {merged[-1]['issue']}）")


def export_static(draws):
    """预生成前端所需的静态 JSON 文件（static/data/）。

    - stats_<窗口>.json：各统计窗口的完整统计结果（前端切换窗口时直接读取，
      无需请求后端计算）；
    - weights.json：推荐模型基础得分（频率 50% + 遗漏 30%，不含随机项，
      随机扰动由前端在每次生成时加入）；
    - info.json：数据概况与生成时间。

    这些文件提交进 git 后，GitHub Pages 上的纯静态页面即可完整运行，
    并由 GitHub Actions 在每期开奖后自动重新生成。
    """
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    for w in WINDOWS:
        payload = stats_dict(draws, min(w, len(draws)))
        (STATIC_DIR / f"stats_{w}.json").write_text(
            json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    red_base, blue_base = base_scores(draws)
    weights = {"red": sorted(red_base.items()), "blue": sorted(blue_base.items())}
    (STATIC_DIR / "weights.json").write_text(
        json.dumps(weights, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    # 历史回测（固定种子、可复现）：与统计窗口一致，各窗口一份，前端切换零计算
    for w in WINDOWS:
        bt = backtest(draws, window=min(w, max(1, len(draws) // 5)))
        (STATIC_DIR / f"backtest_{w}.json").write_text(
            json.dumps(bt, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    info_range = [draws[0]["issue"], draws[-1]["issue"]]
    info_file = STATIC_DIR / "info.json"
    generated_at = datetime.now().isoformat(timespec="seconds")
    if info_file.exists():  # 数据无变化时保留原时间戳，避免 Actions 产生空提交
        try:
            old_info = json.loads(info_file.read_text(encoding="utf-8"))
            if old_info.get("total") == len(draws) and old_info.get("range") == info_range:
                generated_at = old_info.get("generated_at", generated_at)
        except (ValueError, OSError):
            pass
    info = {
        "total": len(draws),
        "range": info_range,
        "generated_at": generated_at,
    }
    info_file.write_text(
        json.dumps(info, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"静态统计文件已生成 → {STATIC_DIR}")


# ---------------------------------------------------------------- 统计分析

def frequency(draws, window=None):
    """统计红球/蓝球出现次数。window 指定只统计最近 N 期。"""
    scope = draws[-window:] if window else draws
    red_freq = {i: 0 for i in range(RED_MIN, RED_MAX + 1)}
    blue_freq = {i: 0 for i in range(BLUE_MIN, BLUE_MAX + 1)}
    for d in scope:
        for n in d["red"]:
            red_freq[n] += 1
        blue_freq[d["blue"]] += 1
    return red_freq, blue_freq


def omission(draws):
    """遗漏值：自该号码最近一次开出至今的期数（越大表示越久未出）。"""
    red_omit = {i: len(draws) for i in range(RED_MIN, RED_MAX + 1)}
    blue_omit = {i: len(draws) for i in range(BLUE_MIN, BLUE_MAX + 1)}
    for back, d in enumerate(reversed(draws), start=1):
        for n in d["red"]:
            if red_omit[n] == len(draws):
                red_omit[n] = back - 1
        b = d["blue"]
        if blue_omit[b] == len(draws):
            blue_omit[b] = back - 1
    return red_omit, blue_omit


def stats_dict(draws, window=30):
    """返回结构化统计信息（供 CLI 与 Web 共用）。

    包含：样本范围、红/蓝球热冷号、当前遗漏、奇偶分布、
    全量频率表（用于前端热力图）以及最近 10 期开奖号码。
    """
    scope = draws[-window:]
    red_freq, blue_freq = frequency(draws, window)
    red_omit, blue_omit = omission(draws)

    odd_even = {"odd": 0, "even": 0, "balanced": 0}
    for d in scope:
        odd = sum(n % 2 for n in d["red"])
        odd_even["odd" if odd > 3 else "even" if odd < 3 else "balanced"] += 1

    return {
        "total": len(draws),
        "range": [draws[0]["issue"], draws[-1]["issue"]],
        "window": len(scope),
        "window_range": [scope[0]["issue"], scope[-1]["issue"]],
        "hot_red": sorted(red_freq.items(), key=lambda kv: kv[1], reverse=True)[:8],
        "cold_red": sorted(red_freq.items(), key=lambda kv: kv[1])[:8],
        "hot_blue": sorted(blue_freq.items(), key=lambda kv: kv[1], reverse=True)[:5],
        "cold_blue": sorted(blue_freq.items(), key=lambda kv: kv[1])[:5],
        "omit_red": sorted(red_omit.items(), key=lambda kv: kv[1], reverse=True)[:6],
        "omit_blue": sorted(blue_omit.items(), key=lambda kv: kv[1], reverse=True)[:4],
        "red_freq": red_freq,
        "blue_freq": blue_freq,
        "red_omit": red_omit,
        "blue_omit": blue_omit,
        "odd_even": odd_even,
        "recent": draws[-10:],
    }


def show_stats(draws, window=30):
    """打印最近 window 期的统计分析。"""
    s = stats_dict(draws, window)
    print(f"\n{'='*60}")
    print(f" 最近 {s['window']} 期统计（{s['window_range'][0]} ~ {s['window_range'][1]}）")
    print(f"{'='*60}")

    print("\n红球热号 TOP8 :", " ".join(f"{n:02d}({c})" for n, c in s["hot_red"]))
    print("红球冷号 TOP8 :", " ".join(f"{n:02d}({c})" for n, c in s["cold_red"]))

    print("\n蓝球热号 TOP5 :", " ".join(f"{n:02d}({c})" for n, c in s["hot_blue"]))
    print("蓝球冷号 TOP5 :", " ".join(f"{n:02d}({c})" for n, c in s["cold_blue"]))

    print("\n红球当前最大遗漏:", " ".join(f"{n:02d}(遗漏{v})" for n, v in s["omit_red"]))
    print("蓝球当前最大遗漏:", " ".join(f"{n:02d}(遗漏{v})" for n, v in s["omit_blue"]))

    oe = s["odd_even"]
    print(f"\n奇偶分布: 奇多:{oe['odd']}  偶多:{oe['even']}  均衡:{oe['balanced']}")


# ---------------------------------------------------------------- 推荐算法

def base_scores(draws, w_freq=0.5, w_omit=0.3, decay=0.97):
    """计算红球/蓝球基础得分（频率项 + 遗漏项，不含随机扰动）。

    随机项与权重抽样在 score_weights / 前端中处理；
    基础得分会导出到 static/data/weights.json 供纯静态页面复用。
    """
    n = len(draws)
    red_w = {i: 0.0 for i in range(RED_MIN, RED_MAX + 1)}
    blue_w = {i: 0.0 for i in range(BLUE_MIN, BLUE_MAX + 1)}
    for idx, d in enumerate(draws):
        weight = decay ** (n - idx - 1)  # 越近权重越大
        for r in d["red"]:
            red_w[r] += weight
        blue_w[d["blue"]] += weight

    red_omit, blue_omit = omission(draws)

    def normalize(d):
        lo, hi = min(d.values()), max(d.values())
        span = (hi - lo) or 1.0
        return {k: (v - lo) / span for k, v in d.items()}

    red_w_n, blue_w_n = normalize(red_w), normalize(blue_w)
    red_o_n, blue_o_n = normalize(red_omit), normalize(blue_omit)

    red_base = {i: w_freq * red_w_n[i] + w_omit * red_o_n[i] for i in red_w_n}
    blue_base = {i: w_freq * blue_w_n[i] + w_omit * blue_o_n[i] for i in blue_w_n}
    return red_base, blue_base


def score_weights(draws, w_freq=0.5, w_omit=0.3, w_rand=0.2, decay=0.97):
    """计算红球/蓝球权重（在基础得分上加入随机扰动项）。

    加权模型（归一化后线性组合）：
      1. 频率项  w_freq  —— 时间衰减加权频率（近期开出权重更高）
      2. 遗漏项  w_omit  —— 遗漏值越大权重越高（"补出"倾向）
      3. 随机项  w_rand  —— 均匀随机扰动，避免完全机械选号

    说明：彩票每期独立随机，本模型仅为常见选号策略的量化实现。
    """
    red_base, blue_base = base_scores(draws, w_freq, w_omit, decay)
    red_final = {i: s + w_rand * random.random() for i, s in red_base.items()}
    blue_final = {i: s + w_rand * random.random() for i, s in blue_base.items()}
    return red_final, blue_final


def weighted_pick(weights, k):
    """按权重不放回抽取 k 个号码。"""
    pool = dict(weights)
    picked = []
    for _ in range(k):
        total = sum(pool.values())
        r = random.uniform(0, total)
        acc = 0.0
        hit = None
        for num, w in pool.items():
            acc += w
            if r <= acc:
                hit = num
                break
        if hit is None:        # 浮点边界兜底：r 恰好落在累计误差之外
            hit = next(reversed(pool))
        picked.append(hit)
        del pool[hit]
    return sorted(picked)


def structurally_sane(reds):
    """结构过滤：与历史形态保持大体一致（非强制，仅减少极端形态）。"""
    odd = sum(n % 2 for n in reds)
    if odd in (0, 6):            # 全奇/全偶，历史极少出现
        return False
    if sum(reds) < 60 or sum(reds) > 130:   # 和值极端区间
        return False
    consecutive = sum(1 for a, b in zip(reds, reds[1:]) if b - a == 1)
    if consecutive >= 3:         # 3 组以上连号
        return False
    return True


def _recommend_from_base(red_base, blue_base, count, w_rand=0.2, max_attempts=500):
    """在已算好的基础得分上生成 count 组推荐（回测蒙特卡洛抽样的内层循环）。"""
    picks, seen = [], set()
    attempts = 0
    while len(picks) < count and attempts < max_attempts * count:
        attempts += 1
        red_w = {i: s + w_rand * random.random() for i, s in red_base.items()}
        reds = tuple(weighted_pick(red_w, RED_COUNT))
        if reds in seen:
            continue
        if not structurally_sane(reds):
            continue
        blue_w = {i: s + w_rand * random.random() for i, s in blue_base.items()}
        blue = weighted_pick(blue_w, 1)[0]
        seen.add(reds)
        picks.append((list(reds), blue))
    return picks


def recommend(draws, count=10, max_attempts=500, w_rand=0.2):
    """生成 count 组推荐号码（红球组合不重复）。

    每组抽取前都在基础得分上重新加入随机扰动，避免 10 组共用同一权重池
    导致组间号码高度雷同。
    """
    red_base, blue_base = base_scores(draws)
    return _recommend_from_base(red_base, blue_base, count, w_rand, max_attempts)


# ---------------------------------------------------------------- 历史回测

def backtest(draws, window=20, count=10, trials=50, seed=42):
    """蒙特卡洛历史回测：对最近 window 期，逐期用"该期之前的数据"训练，
    用 trials 个不同种子各生成 count 组推荐，命中取统计均值；
    纯随机基线同口径对照。所有种子固定（seed + 期号 + 试验序号），
    结果完全可复现，且不受单一种子的运气成分影响。

    评估口径：每次试验取"命中最好的一注"（先比红球命中数，再比蓝球是否命中），
    模拟"按推荐买 count 注，看中得最好的一注"；另统计蓝球在 count 注中的命中率。
    每期输出 trials 次试验的均值与标准差。

    返回 {"draws": [逐期明细], "summary": {"model"/"random": 汇总指标}}。
    """
    if len(draws) <= window:
        raise ValueError(f"数据不足：共 {len(draws)} 期，无法回测最近 {window} 期")
    records = []
    for i in range(len(draws) - window, len(draws)):
        train, actual = draws[:i], draws[i]
        a_red, a_blue = set(actual["red"]), actual["blue"]
        # 基础得分只与训练数据有关，每期算一次，各次试验仅随机项不同
        red_base, blue_base = base_scores(train)

        def run_trials(kind):
            hits, blue_anys = [], []
            for t in range(trials):
                random.seed(f"{kind}-{seed}-{actual['issue']}-{t}")
                if kind == "model":
                    picks = _recommend_from_base(red_base, blue_base, count)
                else:
                    picks = [
                        (sorted(random.sample(range(RED_MIN, RED_MAX + 1), RED_COUNT)),
                         random.randint(BLUE_MIN, BLUE_MAX))
                        for _ in range(count)
                    ]
                best = max(picks, key=lambda p: (len(set(p[0]) & a_red), p[1] == a_blue))
                hits.append(len(set(best[0]) & a_red))
                blue_anys.append(any(p[1] == a_blue for p in picks))
            avg = sum(hits) / len(hits)
            var = sum((h - avg) ** 2 for h in hits) / len(hits)
            return {
                "avg_red_hits": round(avg, 2),
                "std_red_hits": round(var ** 0.5, 2),
                "max_red_hits": max(hits),
                "blue_any_rate": round(sum(blue_anys) / len(blue_anys), 2),
            }

        records.append({
            "issue": actual["issue"], "date": actual["date"],
            "actual": {"red": actual["red"], "blue": a_blue},
            "model": run_trials("model"),
            "random": run_trials("random"),
        })

    def summarize(key):
        avgs = [r[key]["avg_red_hits"] for r in records]
        return {
            "avg_red_hits": round(sum(avgs) / len(avgs), 2),
            "std_red_hits": round(
                sum(r[key]["std_red_hits"] for r in records) / len(records), 2),
            "max_red_hits": max(r[key]["max_red_hits"] for r in records),
            "blue_any_rate": round(
                sum(r[key]["blue_any_rate"] for r in records) / len(records), 2),
        }

    return {
        "window": window, "count": count, "trials": trials,
        "range": [records[0]["issue"], records[-1]["issue"]],
        "draws": records,
        "summary": {"model": summarize("model"), "random": summarize("random")},
    }


def show_backtest(draws, window=20, count=10, trials=50):
    """打印蒙特卡洛历史回测结果（模型 vs 纯随机基线）。"""
    bt = backtest(draws, window=window, count=count, trials=trials)
    ms, rs = bt["summary"]["model"], bt["summary"]["random"]
    print(f"\n{'='*80}")
    print(f" 历史回测：最近 {bt['window']} 期（{bt['range'][0]} ~ {bt['range'][1]}）"
          f"，每期 {bt['trials']} 次抽样 × {bt['count']} 组")
    print(f"{'='*80}")
    print(f" {'期号':<9} {'实际开奖':<28} {'模型（均值±波动, 蓝率）':<26} {'随机（均值±波动, 蓝率）'}")
    print("-" * 80)
    for r in bt["draws"]:
        actual = " ".join(f"{n:02d}" for n in r["actual"]["red"]) + f" + {r['actual']['blue']:02d}"
        m, rd = r["model"], r["random"]
        m_txt = f"{m['avg_red_hits']:.1f}红±{m['std_red_hits']:.1f} 蓝{m['blue_any_rate']:.0%}"
        r_txt = f"{rd['avg_red_hits']:.1f}红±{rd['std_red_hits']:.1f} 蓝{rd['blue_any_rate']:.0%}"
        print(f" {r['issue']:<9} {actual:<28} {m_txt:<26} {r_txt}")
    print("-" * 80)
    print(f" 红球平均命中（每期最佳一注的抽样均值）：模型 {ms['avg_red_hits']}±{ms['std_red_hits']}  vs  随机 {rs['avg_red_hits']}±{rs['std_red_hits']}")
    print(f" 红球单场最高命中：模型 {ms['max_red_hits']} 个  vs  随机 {rs['max_red_hits']} 个")
    print(f" 蓝球命中率（{bt['count']} 组内任一命中的试验占比）：模型 {ms['blue_any_rate']:.0%}  vs  随机 {rs['blue_any_rate']:.0%}")
    print(f"\n* 每期只用该期之前的数据训练；每期 {bt['trials']} 个不同种子各推荐 {bt['count']} 组取平均，")
    print("  排除单一种子的运气成分；所有种子固定，结果可复现。")
    print("  模型若优于随机基线不代表未来有效——历史命中好可能是过拟合或运气。")
    return bt


# ---------------------------------------------------------------- 入口

def main():
    parser = argparse.ArgumentParser(description="双色球历史数据分析与号码推荐")
    parser.add_argument("-n", "--count", type=int, default=10, help="推荐号码组数（默认 10）")
    parser.add_argument("-w", "--window", type=int, default=30, help="统计窗口期数（默认 30）")
    parser.add_argument("-s", "--stats", action="store_true", help="只显示统计分析，不推荐号码")
    parser.add_argument("--seed", type=int, default=None, help="随机种子（固定后推荐结果可复现）")
    parser.add_argument("-b", "--backtest", type=int, metavar="N", nargs="?", const=20,
                        help="历史回测最近 N 期（默认 20）：模型 vs 纯随机基线")
    parser.add_argument("--trials", type=int, default=50,
                        help="回测每期的蒙特卡洛抽样次数（默认 50）")
    parser.add_argument("-u", "--update", type=int, metavar="N", nargs="?", const=100,
                        help="从官方接口更新最近 N 期数据（默认 100）")
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    if args.update:
        update_data(args.update)
        return

    draws = load_data()
    print(f"已加载 {len(draws)} 期历史数据（{draws[0]['issue']} ~ {draws[-1]['issue']}）")

    if args.backtest:
        show_backtest(draws, window=args.backtest, count=args.count, trials=args.trials)
        return

    show_stats(draws, args.window)
    if args.stats:
        return

    picks = recommend(draws, count=args.count)
    print(f"\n{'='*60}")
    print(f" 基于加权概率模型推荐 {len(picks)} 组号码")
    print(f"{'='*60}")
    print(f" {'序号':<4} {'红球':<28} {'蓝球':<6}")
    print("-" * 60)
    for i, (reds, blue) in enumerate(picks, 1):
        print(f" {i:<5} {' '.join(f'{n:02d}' for n in reds):<30} {blue:02d}")

    print("\n* 每期开奖均为独立随机事件，以上号码仅供娱乐参考，不构成投注建议。")


if __name__ == "__main__":
    main()
