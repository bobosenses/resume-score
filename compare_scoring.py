#!/usr/bin/env python3
"""
批量对比打分测试：读取CSV前50条简历，用新版打分API重打分，对比新旧分数
"""
import csv, json, requests, time, re, sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

WEB_BASE = "http://127.0.0.1:3000"
JD_TEXT = None
TARGET_COMPANIES = None
lock = Lock()
results = []
errors = []

# ========== 第一步：加载项目 JD ==========
def load_project():
    global JD_TEXT, TARGET_COMPANIES
    resp = requests.get(f"{WEB_BASE}/api/db/project-jd?projectId=2062431386453741570", timeout=30)
    data = resp.json()
    JD_TEXT = data.get('fullJd', '')
    TARGET_COMPANIES = data.get('targetCompanyText', '')
    print(f"JD加载完成 ({len(JD_TEXT)} chars)")
    print(f"目标公司: {TARGET_COMPANIES[:80]}")
    return data

# ========== 第二步：加载简历内容 ==========
def load_resume(resume_id):
    try:
        resp = requests.get(f"{WEB_BASE}/api/db/resume?resumeId={resume_id}", timeout=30)
        data = resp.json()
        return data.get('content', ''), None
    except Exception as e:
        return None, str(e)

# ========== 第三步：调用多轮打分API ==========
def call_scoring(resume_id, resume_text, idx, total):
    global JD_TEXT, TARGET_COMPANIES
    try:
        resp = requests.post(
            f"{WEB_BASE}/api/score-multi-round",
            json={
                "jdText": JD_TEXT,
                "resumeText": resume_text,
                "rules": "",
                "targetCompanies": TARGET_COMPANIES,
            },
            timeout=600,
            stream=True
        )
        # 解析 SSE
        final_result = None
        buffer = ""
        for chunk in resp.iter_content(chunk_size=1024, decode_unicode=True):
            if not chunk:
                continue
            buffer += chunk
            while '\n\n' in buffer:
                block, buffer = buffer.split('\n\n', 1)
                event_type = ''
                data_line = ''
                for line in block.split('\n'):
                    if line.startswith('event: '):
                        event_type = line[7:]
                    elif line.startswith('data: '):
                        data_line = line[6:]
                if data_line and event_type == 'done':
                    try:
                        data = json.loads(data_line)
                        fs = data.get('finalScore')
                        if fs and isinstance(fs, dict) and 'finalScore' in fs:
                            final_result = fs
                    except:
                        pass
        if not final_result:
            for line in buffer.split('\n'):
                if line.startswith('data: '):
                    try:
                        data = json.loads(line[6:])
                        if isinstance(data, dict):
                            fs = data.get('finalScore')
                            if fs and isinstance(fs, dict) and 'finalScore' in fs:
                                final_result = fs
                    except:
                        pass
        return final_result, None
    except Exception as e:
        return None, str(e)

# ========== 主流程 ==========
def process_one(resume_id, old_score_str, old_result_str, idx, total):
    global results, errors
    try:
        old_result = json.loads(old_result_str) if old_result_str else {}
        old_final = old_result.get('finalScore', '?')
        old_rec = old_result.get('overallRecommendation', '?')
        
        # 加载简历
        resume_text, err = load_resume(resume_id)
        if err or not resume_text:
            results.append({
                'resume_id': resume_id,
                'old_score': old_score_str,
                'old_final': old_final,
                'old_rec': old_rec,
                'new_final': 'ERROR',
                'new_rec': 'ERROR',
                'error': f'简历加载失败: {err}',
                'diff': 'ERR',
            })
            return
        
        # 调用打分
        final_result, err = call_scoring(resume_id, resume_text, idx, total)
        if err or not final_result:
            results.append({
                'resume_id': resume_id,
                'old_score': old_score_str,
                'old_final': old_final,
                'old_rec': old_rec,
                'new_final': 'ERROR',
                'new_rec': 'ERROR',
                'error': f'打分失败: {err}',
                'diff': 'ERR',
            })
            return
        
        new_final = final_result.get('finalScore', '?')
        new_rec = final_result.get('overallRecommendation', '?')
        
        diff = ''
        if isinstance(old_final, (int, float)) and isinstance(new_final, (int, float)):
            d = int(new_final - old_final)
            if d > 0: diff = f'+{d}'
            elif d < 0: diff = str(d)
            else: diff = '='
        
        results.append({
            'resume_id': resume_id,
            'old_score': old_score_str,
            'old_final': old_final,
            'old_rec': old_rec,
            'new_final': new_final,
            'new_rec': new_rec,
            'error': '',
            'diff': diff,
        })
        print(f"  [{idx}/{total}] {resume_id[:16]:>16} | 旧={old_final:>4} {old_rec:>4} | 新={new_final:>4} {new_rec:>4} | {diff:>4}")
        sys.stdout.flush()
    except Exception as e:
        results.append({
            'resume_id': resume_id,
            'old_score': old_score_str,
            'old_final': '?',
            'old_rec': '?',
            'new_final': 'ERROR',
            'new_rec': 'ERROR',
            'error': str(e),
            'diff': 'ERR',
        })


