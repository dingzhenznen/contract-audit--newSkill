 要建两套，不能把 Train/Test 放在同一个 Benchmark 里。 另外 SkillOpt 在 UI 里一次只能选一个
  Benchmark，Test 包要在指令里明确点名。

  为什么不放一起

  Benchmark 的目录结构是：

  benchmarks/<benchmark_id>/
  ├── benchmark_config.toml
  ├── scoreboard.yaml
  └── CASE-*/

  清单里没有 train/、test/ 字段，Case 也不带 split 标记。所以一套 Benchmark 就是一个题库，Train/
  Test 只能做成两个独立目录，这也是 GDPEVO 的做法：

  penguinharness-benchmark-gdpevo-...-train
  penguinharness-benchmark-gdpevo-...-test

  SkillOpt 怎么拿到两个题库

  - 「优化」页的 Benchmark 字段是单选，提示词里只有一个 benchmark_id。
  - SkillOpt 会按 Benchmark 的说明去找"配对的 Train/Test 包"。为了不让它猜，选 Train 包，并在「优
    化重点」里写明 Test 包：

  Train 用 contract-audit-judgment-train，Test 用 contract-audit-judgment-test。
  只在 Train 上学习和选候选，Test 只在冻结后测 baseline vs final。

  - 两个包命名成 -train / -test 后缀，配对关系最不容易被误解。

  让 AI 建的时候这样写

  创建两个 Benchmark：
  1. contract-audit-judgment-train：4 道训练题
  2. contract-audit-judgment-test：3 道测试题

  两个包场景相同、题型同分布，但题目和数据不重叠。
  Test 题目不参与任何难度校准或优化，只用于冻结后测量。
  两个包都 status = published、runs = 1，并各自建立基线。

  注意：默认的 AI 创建提示是"3 道题、一套 Benchmark"（packages/web/src/lib/strings.ts:5513），不写
  清楚它就会只建一套。

  如果你不想拆

  就用默认 agent-optimization，它接受单套 Benchmark，直接改 contract-audit，但因为没有 held-out，
  分数只能当参考，不能当"泛化提升"的证据。