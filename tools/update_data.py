#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
远端自动更新入口（GitHub Actions 定时调用，也可本地手动执行）：

    python tools/update_data.py

流程：从福彩官网拉取最近 200 期开奖数据 → 合并去重写入 ssq_data.json
      → 重新生成 static/data/ 下的全部静态统计文件（前端直接读取）。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ssq import export_static, load_data, update_data  # noqa: E402

if __name__ == "__main__":
    update_data(200)
    export_static(load_data())
