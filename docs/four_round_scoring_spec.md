# 4 轮打分规则与输出样例

> 接口：`POST /api/score-multi-round`（SSE 流，每轮一个 `step` 事件）
> 模型：Qwen3-8B（vLLM）
> 总耗时：~11.7 s/简历（10 ~ 15s 区间）
> 实际不读 `scoring_rules.json`，所有规则硬编码在 `web/server.js`

---

## R1 简历信息提取

- **位置**：`web/server.js:1158`
- **max_tokens**：600
- **变量名**：`SYS1`

### 系统提示词

```
你是简历信息提取专家。输出紧凑JSON（无空格无换行），不要额外文字。

提取要点：
- 行业：从公司业务/产品领域推断（汽车/半导体/互联网/金融等）
- mainProduct：最近工作的核心产品/系统名称（非公司名），20字内
- mainProductDetail：1句话描述产品做什么+核心技术，50字内
- mainFunction：核心职能方向（如"大模型开发""嵌入式开发"），非职位Title，15字内
- mainFunctionDetail：职能工作内容+技术栈，50字内
- otherProducts：历史其他产品线，最多5个，每个20字内，不重复
- 无法确定填"未知"

JSON格式：{"industry":"","mainProduct":"","mainProductDetail":"","otherProducts":[],
"mainFunction":"","mainFunctionDetail":"","totalYears":0,"age":0,"latestCompany":"",
"latestPosition":"","education":"","school":"","jobCount":0,"avgTenure":0,
"hasGap":false,"spcMention":false,"workLocation":"","willingToRelocate":false}
```

### 用户消息

```
提取简历信息：

<resumeText 全文>
```

### 输出样例

```json
{
  "industry": "汽车电子",
  "mainProduct": "电池管理系统(BMS)",
  "mainProductDetail": "新能源汽车动力电池管理软件，AUTOSAR架构+Simulink仿真",
  "otherProducts": ["车载充电机OBC", "DC-DC变换器"],
  "mainFunction": "嵌入式软件开发",
  "mainFunctionDetail": "BMS底层驱动+CAN通信+功能安全ISO26262",
  "totalYears": 6,
  "age": 30,
  "latestCompany": "宁德时代",
  "latestPosition": "高级嵌入式工程师",
  "education": "硕士",
  "school": "西安交大",
  "jobCount": 2,
  "avgTenure": 3,
  "hasGap": false,
  "spcMention": false,
  "workLocation": "上海/苏州",
  "willingToRelocate": false
}
```

---

## R2 产品匹配判断

- **位置**：`web/server.js:1160`
- **max_tokens**：360
- **变量名**：`SYS2`（= `SYS2_BASE` + 语义对照表）

### 系统提示词

```
你是产品匹配判断专家。
规则：候选人产品名可能与JD产品名不同（别名/同义词），请参考对照表模糊匹配。
候选人任职JD目标公司且职位相关可适度放宽。必须有实际工作内容才算匹配。
评分：产品主线+有工作内容+行业匹配=20分；产品+工作内容+行业不匹配=10分；
行业匹配+仅提及=5分；不匹配=0分
多产品扣分：1条不扣；2条-5分；≥3条-10分。
连续性：近1年主线不扣；新切入-5分；跨域-10分
输出JSON（reasoning限20字）：
{"productScore":分,"matchLevel":"Match/Partial/Mismatch","reasoning":"简短依据",
"multiProductDeduct":扣分,"continuityDeduct":扣分}

【产品名对照表（JD产品名 → 别名/同义词）】
<semanticCache.product 加载自 MySQL semantic_mappings>
```

### 用户消息（拼装）

```
JD产品：<jd.产品>
JD行业：<jd.行业>
JD目标公司：<targetCompanies>
JD工作职责：<jd.工作职责>
JD原始要求：<jd.原始要求>

【候选人提取信息】
行业=<info.industry>
主线产品=<info.mainProduct>
工作内容=<info.mainProductDetail>
其他产品=<otherProducts join('、')>
最近公司=<info.latestCompany>
最近职位=<info.latestPosition>

【候选人原始简历（参考，以提取信息为准）】
<resumeText 截前 2000 字>
```

### 输出样例

```json
{
  "productScore": 20,
  "matchLevel": "Match",
  "reasoning": "BMS=电池管理系统，产品方向一致",
  "multiProductDeduct": 0,
  "continuityDeduct": 0
}
```

---

## R3 职能匹配判断

