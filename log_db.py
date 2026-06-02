#!/usr/bin/env python3
"""
请求日志数据库模块
- 使用 SQLite 存储请求日志
- 支持查询、筛选、统计
"""

import sqlite3
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any

# 数据库文件路径
DB_PATH = os.getenv("LOG_DB_PATH", str(Path(__file__).parent / "logs" / "request_logs.db"))


def get_connection():
    """获取数据库连接"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")  # 启用 WAL 模式提高并发性能
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db():
    """初始化数据库表"""
    conn = get_connection()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                client_ip TEXT,
                method TEXT,
                path TEXT,
                request_body TEXT,
                response_body TEXT,
                status_code INTEGER,
                duration_ms REAL,
                use_scoring_rules BOOLEAN DEFAULT 0,
                model TEXT,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                error_message TEXT,
                created_at TEXT DEFAULT (datetime('now', '+8 hours'))
            )
        """)

        # 创建索引
        conn.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_client_ip ON request_logs(client_ip)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_status_code ON request_logs(status_code)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_use_scoring_rules ON request_logs(use_scoring_rules)")

        conn.commit()
        print(f"✅ 日志数据库初始化完成: {DB_PATH}")
    except Exception as e:
        print(f"❌ 数据库初始化失败: {e}")
    finally:
        conn.close()


def insert_log(
    timestamp: str,
    client_ip: str,
    method: str,
    path: str,
    request_body: Optional[str] = None,
    response_body: Optional[str] = None,
    status_code: Optional[int] = None,
    duration_ms: Optional[float] = None,
    use_scoring_rules: bool = False,
    model: Optional[str] = None,
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
    error_message: Optional[str] = None
) -> int:
    """插入一条日志记录"""
    conn = get_connection()
    try:
        cursor = conn.execute("""
            INSERT INTO request_logs (
                timestamp, client_ip, method, path, request_body,
                response_body, status_code, duration_ms, use_scoring_rules,
                model, prompt_tokens, completion_tokens, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            timestamp, client_ip, method, path, request_body,
            response_body, status_code, duration_ms, use_scoring_rules,
            model, prompt_tokens, completion_tokens, error_message
        ))
        conn.commit()
        return cursor.lastrowid
    except Exception as e:
        print(f"❌ 插入日志失败: {e}")
        return -1
    finally:
        conn.close()


def query_logs(
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    client_ip: Optional[str] = None,
    status_code: Optional[int] = None,
    use_scoring_rules: Optional[bool] = None,
    keyword: Optional[str] = None,
    page: int = 1,
    page_size: int = 20
) -> Dict[str, Any]:
    """查询日志记录"""
    conn = get_connection()
    try:
        # 构建查询条件
        conditions = []
        params = []

        if start_time:
            conditions.append("timestamp >= ?")
            params.append(start_time)
        if end_time:
            conditions.append("timestamp <= ?")
            params.append(end_time)
        if client_ip:
            conditions.append("client_ip = ?")
            params.append(client_ip)
        if status_code is not None:
            conditions.append("status_code = ?")
            params.append(status_code)
        if use_scoring_rules is not None:
            conditions.append("use_scoring_rules = ?")
            params.append(1 if use_scoring_rules else 0)
        if keyword:
            conditions.append("(request_body LIKE ? OR response_body LIKE ?)")
            params.extend([f"%{keyword}%", f"%{keyword}%"])

        where_clause = " AND ".join(conditions) if conditions else "1=1"

        # 查询总数
        count_sql = f"SELECT COUNT(*) FROM request_logs WHERE {where_clause}"
        total = conn.execute(count_sql, params).fetchone()[0]

        # 查询分页数据
        offset = (page - 1) * page_size
        query_sql = f"""
            SELECT id, timestamp, client_ip, method, path, status_code,
                   duration_ms, use_scoring_rules, model, prompt_tokens,
                   completion_tokens, created_at
            FROM request_logs
            WHERE {where_clause}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        """
        params.extend([page_size, offset])
        rows = conn.execute(query_sql, params).fetchall()

        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": (total + page_size - 1) // page_size,
            "data": [dict(row) for row in rows]
        }
    finally:
        conn.close()


def get_log_detail(log_id: int) -> Optional[Dict[str, Any]]:
    """获取单条日志详情"""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM request_logs WHERE id = ?", (log_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_stats(hours: int = 24) -> Dict[str, Any]:
    """获取统计信息"""
    conn = get_connection()
    try:
        # 计算时间范围
        time_threshold = (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")

        # 总请求数
        total = conn.execute(
            "SELECT COUNT(*) FROM request_logs WHERE timestamp >= ?",
            (time_threshold,)
        ).fetchone()[0]

        # 成功请求数
        success = conn.execute(
            "SELECT COUNT(*) FROM request_logs WHERE timestamp >= ? AND status_code = 200",
            (time_threshold,)
        ).fetchone()[0]

        # 平均耗时
        avg_duration = conn.execute(
            "SELECT AVG(duration_ms) FROM request_logs WHERE timestamp >= ? AND duration_ms IS NOT NULL",
            (time_threshold,)
        ).fetchone()[0] or 0

        # 使用打分规则的请求数
        with_rules = conn.execute(
            "SELECT COUNT(*) FROM request_logs WHERE timestamp >= ? AND use_scoring_rules = 1",
            (time_threshold,)
        ).fetchone()[0]

        # 按小时统计
        hourly = conn.execute("""
            SELECT strftime('%Y-%m-%d %H:00', timestamp) as hour, COUNT(*) as count
            FROM request_logs
            WHERE timestamp >= ?
            GROUP BY hour
            ORDER BY hour DESC
            LIMIT 24
        """, (time_threshold,)).fetchall()

        # 按 IP 统计（Top 10）
        top_ips = conn.execute("""
            SELECT client_ip, COUNT(*) as count
            FROM request_logs
            WHERE timestamp >= ?
            GROUP BY client_ip
            ORDER BY count DESC
            LIMIT 10
        """, (time_threshold,)).fetchall()

        # 按状态码统计
        status_dist = conn.execute("""
            SELECT status_code, COUNT(*) as count
            FROM request_logs
            WHERE timestamp >= ?
            GROUP BY status_code
            ORDER BY count DESC
        """, (time_threshold,)).fetchall()

        return {
            "hours": hours,
            "total_requests": total,
            "success_requests": success,
            "success_rate": round(success / total * 100, 2) if total > 0 else 0,
            "avg_duration_ms": round(avg_duration, 2),
            "with_scoring_rules": with_rules,
            "hourly_stats": [dict(row) for row in hourly],
            "top_ips": [dict(row) for row in top_ips],
            "status_distribution": [dict(row) for row in status_dist]
        }
    finally:
        conn.close()


# 模块加载时初始化数据库
init_db()
