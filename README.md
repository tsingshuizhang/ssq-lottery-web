# 双色球 · 历史数据分析与号码推荐

基于历史开奖数据的统计分析 + 加权概率模型号码推荐的 Web 应用（含命令行工具）。
纯 Python 标准库实现，**零第三方依赖**，克隆即用。

![技术栈](https://img.shields.io/badge/python-%3E%3D3.8-blue) ![依赖](https://img.shields.io/badge/dependencies-none-green)

## 在线访问（GitHub Pages）

**https://tsingshuizhang.github.io/ssq-lottery-web/static/**

页面完全静态化：统计数据以预计算 JSON 形式存放在仓库中，号码推荐在浏览器端完成，
无需任何后端服务。

## 数据自动更新（GitHub Actions）

`.github/workflows/update-data.yml` 定时任务在**每周二、四、日开奖后**
（北京时间 21:50）自动执行：

```
拉取福彩官网最新开奖数据 → 合并去重写入 ssq_data.json
→ 重新生成 static/data/ 全部统计文件 → 自动提交并推送到本仓库
```

页面切换统计窗口时直接读取仓库中对应窗口的静态 JSON 文件，无需任何计算或请求后端。
也可在 Actions 页面手动触发 `workflow_dispatch`。

## 本地运行

```bash
# 启动 Web 服务（本地开发/完整功能）
python3 ssq_web.py            # 打开 http://127.0.0.1:8000

# 或命令行模式
python3 ssq.py                # 分析 + 推荐 10 组号码

# 手动更新数据（会同步重新生成 static/data/ 静态文件）
python3 tools/update_data.py
```

> ⚠️ 注意：Web 页面必须通过 `http://127.0.0.1:8000` 访问，不要直接双击打开 `static/index.html`。

## 功能

- 📊 冷热号统计、遗漏值分析、奇偶形态分布
- 🗺️ 红蓝球频率热力图（悬停查看次数与遗漏）
- 🎲 加权概率模型一键生成 10 组推荐号码（频率 50% + 遗漏 30% + 随机 20%）
- 🔄 定时自动更新历史开奖数据（GitHub Actions）

## 目录结构

| 文件 | 说明 |
|------|------|
| `ssq.py` | 核心算法库 + CLI 入口（含静态统计导出） |
| `ssq_web.py` | 本地 Web 服务端（标准库 http.server，可选） |
| `ssq_data.json` | 历史开奖数据 |
| `static/` | 前端页面（原生 HTML/CSS/JS） |
| `static/data/` | **预计算静态统计文件**（stats_*.json / weights.json / info.json） |
| `tools/update_data.py` | 远端/本地通用数据更新脚本 |
| `.github/workflows/` | GitHub Actions 定时自动更新工作流 |
| `DESIGN.md` | 完整设计说明书 |

## 免责声明

每期开奖均为独立随机事件，历史数据不影响未来结果，任何算法均无法提高中奖概率。
本项目仅供娱乐学习参考，不构成投注建议，请理性购彩。
