---
name: contract-audit
description: 规则驱动的合同审计（单 JSON 输出）。当用户提供「规则集 JSON（items：fieldCode/fieldName/helpDesc/outputDesc/judgeRule）+ 表单与合同文件列表 JSON」，要求按规则逐条比对并给出风险等级时使用。典型说法「按这个规则集检查这几份合同」「合同和表单对不上吗」「跑一下合同审计」「输出每条规则的检查结果」。产出：**只有一段 JSON 文本**（riskLevel + summary + checkRes），不含审计报告、表格或任何解释文字。
agent_created: true
---

# 合同审计（规则驱动 · 单 JSON 输出）

输入两件、输出一件：**规则集 + 表单与合同列表 → 一段 JSON 文本**。

规则全部由用户提供，**一条也不自己发明、不自己放宽、不升级不降级**。合同里没有的信息就报没有，**绝不用表单值回填合同值**。

## 一、输入（格式固定，按位置解析）

两次输入的结构固定，直接按字段名取值，不需要做通用适配。

### 输入 1 · 规则集

```json
{
  "ruleSetCode": "RULE-豫HN-001",
  "ruleSetName": "河南营销中心规则集",
  "businessSystem": "TPM",
  "description": "营销中心规则集",
  "items": [
    {
      "fieldCode": "TPM-豫HN-001",
      "fieldName": "经销商名称",
      "helpDesc": "仅在合同文件中，关键字'甲方（供货方）：'后提取,只提取1次，未识别到信息时显示空字符串",
      "outputDesc": "{\n    \"经销商名称\":\"\"\n}",
      "judgeRule": "若合同文件中“经销商名称”与表单内容中“经销商名称”不一致，则判断为“中风险”"
    }
  ]
}
```

三个关键字段各自的固定解析规则见 `references/01-input-contract.md`：

- `helpDesc` → 从哪里取（锚点 / 表格列 / 兜底值）
- `judgeRule` → 取不到一致时的等级（**唯一的等级来源**）
- `outputDesc` → 输出值的书写格式（如日期区间）

### 输入 2 · 表单数据 + 合同文件列表

```json
{
  "terminalName": "齐齐哈尔家庭烤肉（心怡路）",
  "cooperationModeDesc": "完全包量",
  "customerName": "河南和之也商贸有限公司",
  "estimateTerminalCost": 21015,
  "protocolStartTime": "2024-07-23 00:00:00",
  "protocolEndTime": "2025-06-30 23:59:59",
  "products": [
    { "productName": "雪花纯生8度500ml白瓶1*12纸箱", "salesCount": 3,
      "entryPrice": 68, "retailPrice": 120, "singleStandard": 1.66474 }
  ],
  "contractFiles": [
    { "contractCode": "", "fileName": "PLX240000062534_20260930.jpg",
      "downloadUrl": "http://aiac-dsu-1259627966.cos.ap-guangzhou.myqcloud.com/aiac/...jpg?sign=..." }
  ]
}
```

规则 `fieldName` → 表单字段的映射表是固定的，见 `references/01-input-contract.md` §3。

## 二、执行五步

```
① 解析规则集    items → 每项 {fieldCode, fieldName, 锚点, 表格列, 兜底值, 等级}
② 解析表单      products 保留数组结构；同名字段不覆盖（重复项一律成组）
③ 读合同        按 contractFiles[].downloadUrl 取值，**每页整页读一次**，读完即定稿（见 02）
④ 比对判定      归一化后逐条比；表格类先按产品行配对再逐行比（见 03）
⑤ 输出          只输出一段 JSON，前面不解释、后面不补充（见 04）
```

③ 的取值会失败（签名过期、图片旋转、手写潦草）。图片一律**整页直读、一页一次**（见 02 §2.2）：
读不清**不放大、不复读、不二次确认**，直接按 `helpDesc` 兜底取空值参与比对。
**执行速度优先** —— 手写体本身就会有识别错误或识别不出，放大复核并不提升实质准确率，只多耗轮次。

## 三、风险等级（只有 4 个合法值）

```
高风险 > 中风险 > 低风险 > 通过
```

- **单项等级** = 该条 `judgeRule` 引号里的等级。`judgeRule` 写「不判断」「只展示」→ `通过`。
- **整体 `riskLevel`** = 所有 `checkRes` 里的最高一档。例：`[中风险, 低风险, 低风险]` → `中风险`。
- 任何情形都不许临场发明等级：规则集写高风险就是高风险，不允许因为"看着不严重"降到低风险，反之亦然。
- 提取失败 / 锚点未命中 → 按 `helpDesc` 的兜底值（通常是空字符串）参与比对，**等级仍取该条 `judgeRule` 的等级**。

