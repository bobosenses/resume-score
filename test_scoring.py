#!/usr/bin/env python3
"""
简历打分测试脚本 - 使用 test_cases.json 中的测试数据
"""

import json
import requests
import time
from typing import Optional

# API 配置
API_BASE = "http://127.0.0.1:8000/v1"
WEB_API_BASE = "http://127.0.0.1:3000"
MODEL = "models/Qwen3-8B-AWQ"


def load_test_cases(file_path: str = "/root/vLLM/test_cases.json"):
    """加载测试用例"""
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_scoring_prompt(resume: str, jd: str, rules: str) -> str:
    """构建完整的打分 prompt"""
    return f"""你是一位资深HR和技术面试官，拥有15年互联网行业人才评估经验。请严格按照打分规则对候选人进行客观、公正的评估。

=== 候选人简历 ===
{resume}

=== 职位描述(JD) ===
{jd}

=== 打分规则 ===
{rules}"""


def score_resume_via_web_api(
    resume: str,
    jd: str,
    rules: str,
    thinking: bool = False,
    max_tokens: int = 2000,
    temperature: float = 0.1,
    stream: bool = False,
) -> dict:
    """
    通过 Web API (端口 3000) 进行简历打分

    Args:
        resume: 简历内容
        jd: 职位描述
        rules: 打分规则
        thinking: 是否启用思考模式
        max_tokens: 最大输出 token 数
        temperature: 采样温度
        stream: 是否流式输出

    Returns:
        dict: 包含评分结果和统计信息
    """
    prompt = build_scoring_prompt(resume, jd, rules)

    start_time = time.time()

    if stream:
        # 流式输出
        resp = requests.post(
            f"{WEB_API_BASE}/api/generate",
            json={
                "prompt": prompt,
                "stream": True,
                "thinking": thinking,
                "options": {"temperature": temperature, "num_predict": max_tokens},
            },
            stream=True,
        )

        full_text = ""
        for line in resp.iter_lines():
            if line:
                try:
                    data = json.loads(line)
                    if data.get("response"):
                        full_text += data["response"]
                        print(data["response"], end="", flush=True)
                except json.JSONDecodeError:
                    continue
        print()  # 换行

    else:
        # 非流式输出
        resp = requests.post(
            f"{WEB_API_BASE}/api/generate",
            json={
                "prompt": prompt,
                "stream": False,
                "thinking": thinking,
                "options": {"temperature": temperature, "num_predict": max_tokens},
            },
        )

        result = []
        for line in resp.text.strip().split("\n"):
            if line.strip():
                try:
                    chunk = json.loads(line)
                    if chunk.get("response"):
                        result.append(chunk["response"])
                except json.JSONDecodeError:
                    continue
        full_text = "".join(result)

    elapsed = time.time() - start_time

    return {
        "content": full_text,
        "elapsed_seconds": elapsed,
        "char_count": len(full_text),
        "thinking_mode": thinking,
    }


def score_resume_via_vllm_api(
    resume: str,
    jd: str,
    rules: str,
    thinking: bool = False,
    max_tokens: int = 2000,
    temperature: float = 0.1,
) -> dict:
    """
    直接通过 vLLM API (端口 8000) 进行简历打分

    Args:
        resume: 简历内容
        jd: 职位描述
        rules: 打分规则
        thinking: 是否启用思考模式
        max_tokens: 最大输出 token 数
        temperature: 采样温度

    Returns:
        dict: 包含评分结果和统计信息
    """
    prompt = build_scoring_prompt(resume, jd, rules)

    start_time = time.time()

    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "system",
                "content": "你是一位资深HR和技术面试官，严格按照评分规则进行客观评估。",
            },
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }

    if thinking:
        payload["chat_template_kwargs"] = {"enable_thinking": True}

    resp = requests.post(f"{API_BASE}/chat/completions", json=payload)
    result = resp.json()

    content = result["choices"][0]["message"]["content"]
    elapsed = time.time() - start_time

    return {
        "content": content,
        "elapsed_seconds": elapsed,
        "char_count": len(content),
        "thinking_mode": thinking,
        "prompt_tokens": result.get("usage", {}).get("prompt_tokens", 0),
        "completion_tokens": result.get("usage", {}).get("completion_tokens", 0),
    }


def extract_score(result_text: str) -> Optional[int]:
    """从结果文本中提取总分"""
    import re

    # 尝试匹配 "总分：XX/100" 格式
    match = re.search(r"总分[：:]\s*(\d+)", result_text)
    if match:
        return int(match.group(1))

    # 尝试匹配 JSON 格式中的 finalScore
    try:
        json_match = re.search(r"\{.*\}", result_text, re.DOTALL)
        if json_match:
            data = json.loads(json_match.group())
            if "finalScore" in data:
                return int(data["finalScore"])
    except:
        pass

    return None


