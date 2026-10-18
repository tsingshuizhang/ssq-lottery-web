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
import ssl
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

RED_MIN, RED_MAX, RED_COUNT = 1, 33, 6
BLUE_MIN, BLUE_MAX = 1, 16
DATA_FILE = Path(__file__).parent / "ssq_data.json"
STATIC_DIR = Path(__file__).parent / "static" / "data"
WINDOWS = (20, 30, 50, 100)  # 前端可选的统计窗口（与 static/index.html 下拉框一致）
API_URL = (
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/"
    "findDrawNotice?name=ssq&issueCount={count}"
)


# ---------------------------------------------------------------- 数据管理

def load_data():
    """加载历史开奖数据，按期号升序返回。"""
    if not DATA_FILE.exists():
        sys.exit(f"未找到数据文件：{DATA_FILE}")
    draws = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    draws.sort(key=lambda d: d["issue"])
    return draws


def update_data(count=100):
    """从官方接口拉取最近 count 期数据并合并保存。"""
    url = API_URL.format(count=count)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
    except (ssl.SSLError, urllib.error.URLError):
        # 部分网络环境（如代理）证书校验失败，降级为不校验证书重试
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            raw = resp.read().decode("utf-8")
    payload = json.loads(raw)
    if payload.get("state") != 0:
        sys.exit(f"接口返回异常：{payload.get('message')}")

    old = {d["issue"]: d for d in load_data()}
    for item in payload["result"]:
        red = sorted(int(x) for x in item["red"].split(","))
        old[item["code"]] = {
            "issue": item["code"],
            "date": item["date"].split("(")[0],
            "red": red,
            "blue": int(item["blue"]),
        }
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
    info = {
        "total": len(draws),
        "range": [draws[0]["issue"], draws[-1]["issue"]],
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
    (STATIC_DIR / "info.json").write_text(
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
        for num, w in pool.items():
            acc += w
            if r <= acc:
                picked.append(num)
                del pool[num]
                break
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


def recommend(draws, count=10, max_attempts=500):
    """生成 count 组推荐号码（红球组合不重复）。"""
    red_w, blue_w = score_weights(draws)
    picks, seen = [], set()
    attempts = 0
    while len(picks) < count and attempts < max_attempts * count:
        attempts += 1
        reds = tuple(weighted_pick(red_w, RED_COUNT))
        if reds in seen:
            continue
        if not structurally_sane(reds):
            continue
        blue = weighted_pick(blue_w, 1)[0]
        seen.add(reds)
        picks.append((list(reds), blue))
    return picks


# ---------------------------------------------------------------- 入口

def main():
    parser = argparse.ArgumentParser(description="双色球历史数据分析与号码推荐")
    parser.add_argument("-n", "--count", type=int, default=10, help="推荐号码组数（默认 10）")
    parser.add_argument("-w", "--window", type=int, default=30, help="统计窗口期数（默认 30）")
    parser.add_argument("-s", "--stats", action="store_true", help="只显示统计分析，不推荐号码")
    parser.add_argument("-u", "--update", type=int, metavar="N", nargs="?", const=100,
                        help="从官方接口更新最近 N 期数据（默认 100）")
    args = parser.parse_args()

    if args.update:
        update_data(args.update)
        return

    draws = load_data()
    print(f"已加载 {len(draws)} 期历史数据（{draws[0]['issue']} ~ {draws[-1]['issue']}）")

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