if __name__ == '__main__':
    print("=" * 80)
    print("批量对比测试：新版打分 vs CSV 旧版打分")
    print("=" * 80)
    
    # 1. 加载 JD
    print("\n[1/3] 加载项目JD...")
    load_project()
    
    # 2. 读取CSV取前50条
    print("\n[2/3] 读取CSV...")
    csv_path = "/root/vLLM/case/2062431386453741570打分情况.csv"
    rows = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            if i >= 50:
                break
            rows.append(row)
    
    print(f"共 {len(rows)} 条简历")
    
    # 3. 逐条打分（并发4个请求加速）
    print("\n[3/3] 开始打分（并发4个请求）...")
    start_time = time.time()
    
    total = len(rows)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = []
        for i, row in enumerate(rows):
            future = pool.submit(
                process_one,
                row['resume_id'],
                row['match_score'],
                row['match_result'],
                i+1, total
            )
            futures.append(future)
        for f in as_completed(futures):
            f.result()  # 确保异常被捕获
    
    total_time = time.time() - start_time
    
    # 4. 输出汇总
    print("\n\n" + "=" * 140)
    print("📊 打分对比汇总")
    print("=" * 140)
    print(f"{'序号':>4} | {'简历ID':>18} | {'旧分':>5} | {'旧推荐':>6} | {'新分':>5} | {'新推荐':>6} | {'差异':>5} | {'说明'}")
    print("-" * 140)
    
    same = 0
    up = 0
    down = 0
    err = 0
    
    for i, r in enumerate(results):
        seq = i + 1
        old_f = str(r['old_final'])
        new_f = str(r['new_final'])
        diff = r.get('diff', '?')
        error = r.get('error', '')
        note = error if error else ''
        
        if diff == '=': same += 1
        elif diff.startswith('+'): up += 1
        elif diff.startswith('-'): down += 1
        elif diff == 'ERR': err += 1
        
        print(f"{seq:>4} | {r['resume_id']:>18} | {old_f:>5} | {r['old_rec']:>6} | {new_f:>5} | {r['new_rec']:>6} | {diff:>5} | {note}")
    
    print("-" * 140)
    print(f"总比: {len(results)} | 相同: {same} | 提高: {up} | 降低: {down} | 错误: {err}")
    
    if up > 0 or down > 0:
        print("\n📋 有差异的项：")
        for r in results:
            d = r.get('diff', '?')
            if d not in ('=', '', 'ERR', '?'):
                print(f"  {r['resume_id']} | 旧={r['old_final']} ({r['old_rec']}) → 新={r['new_final']} ({r['new_rec']}) [{d}]")
    
    # 统计变化幅度
    scores_new = [r['new_final'] for r in results if isinstance(r['new_final'], (int, float))]
    scores_old = [r['old_final'] for r in results if isinstance(r['old_final'], (int, float))]
    
    if scores_new and scores_old:
        avg_old = sum(scores_old) / len(scores_old)
        avg_new = sum(scores_new) / len(scores_new)
        print(f"\n📈 平均分: 旧={avg_old:.1f} → 新={avg_new:.1f} (Δ={avg_new-avg_old:+.1f})")
    
    print(f"\n⏱  总耗时: {total_time:.0f}s (平均 {total_time/len(results):.1f}s/条)")
    print("=" * 140)
