#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
双色球 Web 应用 —— 基于 Python 标准库，无需安装任何第三方依赖。

用法：
    python3 ssq_web.py            # 启动服务，默认 http://127.0.0.1:8000
    python3 ssq_web.py --port 9000

接口：
    GET  /                  首页
    GET  /api/stats?window=30   统计数据（JSON）
    GET  /api/recommend?n=10    推荐号码（JSON）
    POST /api/update            联网更新历史数据
"""

import argparse
import io
import json
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ssq import load_data, recommend, stats_dict, update_data

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"


def json_default(obj):
    """处理 numpy 等异常类型之外的常规对象（此处保险起见转字符串）。"""
    return str(obj)


class SSQHandler(BaseHTTPRequestHandler):
    server_version = "SSQWeb/1.0"

    # ------------------------------------------------------------ 工具

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, default=json_default).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def log_message(self, fmt, *args):  # 简化控制台日志
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ------------------------------------------------------------ 路由

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if route == "/":
            return self._send_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")

        if route.startswith("/static/"):
            rel = route[len("/static/"):]
            target = (STATIC_DIR / rel).resolve()
            if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
                return self._send_json({"error": "not found"}, 404)
            types = {".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                     ".html": "text/html; charset=utf-8"}
            return self._send_file(target, types.get(target.suffix, "application/octet-stream"))

        if route == "/api/stats":
            try:
                window = int(query.get("window", ["30"])[0])
            except ValueError:
                window = 30
            draws = load_data()
            return self._send_json(stats_dict(draws, window))

        if route == "/api/recommend":
            try:
                n = int(query.get("n", ["10"])[0])
                n = max(1, min(n, 50))
            except ValueError:
                n = 10
            draws = load_data()
            picks = [{"reds": reds, "blue": blue} for reds, blue in recommend(draws, count=n)]
            return self._send_json({"picks": picks, "range": [draws[0]["issue"], draws[-1]["issue"]]})

        self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        route = urllib.parse.urlparse(self.path).path
        if route == "/api/update":
            try:
                update_data(100)
                draws = load_data()
                return self._send_json({
                    "ok": True,
                    "message": f"数据更新完成，共 {len(draws)} 期（{draws[0]['issue']} ~ {draws[-1]['issue']}）",
                })
            except Exception as exc:  # noqa: BLE001 —— 网络/接口异常统一返回
                return self._send_json({"ok": False, "message": f"更新失败：{exc}"}, 500)
        self._send_json({"error": "not found"}, 404)


def main():
    parser = argparse.ArgumentParser(description="双色球 Web 应用")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), SSQHandler)
    print(f"双色球 Web 服务已启动： http://{args.host}:{args.port}  （Ctrl+C 停止）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")


if __name__ == "__main__":
    main()
