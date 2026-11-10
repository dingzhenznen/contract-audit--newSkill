方向对：在现有工具包里，SkillOpt 就是用来优化 contract-audit 这类"已有技能文档"的。 但只选它还不
  够，你这个 Benchmark 目前不满足它的形态。

  SkillOpt 需要什么

  - 一个 Train/Test 配对的 Benchmark：Train 用来学习和选候选，Test 只在冻结后测 baseline vs
    final。

  - 一个持续训练环境 + 可用的评测反馈。
  - 起始 Skill：它默认自己写一版草稿；要优化你那份，必须在「优化重点」里明确：

    以 agents/test/agent_state/skills/contract-audit/SKILL.md 为起点，
    只做有界编辑，不新建无关 Skill。

  你现在的 contract-audit-judgment 的问题

  - 只有一个包、3 个 Case、runs = 1，没有配对的 Train/Test。
  - SkillOpt 找不到 held-out Test，会在初始化阶段停下，而不是"凑合跑"。
  - 3 个 Case 也不足以做候选筛选，容易过拟合。

  所以有两条路
     audit，每轮存快照、可回滚。缺点是 3 个 Case 的证据很弱，只能当冒烟验证。
  2. 要方法正确：先把评测集拆成 contract-audit-judgment-train 和 contract-audit-judgment-test（各
     3–5 个 Case，题型同分布但数据不同），再用 SkillOpt。这样它的"严格提升留出验证分才接受"才有意
     义。

› http://localhost:7368/benchmark  用ai 创建benchmark 的时候 不会保护 train 和test 吗


■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/
feedback` to report the issue.


› http://localhost:7368/benchmark  用ai 创建benchmark 的时候 不会分别创建 train 和test 吗


• 我查一下 AI 建 Benchmark 的提示词和 benchmark-design 是否包含 Train/Test 拆分。

• Explored
  └ Search train|test in SKILL.md
    Search benchmark-design|创建.*Benchmark|create.*benchmark in strings.ts
    Read strings.ts

──────────────────────────────────────────────────────────────────────────────────────────────────

• 不会。 AI 创建走的是 benchmark-design，它只产出一套 Benchmark，不拆 Train/Test。

  UI 提示词里写得很明确

  packages/web/src/lib/strings.ts:5513 的 aiCreateTail 要求：

  - 题量 3 道左右；
  - 在 benchmarks/<benchmark_id>/ 下生成 benchmark_config.toml、若干 CASE-NNN-*/、
    scoreboard.yaml；

  - 逐题试测校准难度，冻结后写入 Formal Baseline。

  全程没有"训练集/测试集"的概念。它优化的是评测集本身（难度校准），不是为 RSI 准备训练数据。

  Train/Test 只在这两种情况下出现

  - 导入：benchmark-design 的导入流程会识别配对的 train/test 包并一并带入（reference/
    package.md:40），GDPEVO 就是这么来的。

  - 你明确要求：让 Agent 建两个 Benchmark，比如 contract-audit-judgment-train 和 contract-audit-
    judgment-test，题目不重叠、同一分布。AI 建 Benchmark 本身不会主动这么做。

  对你现在的场景

  - 如果你只用默认 agent-optimization：一套 3 题的 Benchmark 就够跑，但它没有 held-out，分数容易虚
    高。

  - 如果你要用 SkillOpt/OpenSkill：需要 Train/Test 两个包，且测试题不能是训练题的原样复制。

  最直接的做法是在「让 AI 创建 Benchmark」的输入里明确写：

  创建两个 Benchmark：contract-audit-judgment-train 和 contract-audit-judgment-test。
  两个包场景相同但题目不重叠，train 4 题、test 3 题，test 不参与任何校准或优化。

  需要我帮你把现有的 contract-audit-judgment 拆成这样一对吗？现有 3 题可以先放在 train，再补 3 道
  同分布的新题作为 test。