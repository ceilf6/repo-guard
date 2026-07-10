# README 第一屏改版 —— Harness 闭环叙事

> 2026-07-10。背景：用户简历（ceilf6/resume）的 repo-guard 条目已改写为「智能体开发闭环
> issue → PR → CR 中的评审环节 + 知识/执行分离」叙事。面试官点链接进入本仓库后，
> 当前 README 第一屏是「AI-powered review bot」+ 配置手册，叙事断层、易产生
> 「又一个 review bot」的失望感。本次改版消除该断层。

## 目标

第一屏回答面试官最值钱的问题：**为什么造这个轮子、它在作者工程体系中的角色、有哪些设计决策**。
术语与简历条目完全一致，动线无缝。OSS 用户的英文使用文档保持不动。

## 决策记录

1. **语言**：第一屏叙事用中文（产品默认中文评审输出、目标社区为中文社区、新增受众为中国面试官）；Quick Start 起的使用文档保持英文。
2. **幅度**：重写第一屏 + 章节重排（方案 A）；不做全文重构。
3. **生态边界**：定位段末尾带一句 harness-kit 生态链接（已核实其 GitHub description：「Harness 工程冷启动 CLI 工具」），不写完整方法论段。

## 新结构

```
标题 + 中文定位句（含 GitHub Marketplace）+ 一行英文副标题（保留检索性）
为什么造这个轮子（中文：社区 bot 面向人类协作 vs 闭环反馈信号 + ASCII 闭环图 + harness-kit 一句链接）
设计决策（中文 3 条：知识/执行分离、输出即契约、评审质量本身过质量门 eval:quality）
--- 分隔线 ---
Features（原 intro 7 条英文 bullets 收纳为小节，内容不变）
Quick Start / Configuration / Inputs / Comment Triggers / Advanced ×2（原样不动）
How It Works：Architecture 吸收原「Relationship with ceilf6-skills」节的职责表格与
  skill 链接（消除重复），PR Review / Issue Review 步骤不动；原独立 Relationship 节删除
Quality Evaluation（新英文短节，链 docs/quality-evaluation.md）
Relay/Proxy Support / Friendly Links / License（原样不动）
```

## 事实背书

- 设计决策① 出自原 Relationship 节（submodule 机制、运行时拉最新）。
- 设计决策② 出自 How It Works PR Review 第 6 步（中文结论枚举）与 docs/quality-evaluation.md（契约稳定性断言）。
- 设计决策③ 的 4 场景、断言维度均出自 docs/quality-evaluation.md，不新增声称。
- 闭环图不声称自动合并（merge 由人执行）；「批准/请求修改」为既有输出枚举。
- 无任何字节内部信息（脱敏红线）。

## 工作流

README 单文件 + 本 spec，直接 main 提交（与仓库历史一致），`npm test` 冒烟，push 到公开仓库（用户已在设计确认时授权）。