def run_test_cases(
    api_type: str = "web",
    thinking: bool = False,
    resume_ids: Optional[list] = None,
    max_tokens: int = 2000,
):
    """
    运行测试用例

    Args:
        api_type: "web" 或 "vllm"
        thinking: 是否启用思考模式
        resume_ids: 指定测试的简历 ID 列表，None 表示全部
        max_tokens: 最大输出 token 数
    """
    test_data = load_test_cases()

    jd = test_data["test_cases"]["jd"]["content"]
    rules = test_data["test_cases"]["scoring_rules"]["content"]
    resumes = test_data["test_cases"]["resumes"]

    if resume_ids:
        resumes = [r for r in resumes if r["id"] in resume_ids]

    print("=" * 80)
    print(f"简历打分测试 - API: {api_type.upper()} | 思考模式: {'开启' if thinking else '关闭'}")
    print("=" * 80)
    print()

    results = []

    for resume in resumes:
        print(f"【{resume['name']}】{resume['profile']}")
        print(f"预期分数范围: {resume['expected_score_range']}")
        print("-" * 80)

        try:
            if api_type == "web":
                result = score_resume_via_web_api(
                    resume["content"], jd, rules,
                    thinking=thinking, max_tokens=max_tokens, stream=False,
                )
            else:
                result = score_resume_via_vllm_api(
                    resume["content"], jd, rules,
                    thinking=thinking, max_tokens=max_tokens,
                )

            actual_score = extract_score(result["content"])

            print(f"评分结果:")
            print(result["content"])
            print()
            print(f"统计信息:")
            print(f"  - 耗时: {result['elapsed_seconds']:.1f} 秒")
            print(f"  - 输出长度: {result['char_count']} 字符")
            if "prompt_tokens" in result:
                print(f"  - Prompt tokens: {result['prompt_tokens']}")
                print(f"  - Completion tokens: {result['completion_tokens']}")

            if actual_score:
                print(f"  - 提取分数: {actual_score}/100")
            else:
                print(f"  - 提取分数: 未找到")

            results.append({
                "resume_id": resume["id"],
                "name": resume["name"],
                "expected_range": resume["expected_score_range"],
                "actual_score": actual_score,
                "elapsed": result["elapsed_seconds"],
                "content": result["content"],
            })

        except Exception as e:
            print(f"错误: {e}")
            results.append({
                "resume_id": resume["id"],
                "name": resume["name"],
                "error": str(e),
            })

        print()
        print("=" * 80)
        print()

    # 打印汇总
    print("\n" + "=" * 80)
    print("测试汇总")
    print("=" * 80)
    print(f"{'姓名':<10} {'预期范围':<15} {'实际分数':<10} {'耗时(秒)':<10} {'状态':<10}")
    print("-" * 80)

    for r in results:
        if "error" in r:
            print(f"{r['name']:<10} {r['expected_range']:<15} {'错误':<10} {'-':<10} {'❌':<10}")
        else:
            score_str = f"{r['actual_score']}/100" if r['actual_score'] else "未提取"
            print(f"{r['name']:<10} {r['expected_range']:<15} {score_str:<10} {r['elapsed']:<10.1f} {'✅':<10}")

    print("=" * 80)

    return results


def batch_test_comparison():
    """批量测试：对比思考模式开启/关闭的差异"""
    test_data = load_test_cases()

    jd = test_data["test_cases"]["jd"]["content"]
    rules = test_data["test_cases"]["scoring_rules"]["content"]
    resumes = test_data["test_cases"]["resumes"]

    print("=" * 80)
    print("批量对比测试：思考模式 vs 非思考模式")
    print("=" * 80)
    print()

    comparison_results = []

    for resume in resumes:
        print(f"【{resume['name']}】{resume['profile']}")
        print(f"预期分数: {resume['expected_score_range']}")
        print("-" * 80)

        # 关闭思考模式
        print("1. 关闭思考模式...")
        result_off = score_resume_via_web_api(
            resume["content"], jd, rules,
            thinking=False, max_tokens=2000,
        )
        score_off = extract_score(result_off["content"])

        # 开启思考模式
        print("2. 开启思考模式...")
        result_on = score_resume_via_web_api(
            resume["content"], jd, rules,
            thinking=True, max_tokens=3000,
        )
        score_on = extract_score(result_on["content"])

        print(f"\n对比结果:")
        print(f"  关闭思考: {score_off}/100 (耗时 {result_off['elapsed_seconds']:.1f}秒, {result_off['char_count']}字符)")
        print(f"  开启思考: {score_on}/100 (耗时 {result_on['elapsed_seconds']:.1f}秒, {result_on['char_count']}字符)")

        if score_off and score_on:
            diff = score_on - score_off
            print(f"  分数差异: {diff:+d}")

        comparison_results.append({
            "name": resume["name"],
            "expected": resume["expected_score_range"],
            "score_off": score_off,
            "score_on": score_on,
            "time_off": result_off["elapsed_seconds"],
            "time_on": result_on["elapsed_seconds"],
        })

        print()

    # 汇总表格
    print("\n" + "=" * 80)
    print("对比汇总")
    print("=" * 80)
    print(f"{'姓名':<10} {'预期':<12} {'关闭思考':<10} {'开启思考':<10} {'差异':<8} {'耗时对比':<15}")
    print("-" * 80)

    for r in comparison_results:
        score_off = f"{r['score_off']}" if r['score_off'] else "-"
        score_on = f"{r['score_on']}" if r['score_on'] else "-"
        diff = f"{r['score_on'] - r['score_off']:+d}" if r['score_off'] and r['score_on'] else "-"
        time_ratio = f"{r['time_off']:.1f}s vs {r['time_on']:.1f}s"
        print(f"{r['name']:<10} {r['expected']:<12} {score_off:<10} {score_on:<10} {diff:<8} {time_ratio:<15}")

    print("=" * 80)

    return comparison_results


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="简历打分测试脚本")
    parser.add_argument("--api", choices=["web", "vllm"], default="web", help="API 类型")
    parser.add_argument("--thinking", action="store_true", help="启用思考模式")
    parser.add_argument("--resume-ids", type=int, nargs="+", help="指定简历 ID")
    parser.add_argument("--max-tokens", type=int, default=2000, help="最大输出 token 数")
    parser.add_argument("--compare", action="store_true", help="对比测试（思考模式开启/关闭）")

    args = parser.parse_args()

    if args.compare:
        batch_test_comparison()
    else:
        run_test_cases(
            api_type=args.api,
            thinking=args.thinking,
            resume_ids=args.resume_ids,
            max_tokens=args.max_tokens,
        )
