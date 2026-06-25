#!/usr/bin/env python3
# /root/vLLM/throttle/resume_stats.py
# 简历处理统计 -- 从 SQLite 拉数据, 输出 JSON
# 被 monitor_api.js (端口 3101) 调用
#
# 用法:
#   python3 resume_stats.py 10m          # 最近 10 分钟
#   python3 resume_stats.py 30m
#   python3 resume_stats.py 1h
#   python3 resume_stats.py 50           # 最近 50 条 R1
#   python3 resume_stats.py 100
#   python3 resume_stats.py 500

import sqlite3, json, sys, os
from datetime import datetime

DB_PATH = '/root/vLLM/logs/request_logs.db'


def parse_window(arg: str):
    """返回 (sql_where, label) -- 按时间或按条数"""
    arg = (arg or '10m').strip()
    if arg.endswith('m'):
        n = int(arg[:-1])
        return ('time', f"timestamp >= datetime('now','+8 hours','-{n} minutes')", arg)
    if arg.endswith('h'):
        n = int(arg[:-1])
        return ('time', f"timestamp >= datetime('now','+8 hours','-{n} hours')", arg)
    # 否则当成条数 (按 R1 倒推)
    try:
        n = int(arg)
        return ('count', n, f"最近{n}条")
    except ValueError:
        return ('time', "timestamp >= datetime('now','+8 hours','-10 minutes')", '10m')


def classify_row(row):
    """按 max_tokens + user content 头部判断属于哪一轮; 返回 'r1'/'r2'/'r3'/'r4'/None"""
    try:
        body = json.loads(row['request_body'])
    except Exception:
        return None
    mt = body.get('max_tokens', 0)
    if mt == 600:
        return 'r1'
    if mt == 720:
        return 'r4'
    if mt == 360:
        user_c = ''
        for m in body.get('messages', []):
            if m.get('role') == 'user':
                user_c = (m.get('content') or '')[:80]
                break
        return 'r3' if '职能' in user_c else 'r2'
    return None


def pctl(arr, p):
    if not arr:
        return 0
    s = sorted(arr)
    idx = min(int(len(s) * p), len(s) - 1)
    return round(s[idx], 2)


def stats_for(arr):
    if not arr:
        return {'n': 0, 'avg': 0, 'p50': 0, 'p90': 0, 'p99': 0, 'max': 0, 'min': 0, 'avgTok': 0, 'distribution': []}
    ds = [r['duration_ms'] / 1000.0 for r in arr]
    cts = [r['completion_tokens'] or 0 for r in arr]
    bins = [(0, 2, '<2s'), (2, 5, '2-5s'), (5, 10, '5-10s'),
            (10, 15, '10-15s'), (15, 30, '15-30s'), (30, 60, '30-60s'), (60, 999, '>60s')]
    dist = []
    for lo, hi, label in bins:
        c = sum(1 for d in ds if lo <= d < hi)
        if c > 0 or label in ('<2s', '2-5s', '5-10s', '10-15s'):
            dist.append({'range': label, 'count': c})
    return {
        'n': len(arr),
        'avg': round(sum(ds) / len(ds), 2),
        'min': round(min(ds), 2),
        'max': round(max(ds), 2),
        'p50': pctl(ds, 0.5),
        'p90': pctl(ds, 0.9),
        'p99': pctl(ds, 0.99),
        'avgTok': round(sum(cts) / len(cts)) if cts else 0,
        'distribution': dist,
    }


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else '10m'
    mode, where, label = parse_window(arg)

    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        if mode == 'time':
            sql = f"""
                SELECT id, timestamp, duration_ms, request_body, completion_tokens
                FROM request_logs
                WHERE path='/v1/chat/completions' AND status_code=200 AND duration_ms > 100
                  AND {where}
                ORDER BY id ASC
            """
            c.execute(sql)
        else:
            # mode == 'count': 取最近 N*5 条 (足以覆盖 4 轮), 然后切出最近 N 份简历
            limit = int(where) * 6
            c.execute(f"""
                SELECT id, timestamp, duration_ms, request_body, completion_tokens
                FROM request_logs
                WHERE path='/v1/chat/completions' AND status_code=200 AND duration_ms > 100
                ORDER BY id DESC LIMIT {limit}
            """)

        rows = c.fetchall()

        # 分类
        rounds = {'r1': [], 'r2': [], 'r3': [], 'r4': []}
        for r in rows:
            kind = classify_row(r)
            if kind:
                rounds[kind].append(r)

        if mode == 'count':
            # 倒序取的, 还原成时间正序
            for k in rounds: rounds[k].reverse()
            n = int(where)
            rounds['r1'] = rounds['r1'][-n:]
            rounds['r2'] = rounds['r2'][-n:]
            rounds['r3'] = rounds['r3'][-n:]
            rounds['r4'] = rounds['r4'][-n:]

        result = {
            'window': label,
            'totalResumes': len(rounds['r4']),
            'totalCalls': {k: len(v) for k, v in rounds.items()},
            'perRound': {k: stats_for(v) for k, v in rounds.items()},
        }

        # 单条 4 轮总和 (按 R1+R2+R3+R4 各自的均值相加)
        if all(rounds[k] for k in ['r1', 'r2', 'r3', 'r4']):
            total = sum(result['perRound'][k]['avg'] for k in ['r1', 'r2', 'r3', 'r4'])
            result['fullResumeAvg'] = round(total, 2)
        else:
            result['fullResumeAvg'] = 0

        # 时间跨度 + 吞吐
        if rounds['r1']:
            ts = sorted([r['timestamp'] for r in rounds['r1']])
            result['timeRange'] = [ts[0], ts[-1]]
            t0 = datetime.fromisoformat(ts[0])
            t1 = datetime.fromisoformat(ts[-1])
            span = max((t1 - t0).total_seconds(), 1)
            result['windowSec'] = round(span)
            # 用 R4 当吞吐基准(完成的简历数)
            result['throughputPerMin'] = round(len(rounds['r4']) / span * 60, 1) if rounds['r4'] else 0
        else:
            result['timeRange'] = None
            result['windowSec'] = 0
            result['throughputPerMin'] = 0

        # 每分钟到达趋势 (R1 数, 最近 30 分钟内)
        per_min = {}
        for r in rounds['r1']:
            bucket = r['timestamp'][:16]   # YYYY-MM-DD HH:MM
            per_min[bucket] = per_min.get(bucket, 0) + 1
        result['perMinute'] = [{'time': k, 'count': v} for k, v in sorted(per_min.items())][-30:]

        # 输出 JSON
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        sys.stdout.write(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
