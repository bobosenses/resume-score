#!/usr/bin/env python3
"""
AWQ 模型并发压测脚本
逐步增加并发数，测试极限吞吐
"""

import json
import requests
import time
import threading
import sys
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Optional

# API 配置
API_BASE = "http://127.0.0.1:8000/v1"
MODEL = "models/Qwen3-8B-AWQ"

# 加载测试用例
with open("/root/vLLM/test_cases.json", "r", encoding="utf-8") as f:
    test_data = json.load(f)

resumes = test_data["test_cases"]["resumes"]
jd = test_data["test_cases"]["jd"]["content"]
rules = test_data["test_cases"]["scoring_rules"]["content"]

# 使用李明远（AI 产品总监，最长的简历，~3400 tokens prompt）
RESUME = resumes[0]["content"]

def build_prompt(resume, jd, rules):
    return f"""你是一位资深HR和技术面试官，拥有15年互联网行业人才评估经验。请严格按照打分规则对候选人进行客观、公正的评估。

=== 候选人简历 ===
{resume}

=== 职位描述(JD) ===
{jd}

=== 打分规则 ===
{rules}"""

PROMPT = build_prompt(RESUME, jd, rules)

@dataclass
class Result:
    success: bool
    elapsed: float = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    error: str = ""
    completion_text: str = ""

def single_request(timeout=600):
    """发送一次打分请求"""
    start = time.time()
    try:
        payload = {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": "你是一位资深HR和技术面试官，严格按照评分规则进行客观评估。"},
                {"role": "user", "content": PROMPT},
            ],
            "max_tokens": 2000,
            "temperature": 0.1,
            "stream": False,
        }

        resp = requests.post(f"{API_BASE}/chat/completions", json=payload, timeout=timeout)
        result = resp.json()

        elapsed = time.time() - start

        if "choices" not in result:
            return Result(success=False, elapsed=elapsed, error=f"no choices: {result.get('error', 'unknown')}")

        content = result["choices"][0]["message"]["content"]
        # 去掉 think 部分
        clean = re.sub(r'<think>.*?</think>', '', content, flags=re.DOTALL).strip()
        usage = result.get("usage", {})

        return Result(
            success=True,
            elapsed=elapsed,
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            completion_text=clean[:100],
        )
    except Exception as e:
        elapsed = time.time() - start
        return Result(success=False, elapsed=elapsed, error=str(e))


def warm_up():
    """预热一次"""
    print("🔧 预热中...", end=" ", flush=True)
    r = single_request()
    if r.success:
        print(f"✅ 完成 ({r.completion_tokens} tok, {r.elapsed:.1f}s)")
    else:
        print(f"⚠️  {r.error}")
    return r


def run_concurrency_test(concurrency, num_requests):
    """
    在指定并发数下运行 num_requests 个请求
    """
    print(f"\n{'='*60}")
    print(f"🚀 并发测试: concurrency={concurrency}, total_requests={num_requests}")
    print(f"{'='*60}")

    results = []
    completed = 0
    lock = threading.Lock()

    def worker():
        nonlocal completed
        r = single_request(timeout=600)
        with lock:
            results.append(r)
            completed += 1
            if completed % 5 == 0 or completed == num_requests:
                elapsed_sofar = time.time() - test_start
                ok = sum(1 for x in results if x.success)
                fail = len(results) - ok
                print(f"  进度: {completed}/{num_requests} | OK={ok} FAIL={fail} | 耗时={elapsed_sofar:.1f}s")

    test_start = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(worker) for _ in range(num_requests)]
        for f in as_completed(futures):
            f.result()  # 确保异常被捕获

    total_time = time.time() - test_start
    success_count = sum(1 for r in results if r.success)
    fail_count = len(results) - success_count
    total_elapsed = sum(r.elapsed for r in results if r.success)
    total_prompt = sum(r.prompt_tokens for r in results if r.success)
    total_completion = sum(r.completion_tokens for r in results if r.success)

    avg_latency = total_elapsed / success_count if success_count else 0
    qps = success_count / total_time if total_time > 0 else 0
    avg_prompt_tok = total_prompt / success_count if success_count else 0
    avg_compl_tok = total_completion / success_count if success_count else 0
    total_tokens = total_prompt + total_completion
    token_throughput = total_tokens / total_time if total_time > 0 else 0

    print(f"\n{'─'*60}")
    print(f"📊 结果汇总 (concurrency={concurrency}):")
    print(f"  {'总耗时':<15} {total_time:<8.1f}s")
    print(f"  {'成功/总数':<15} {success_count}/{len(results)}")
    print(f"  {'成功率':<15} {success_count/max(len(results),1)*100:.1f}%")
    print(f"  {'平均延迟':<15} {avg_latency:<8.1f}s")
    print(f"  {'P50 延迟':<15} {sorted([r.elapsed for r in results if r.success])[max(success_count//2-1,0)]:<8.1f}s" if success_count > 0 else "")
    print(f"  {'QPS (请求/秒)':<15} {qps:<8.2f}")
    print(f"  {'平均 Prompt tok':<15} {avg_prompt_tok:<8.0f}")
    print(f"  {'平均 Completion tok':<15} {avg_compl_tok:<8.0f}")
    print(f"  {'Token 吞吐 (tok/s)':<15} {token_throughput:<8.1f}")
    if fail_count > 0:
        print(f"\n  ❌ 错误详情:")
        for r in results:
            if not r.success:
                print(f"     {r.error} ({r.elapsed:.1f}s)")

    return {
        "concurrency": concurrency,
        "total_time": total_time,
        "success": success_count,
        "fail": fail_count,
        "avg_latency": avg_latency,
        "qps": qps,
        "avg_prompt_tok": avg_prompt_tok,
        "avg_compl_tok": avg_compl_tok,
        "token_throughput": token_throughput,
    }


# ========== 主流程 ==========
if __name__ == "__main__":
    print("=" * 60)
    print("  AWQ 模型并发压力测试")
    print(f"  模型: {MODEL}")
    print(f"  Prompt: ~3400 tokens (李明远简历)")
    print(f"  Max tokens: 2000")
    print(f"  非思考模式")
    print("=" * 60)

    # 预热
    warm_up()

    # 并发级别
    concurrency_levels = [1, 2, 4, 6, 8, 12, 16, 24, 32]
    requests_per_level = 12  # 每个并发级别发 12 个请求

    all_results = []

    for conc in concurrency_levels:
        summary = run_concurrency_test(conc, min(requests_per_level, 20))
        all_results.append(summary)

        # 如果失败率太高，提前停止
        total = summary["success"] + summary["fail"]
        fail_rate = summary["fail"] / total if total > 0 else 0
        if fail_rate > 0.5 and conc > 4:
            print(f"\n⚠️  失败率 {fail_rate*100:.0f}% > 50%，停止测试")
            break

        # 层间休息
        print("  休息 5 秒...")
        time.sleep(5)

    # 汇总对比
    print("\n" + "=" * 70)
    print("📈 最终汇总 — 各并发等级对比")
    print("=" * 70)
    print(f"{'并发':>6} | {'QPS':>8} | {'成功率':>8} | {'平均延迟':>10} | {'Token/s':>10} | {'Avg Compl Tok':>14}")
    print("-" * 70)
    for r in all_results:
        rate = r["success"] / max(r["success"] + r["fail"], 1) * 100
        print(f"{r['concurrency']:>6} | {r['qps']:>8.2f} | {rate:>7.1f}% | {r['avg_latency']:>9.1f}s | {r['token_throughput']:>9.0f} | {r['avg_compl_tok']:>13.0f}")
    print("=" * 70)