- **位置**：`web/server.js:1162`
- **max_tokens**：360
- **变量名**：`SYS3`（= `SYS3_BASE` + 语义对照表）

### 系统提示词

```
你是职能匹配判断专家。
规则：候选人职能可能与JD职能名称不同，参考对照表判断是否为相邻职能。
评分：主线职能完全匹配=20分；相邻职能=10分；次要参与=5分；边缘/无关=0分
输出JSON（reasoning限20字）：
{"functionScore":分,"matchLevel":"Match/Partial/Mismatch","reasoning":"简短依据"}

【职能对照表（JD职能名 → 相邻职能）】
<semanticCache.function 加载自 MySQL semantic_mappings>
```

### 用户消息（拼装）

```
JD职位：<jd.职位名称>
JD职责：<jd.工作职责>

【候选人提取信息】
职能=<info.mainFunction>
职能内容=<info.mainFunctionDetail>
职位=<info.latestPosition>

【候选人原始简历（参考，以提取信息为准）】
<resumeText 截前 2000 字>
```

### 输出样例

```json
{
  "functionScore": 20,
  "matchLevel": "Match",
  "reasoning": "嵌入式开发≈BMS软件开发"
}
```

---

## R4 逐项打分

- **位置**：`web/server.js:1165`
- **max_tokens**：720
- **变量名**：`SYS4`

### 系统提示词

```
你是简历评估助手。下面给你JD的每条硬性要求和候选人的对应信息，请逐条对比判断是否满足。

规则：
- 工作年限：看候选人实际工作年限是否在JD要求范围内
- 年龄：看候选人年龄是否在JD要求范围内
- 学历：本科<硕士<博士，高于要求算满足
- 跳槽频率：看候选人近5年工作段数是否超过JD上限
- 目标公司：看候选人当前公司是否在JD目标公司列表中（模糊匹配）
- 工作地点：只要候选人意向城市中包含JD要求的任一城市即算满足
- 产品/职能：参考已评估结果，Match即满足

输出严格JSON（每条item只需name+met，不要输出jd和candidate）：
{"items":[{"name":"项目名","met":true/false},...],
"continuityScore":10或5或0,"educationScore":10或5或0,
"preferMet":"all/partial/none",
"jobHoppingStability":"stable/normal/unstable"}
```

### 用户消息（拼装）

```
请逐条对比以下JD要求与候选人信息，判断每条是否满足：

【JD硬性要求 vs 候选人信息】
1. 行业：JD要求="..." | 候选人行业="..."
2. 产品：JD要求="..." | 候选人主线产品="..."
3. 工作年限：JD要求=3-8年 | 候选人=6年
4. 年龄：JD要求=25-35岁 | 候选人=30岁
5. 学历：JD要求="本科" | 候选人="硕士"
6. 职级：JD要求="高级" | 候选人职级="高级嵌入式工程师"
   （职级对照参考：
   工程师 → Engineer、Mid
   高级工程师 → Senior、Sr Engineer
   ...
   ）
7. 职位：JD要求="嵌入式工程师" | 候选人职位="高级嵌入式工程师"
8. 跳槽频率：JD要求="近5年≤3段" | 候选人近5年2段，平均3年/段
9. 工作地点：JD要求="上海" | 候选人="上海/苏州"
10. 目标公司：JD目标公司="宁德/比亚迪/蜂巢" | 候选人当前公司="宁德时代"
11. SPC技能：JD要求有SPC | 候选人=未提及

【已评估维度】
产品匹配=20分(Match) BMS=电池管理系统，产品方向一致
职能匹配=20分(Match) 嵌入式开发≈BMS软件开发

请逐条判断每项是否满足(met=true/false)，输出JSON。
```

### 输出样例

```json
{
  "items": [
    {"name": "行业",        "met": true},
    {"name": "产品",        "met": true},
    {"name": "工作年限",     "met": true},
    {"name": "年龄",        "met": true},
    {"name": "学历",        "met": true},
    {"name": "职级",        "met": true},
    {"name": "职位",        "met": true},
    {"name": "跳槽频率",     "met": true},
    {"name": "工作地点",     "met": true},
    {"name": "目标公司",     "met": true},
    {"name": "SPC技能",     "met": false}
  ],
  "continuityScore": 10,
  "educationScore": 10,
  "preferMet": "partial",
  "jobHoppingStability": "stable"
}
```

---

## R4 之后：代码计算最终总分

