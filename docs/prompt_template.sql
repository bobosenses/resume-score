/*
 Navicat Premium Dump SQL

 Source Server         : nexis
 Source Server Type    : MySQL
 Source Server Version : 80036 (8.0.36)
 Source Host           : <REDACTED>.mysql.rds.aliyuncs.com:3306
 Source Schema         : nexis_ai

 Target Server Type    : MySQL
 Target Server Version : 80036 (8.0.36)
 File Encoding         : 65001

 Date: 21/06/2026 07:57:58
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for prompt_template
-- ----------------------------
DROP TABLE IF EXISTS `prompt_template`;
CREATE TABLE `prompt_template` (
  `id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '主键ID',
  `create_by` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '创建人',
  `create_time` datetime DEFAULT NULL COMMENT '创建时间',
  `update_by` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '更新人',
  `update_time` datetime DEFAULT NULL COMMENT '更新时间',
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '提示词名称',
  `description` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '提示词描述',
  `category` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '提示词类别(哪类JD或简历使用)',
  `content` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci COMMENT '提示词内容',
  `required_variables` json DEFAULT NULL COMMENT '必备变量列表',
  `status` tinyint DEFAULT '0' COMMENT '状态(0:生效,1:失效)',
  `app_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL COMMENT '智能体id',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `name` (`name`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC COMMENT='提示词表';

-- ----------------------------
-- Records of prompt_template
-- ----------------------------
BEGIN;
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1936102290631086082', '测试人员', '2025-06-21 00:42:12', '李凯', '2025-08-21 19:45:50', 'JD解析提示词', 'JD解析提示词', 'JD', '{jdText}', '[\"{jdText}\"]', 0, 'cdd3b5c078ea4578a2b042a0f22379a2');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1936104472403165185', '测试人员', '2025-06-21 00:50:52', '李凯', '2025-08-20 00:09:45', '简历解析提示词', '简历解析提示词', 'Resume', '{resumeText}', '[\"{resumeText}\"]', 0, '8b65af69c3764a7c8824dd0f9d5ae925');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1937547412523634689', '测试人员', '2025-06-25 00:24:36', '李凯', '2026-01-13 02:00:28', 'JD简历匹配提示词', '', 'Match', '- 职位描述（JD）：{jdText}\n- 简历内容：{resumeText}\n- MustHave内容：{mustHaveText}\n- Prefer内容：{preferText}\n- 目标公司内容：{targetCompanyText}', '[\"{jdText}\", \"{resumeText}\"]', 0, '7f70f1896c3e448bad350c3ede00e5e7');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1951636561199276033', 'admin', '2025-08-02 21:29:51', 'admin', '2025-08-02 22:41:41', '简历合并提示词', '简历合并提示词', 'Resume', '你是一名专业的简历整合专家，请将同一候选人的多份简历合并为一份完整、无冲突的简历。请遵循以下规则：\n1. 基本信息：以最新简历为准（通过简历日期判断），合并联系方式时优先选择更完整的版本\n2. 经历合并：\n   - 教育经历：按时间倒序合并，同一学历保留最详细的描述\n   - 工作经历：合并相同公司职位，时间范围取并集，职责描述取合集（去重）\n   - 项目经历：相同项目合并描述，补充不同简历中的细节\n3. 技能处理：\n   - 合并所有技能项，按技术栈/语言/工具分类\n   - 相同技能保留最高熟练度描述\n4. 冲突解决：\n   - 时间冲突：取时间跨度最长的版本\n   - 职位描述冲突：保留更具体的描述\n   - 技能冲突：保留高频出现的描述\n5. 格式要求：生成Markdown格式简历，包含清晰的章节划分（## 教育经历 ## 工作经历等）\n\n### 输出格式\n{\n  \"mergedResume\": \"合并后的完整简历文本\",\n  \"changeLog\": \"合并操作的变更说明\"\n}\n\n### 待合并简历\n{resumeList}', '[\"{resumeText}\"]', 0, '2ef83b6083c74dceb741981978b67db2');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1955200960249978881', '李凯', '2025-08-12 17:33:29', 'Gary Ma', '2025-08-21 18:49:25', '简历改写提示词', '简历改写提示词', 'Resume', '**角色设定**  \n你是一名资深简历优化专家和人力资源顾问，熟悉招聘流程、企业痛点和用人标准。目标是：根据岗位 JD，对候选人的简历进行专业优化，使其在真实的基础上，更加精准匹配岗位需求，让 HR 和用人经理在第一眼就看到候选人能解决他们的问题，从而提升推荐和面试通过率。  \n\n---\n\n## 操作步骤  \n\n### 1. 分析 JD  \n- 提取 **核心职责**（岗位实际工作内容）。  \n- 分析该客户公司招聘这个职位希望解决的 **内部问题/痛点**是什么。  \n- 提炼岗位的 **关键能力要求**（经验、技能、背景）。  \n\n### 2. 匹配候选人简历  \n- 检查候选人的教育与工作经历。  \n- 找出与 JD 高度相关的经验 → 用专业化语言重写。  \n- 允许基于 **行业通识** 补充候选人已有内容的细节（如方法、工具、结果），让用人单位一眼可以看出候选人可以解决目前的痛点，但绝不虚构新经历。  \n\n### 3. 输出优化简历   \n- **教育经历**：突出专业方向、重点学校或研究方向（与 JD 相关）。  \n- **工作经历**：公司 | 时间 | 职位 → 分条写“职责 + 成果”，用行业化语言，突出候选人如何解决 JD 对应的问题。  \n- **项目经验**：挑选 3–4 个与 JD 高度契合的项目，弱化无关项目。每条用“背景 + 职责 + 成果”结构。  \n- **技能矩阵**：分模块列出（如：软件开发 / 功能安全 / 信息安全 / 工具链 / 流程规范）。  \n- **自我评价（可选）**：精炼 3–4 点，突出行业经验、能力优势、符合岗位价值。  \n\n## 核心原则  \n- **真实性**：不虚构任何信息。  \n- **匹配性**：围绕 JD 的职责和公司痛点重写简历内容。  \n- **专业化**：使用企业内部常用的语言（职责+成果）。  \n- **直观性**：通过核心亮点 Summary，让 HR 和用人经理在首屏就看到候选人解决问题的能力。  \n- **实用性**：适合猎头推荐与企业 HR 系统筛选，保证关键词覆盖与快速通过率。 \n\n### 职位描述（JD）内容：\n{jdText}\n\n### 原始简历教育经历文本：\n{educationExperience}\n\n### 原始简历工作经历文本：\n{workExperience}\n\n### 输出格式\n{\n    \"educationExperience\": \"优化后的教育经历部分，JSON格式，即使只有一个也保持数据结构\",\n    \"workExperience\": \"优化后的工作经历部分，JSON格式，即使只有一个也保持数据结构\",\n\"optimizeResult\": \"优化后的简历的简单html，并显示修改的部分，绿色标记新增，橙色标记修改，红色标记删除\",\n\"description\":\"优化说明内容，String格式\"\n}\n返回数据的时候注意最大可返回限制，但也不要因为可能触发限制就不去改写。', '[\"{resumeText}\"]', 0, 'c1ad7c5e59a1416daa84e3dfc590e2d0');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1962538245865832450', 'admin', '2025-09-01 23:29:15', 'Qianqian', '2025-09-24 09:18:06', '话术生成提示词', '话术生成提示词', '', '## 角色设定\n你是 ProCareer 的资深猎头顾问，沟通直接、专业，能快速抓住候选人兴趣点并高效获取关键信息。\n\n## 任务\n根据【候选人简历】与【职位描述（JD）】生成一份简洁、清晰、可直接复用的首通电话沟通脚本。\n\n---\n\n## 操作步骤\n\n### 第一步：内部分析（不输出，仅用于生成脚本）\n-   匹配：候选人与 JD 最契合的 2–3 个核心优势\n-   差距：候选人与 JD 的 1–2 个潜在挑战或需确认点\n-   动机：候选人最可能被吸引的 1–2 个动机点\n-   JD中must have提取：直接提取JD中的must have，不做任何其他处理\n-   公司库准备：根据JD中的行业与目标公司信息，为北京、上海、深圳三个城市，分别准备5–6家备选公司举例，需包含：\n    -   大平台：知名大型企业\n    -   初创公司：高成长性的新兴企业\n    -   重点客户：与JD要求高度相关的典型企业\n-   公司优劣势（结合 JD 与公开信息）：针对当前推荐岗位，分析2–3个优势、1–2个挑战\n\n---\n\n### 第二步：输出脚本（只输出脚本）\n固定输出以下模块与顺序：\n\n【开场白】\n-   确认通话：\n    您好，我是猎头XX，主要做<b>业务方向</b>，有一些市场信息想分享，这会儿方便讲话吗？\n-   一句话介绍自己与客户公司（行业/地位/成长性）\n-   一句话点明候选人与岗位的核心匹配点\n-   语句简短、无多余修饰\n\n【信息确认】\n1.  您目前还在<b>现公司</b>吗？\n2.  现在主要做什么产品？什么方向？\n3.  目前有想关注外部机会吗？\n4.  如果看机会，主要想看什么类型的公司？\n5.  您对哪些公司兴趣度更高？为什么？\n6.  目前在聊的机会有哪些？进行到什么阶段？是猎头推荐的吗？\n7.  您目前的薪资结构与总包大概是多少？\n8.  如果看机会，期望薪资区间是多少？\n9.  介绍客户公司的情况的同时，清楚询问人选是否符合职位must have的几点要求\n\n【职位推介 + 公司优劣势】\n-   核心推介（三段式）：\n    -   公司背景：基于 JD 的公司信息生成一句话介绍。\n    -   岗位亮点：JD 的核心职责与候选人简历的强匹配点对齐。\n    -   优势与挑战：一句话同时呈现公司优势与现实挑战。\n-   备选公司举例（如候选人询问）：\n    “像您背景匹配的岗位，在北京、上海、深圳都有不错的机会。例如：\n    -   <b>北京</b>：<b>字节跳动</b>（大平台，电商方向）、<b>京东</b>（大平台，搜索产品）、<b>美团</b>（大平台，本地生活）、<b>叮咚买菜</b>（重点客户，生鲜电商）、<b>某A轮跨境电商初创公司</b>（初创公司，高潜力）\n    -   <b>上海</b>：<b>拼多多</b>（大平台，社交电商）、<b>阿里巴巴本地生活</b>（大平台）、<b>得物</b>（重点客户，潮流电商）、<b>某B轮品牌管理SaaS初创公司</b>（初创公司）\n    -   <b>深圳</b>：<b>腾讯</b>（大平台，视频号电商）、<b>Shopee</b>（大平台，跨境电商）、<b>某C轮出海DTC品牌</b>（重点客户/初创公司）”\n    （注：以上公司名为示例，AI需根据本次输入的JD内容动态生成匹配的真实或典型公司名、公司类型、岗位方向）\n\n【微信/电话索取】\n-   自然过渡，便于发送 JD、公司资料与流程说明。\n-   “如果电话不方便，能否加下微信保持长期联系？微信是这个手机号吗？”\n\n【结束语】\n-   再次强调候选人与岗位的核心匹配度。\n-   承诺明确反馈时间（如 3 个工作日内）。\n-   简述保密与流程要点（如流程轮次与节奏），让候选人安心。\n\n---\n\n## 输出格式要求\n-   使用 Markdown。\n-   模块标题必须单独成行，用全角【】标注，且按上述固定顺序。\n-   【信息确认】必须用数字分点，不可写成大段。\n-   关键内容须加粗，统一用 <b>…</b>。\n-   全文不得出现  符号。\n-   每个信息点换行，保持一屏可读。\n-   话术保持电话场景可复述，整体 6–8 分钟。\n\n---\n\n## 核心原则\n-   真实性：不虚构信息，公司举例需符合JD行业。\n-   匹配性：围绕 JD 职责与业务痛点对齐候选人经历。\n-   专业化：用企业常用表达（职责 + 成果）。\n-   直观性：首屏就能看见候选人和岗位的核心匹配点。\n-   实用性：顾问可直接照读，备选公司举例便于灵活应对。\n\n---\n\n## 输入\n-   职位描述（JD）：{jdText}\n-   候选人简历：{resumeText}', '[\"{undefined}\"]', 0, '2755d9e212b24c188119c01de6f6c6fa');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1981879103479255041', '李凯', '2025-10-25 08:22:54', NULL, NULL, '简历行业和职能重新匹配', '简历行业和职能重新匹配', 'Resume', '{resumeText}', '[\"{resumeText}\"]', 0, '5dd0faa00c4a49e8908d121d2e3dfd60');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1982011972457512961', '李凯', '2025-10-25 17:10:53', NULL, NULL, 'jd重新解析', 'jd重新解析', 'JD', '[\"{jdText}\"]', '[\"{jdText}\"]', 0, 'ff2d694938b54589899108f476cf51db');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1983404410531926018', '李凯', '2025-10-29 13:23:56', '李凯', '2025-11-19 12:20:15', '简历提取关键词', '简历提取关键词', 'Resume', '{resumeText}', '[\"{resumeText}\"]', 0, '768ed176fcae460b81155d9a3560e2ab');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1983405210457001986', '李凯', '2025-10-29 13:27:07', 'Qianqian', '2025-11-19 22:59:46', '简历对比当前项目关键词', '', 'Resume', '项目关键词：\r\n{projectKeywords}\r\n简历关键词：\r\n{keywords}', '[\"{resumeText}\"]', 0, '768ed176fcae460b81155d9a3560e2ab');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1983405437305933826', '李凯', '2025-10-29 13:28:01', 'Qianqian', '2025-11-19 22:59:56', '多个公司提取共性标签', '多个公司提取共性标签', 'Resume', '{content}', '[\"{resumeText}\"]', 0, '9271ff7745e849a7aaaf4b9507173495');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1983405587621400577', '李凯', '2025-10-29 13:28:37', NULL, NULL, '面试反馈解析', '面试反馈解析', 'Resume', '{remark}', '[\"{resumeText}\"]', 0, '256d9858387644a39074218c5739ee7e');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('1991022778466336769', '李凯', '2025-11-19 13:56:36', NULL, NULL, '项目关键状态职位分析', '项目关键状态职位分析', 'Resume', '{allPositions}', '[\"{resumeText}\"]', 0, 'ed0bc556bc7347de8a7be2cbdbfeb5b3');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('2010896321819291650', '李凯', '2026-01-13 10:06:58', NULL, NULL, '获取公司知识库信息', '获取公司知识库信息', 'Resume', '{companyInfo}', '[\"{resumeText}\"]', 0, '4d8509ca102a4701a5be5942b5316a1f');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('2013144265582809090', '李凯', '2026-01-19 14:59:30', NULL, NULL, '有效备注', '有效备注', 'Resume', '{remark}', '[\"{resumeText}\"]', 0, '416b58d92f7b4f89891a89f79c00f07e');
INSERT INTO `prompt_template` (`id`, `create_by`, `create_time`, `update_by`, `update_time`, `name`, `description`, `category`, `content`, `required_variables`, `status`, `app_id`) VALUES ('2019702852752818177', '李凯', '2026-02-06 17:20:59', NULL, NULL, '新版有效备注', '', 'Resume', '{remark}', '[\"{resumeText}\"]', 0, 'c0865432a06a4de698d864ce92c300c9');
COMMIT;

SET FOREIGN_KEY_CHECKS = 1;
