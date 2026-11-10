https://developers.openai.com/api/docs/guides/evaluation-best-practices?api-mode=responses



 先分清三层 eval

  skill 的 eval 不是单元测试，是"真实任务 + 判分方式"的回归集。分三层，别混在一起：

  - 触发层：description 有没有让 skill 在对的场景被选中。样本分 should-trigger / should-not-trigger，看混淆矩阵。
  - 执行层：按 skill 跑出来的产物对不对（字段值、等级、条数）。
  - 纪律层：有没有违反硬约束（输出多余文字、改原件、拿表单值回填）。

  大多数 skill 只需要执行层 + 几条纪律断言；触发层只在 description 有明显歧义时才值得做。

  用例怎么写

  一个 case = 一份冻结的输入 + 一段用户原话 + 一组可机械核对的期望。用 JSON/YAML 存，一个 case 一个目录：

  {
    "id": "CA-003-missing-field",
    "prompt": "按这个规则集检查这几份合同",
    "inputs": {
      "ruleSet": "rule-set.json",
      "form": "form.json",
      "files": ["contracts/p1.jpg", "contracts/p2.jpg"]
    },
    "expect": {
      "jsonOnly": true,
      "checkResCount": 11,
      "riskLevel": "中风险",
      "itemExpect": [
        { "fieldCode": "TPM-豫HN-003", "riskLevel": "中风险", "value": "" }
      ],
      "mustNotContain": ["河南和之也商贸有限公司"],
      "inputHashesUnchanged": true
    }
  }

  关键四点：

  - 输入必须落盘冻结。你的 skill 靠 downloadUrl 取图，签名会过期，真跑 eval 时必然误报失败。把合同图片固定存进 evals/
    fixtures/，只在测"取件降级"这一条时用过期链接。

  - 用用户原话当 prompt，不要写"请你扮演…执行第 3 步"。eval 要测的是 skill 在真实上下文里的表现。
  - 用例来自真实失败。每次线上错一次，就沉淀一条 case；这比凭空编 20 条有用。
  - 留一组 held-out。调 skill 时反复看的那批 case 会过拟合，另留 20% 只在最终验收跑。

  判分怎么写

  优先级从高到低，能机械判的绝不用模型判：

  - 代码断言：JSON 可解析、checkRes.length == items.length、等级 ∈ 四枚举、外层等级 = 最高档、通过项 auditDesc == ""、
    summary ≤100 字、禁止出现的字符串、输入文件哈希未变。

  - 数值/集合比对：产品行级结果按 fieldCode 配对，允许声明容差（如价格 ±0.01）。
  - LLM rubric：只判"auditDesc 引用的原文是否真实存在于合同"这类语义项，且必须给 rubric 打分档位，不要问"对不对"。
  - 人工：只用于校准 LLM rubric 本身，10~20 条即可。

  跑法和指标

  写个 runner：遍历 case → 起全新上下文执行（subagent 或 codex exec）→ 收集输出 → 跑断言 → 出报告。

  - 指标：pass rate、按类别分桶（取值失败 / 表格配对 / 等级判定 / 输出纪律）、同 case 跑 3 次的 flaky 率。
  - 你的 skill 还该单列 读图次数 和 轮次——这是它明确的成本约束，也是它最容易退化的地方。
  - 每次改 SKILL.md 或 references 就全量跑；description 动了则加跑触发层。
  - 跑的时候不能把期望答案写进 prompt，否则测的是"抄答案能力"。判分在跑完之后离线做。

  常见坑

  - 只测 happy path：全部通过不代表 skill 好，负例（字段缺失、规则写"不判断"、重复产品）才是分水岭。
  - 把 fixture 写成会变的线上资源（签名 URL、远程表）。
  - 一条 case 断言太多，红了不知道是哪条规则坏了；按 fieldCode 拆细。
  - 用模型判分却不给 rubric，导致结果不可复现。

  要我按这个结构给 contract-audit 搭一套 evals/ 吗？可以包含 fixtures 目录、cases/*.json、一个 Python runner 和首批 8~10
  条针对你现有硬约束的用例。