> 这一步**不调用模型**，全部由 `server.js:1257-1582` 的 JS 逻辑完成。
> R4 给出的 `items[].met` 被代码逐条覆盖（地点/目标公司/年限/年龄/学历/职级/职位/跳槽频率均由代码兜底判定，避免 LLM 算错）。

### 主要计算（节选）

```js
baseScore   = productScore(20) + functionScore(20) + continuityScore(10) + educationScore(10)
mustPct     = metCount / totalCount * 100         // Must 满足率
gatePath    = mustPct<30 || (!prodMatch&&!funcMatch) ? 'Mismatch'
            : mustPct<60 || (prodMatch XOR funcMatch) ? 'Partial' : 'Match'

bonusScore  = (targetMet ? 20/10 : 0)
            + (preferMet=='all' ? 10 : preferMet=='partial' ? 5 : 0)
            + (hop=='stable' ? 5 : hop=='normal' ? 2 : 0)
            + (prodMatch && funcMatch ? 5 : 0)
            + (locationMet ? 5 : 0)

deductScore = gatePath != 'Mismatch' ? missingItems.length * 2 : 0
expPenalty  = expGap >= 3 ? 20 : expGap >= 1 ? 10 : expGap > 0 ? 3 : 0

finalScore  = baseScore + bonusScore - deductScore - expPenalty
            // 路径封顶
            (Partial ? min 59 ; Mismatch ? min 30)
            // Must 缺失封顶
            (missing>=3 ? min 79 ; missing>=1 ? min 95)
            // [0,100] 裁剪
```

### 评级

| finalScore | overallRecommendation |
|---|---|
| ≥ 80 | 强烈推荐 |
| 60-79 | 推荐 |
| 50-59 | 需电话确认 |
| 40-49 | 需人工查看 |
| 20-39 | 不建议联系 |
| 0-19 | 不需要联系 |

### 最终对外输出

```json
{
  "finalScore": 92,
  "reasons": [
    "产品匹配：候选人电池管理系统(BMS)方向与JD要求的BMS一致",
    "职能匹配：候选人BMS底层驱动+CAN通信+功能安全ISO26262，直接匹配JD嵌入式工程师岗位要求",
    "目标公司匹配：候选人当前在宁德时代任职",
    "不满足项：SPC技能"
  ],
  "overallRecommendation": "强烈推荐"
}
```

---

## Token 预算汇总

| 轮次 | 任务 | max_tokens | 典型输出 tokens | 备注 |
|---|---|---|---|---|
| R1 | 信息提取 | 600 | 250-400 | 17 个字段 JSON |
| R2 | 产品匹配 | 360 | 80-150 | 5 字段 + 短 reasoning |
| R3 | 职能匹配 | 360 | 60-120 | 3 字段 + 短 reasoning |
| R4 | 逐项打分 | 720 | 300-500 | 11 items + 4 meta |
| **合计** | | **2040** | **~700-1200** | 4 次串行调用 |

并行情况：R2、R3 已确认**串行**（`server.js:1198/1204/1211`），R4 必须等 R1+R2+R3 结果。

---

## 与 scoring_rules.json 的差距

`config/scoring_rules.json` 中描述的规则（Layer0/1/2/3、产品方向边界、职能分层、主线三标准、AI 铁律 10 条）**完全没有注入**到 SYS1-SYS4。

| scoring_rules 规则 | 当前实现 |
|---|---|
| Layer0 首层门槛（产品+职能+职级+行业 4×25 = 100 模块分，<70 锁定 30） | ❌ 未实现 |
| Layer1 硬性项校验（任一不达标终止加分） | ⚠️ 部分（只有 expPenalty） |
| Layer2 加分项（Must 加减、Prefer、目标公司） | ⚠️ 简化版 |
| Layer3 后置扣分（薪资、跳槽） | ⚠️ 只有 stable/normal/unstable |
| 产品方向边界（同方向/不同方向举例） | ❌ SYS2 未注入 |
| 职能分类边界（研发/营销/职能） | ❌ SYS3 未注入 |
| 主线三标准（≥50% 篇幅、核心主导、≥60% 时长） | ❌ 未实现 |
| 非主线最高 10 分、边缘 0 分 | ❌ 未实现 |
| Match/Partial 每缺 1 Must 扣 3 分 | ❌ 当前是 2 分 |
| 产品+职能任一不匹配 → 总分 ≤ 30 | ✅ 已实现（gatePath=Mismatch） |