## 四、输出（只有 JSON）

```json
{
  "riskLevel": "高风险",
  "summary": "共5项风险。高风险3项：预计销量、进店价、零售价不一致；中风险1项：终端名称不一致；低风险1项：合作方式不一致。",
  "checkRes": [
    { "fieldCode": "TPM-豫HN-001", "fieldName": "经销商名称", "riskLevel": "中风险",
      "auditDesc": "合同中经销商名称与表单不一致：合同…，表单…" }
  ]
}
```

- `riskLevel`：整体等级，四枚举之一（`高风险` / `中风险` / `低风险` / `通过`）。
- `summary`：风险总结，≤100 字；全通过时固定输出 `暂无风险，无需关注。`。生成规则见 `references/04-output-format.md` §2。
- `checkRes`：**`items` 有几条就输出几条，顺序与 `items` 一致**。`auditDesc` 在 `通过` 时为空字符串 `""`。

**输出纪律**：直接给 JSON 文本（2 空格缩进）；不要审计报告、不要风险矩阵、不要证据附件、不要前后说明文字。

## 五、硬约束

1. **只输出 JSON。** 不写报告、不写表格、不写"以下是审计结果"之类的前后缀。
2. **不臆造合同值。** 合同里没有就按 `helpDesc` 兜底取空字符串，绝不用表单值反填 —— 这会造成虚假通过，是本岗位上最严重的错误。
3. **一条不漏、一条不多。** `checkRes.length == items.length`，`fieldCode` 与 `fieldName` 原样保留。
4. **等级只能来自 `judgeRule`。** 表驱动，不合并、不升级、不降级。
5. **表格类必须逐行比。** 多产品/多行数据先按产品配对再逐行判定，不允许先 join 成一串再整体比（那样只能得出"不一致"，定位不到是哪个产品）。
6. **原件只读。** 不修改、不重命名、不覆盖用户的合同与表单文件；下载到本地的副本只用于识别。
7. **内部留痕（不输出）。** 每个结论都要能指出合同原文出处（文件 + 位置 + 引文）。引文用**首次整页读到的那一版**，不为了"抄准"而复读或放大；手写体允许有识别偏差，记下 `confidence` 即可。`auditDesc` 里引用的原文片段要克制，一般 ≤60 字。
8. **读图一次定稿。** 每张合同图只读一次。禁止叠坐标网格、切片定位、逐字放大复核、同一页重复读。读不清的数字/文字按 `helpDesc` 兜底取空值，等级仍取该条 `judgeRule` —— **宁可如实报空，不要为消除不确定而追加读图**。

## 六、文件索引

| 文件 | 内容 |
|------|------|
| `references/01-input-contract.md` | 两种输入的固定解析：`helpDesc` / `judgeRule` / `outputDesc` 解析规则、`fieldName`→表单字段映射表、归一化口径 |
| `references/02-extraction-guide.md` | 合同侧取值：五步法、锚点纪律、表格 ROWS 程序、图片读取（**整页直读、一页一次**）、取件降级（签名过期）、方向校正、手写体口径、环境要求与移植、内部留痕 |
| `references/03-comparison-guide.md` | 比对：单值 / 数值 / 行级集合三种模式、行主键配对（简称↔全称 SKU）、单位口径（元/瓶 ↔ 元/件）、判级 |
| `references/04-output-format.md` | 输出：JSON 结构、`summary` 生成规则（含 100 字预算与全通过话术）、`auditDesc` 模板、完整示例 |
| `templates/rule-set.example.json` | 规则集输入样例 |
| `templates/form-data.example.json` | 表单与合同列表输入样例 |
| `templates/result.example.json` | 输出样例（11 条规则的真实形态） |

## 七、输出前自检

- [ ] `items` 每条都在 `checkRes` 里，顺序一致，`fieldCode` / `fieldName` 原样
- [ ] 每条 `riskLevel` ∈ {高风险, 中风险, 低风险, 通过}
- [ ] 外层 `riskLevel` = 所有 `checkRes.riskLevel` 的最高档
- [ ] `auditDesc`：通过项为 `""`；不一致项包含合同值、表单值与"不一致"字样
- [ ] 全通过时 `summary` 就是 `暂无风险，无需关注。`
- [ ] `summary` ≤100 字，且风险计数与 `checkRes` 逐条对得上
- [ ] 输出里没有任何 JSON 之外的内容
- [ ] 读图次数 = 合同图片张数（无复读、无放大切片、无二次确认）
