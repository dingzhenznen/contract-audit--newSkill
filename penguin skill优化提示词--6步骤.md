  正确配置

  1. 方法：SkillOpt RSI Toolkit 或 OpenSkill。
  2. 优化器 Agent：选 default_agent（它带方法 Skill）。
  3. 被测 Agent：penguin_support。
  4. Benchmark：选 Train 包（如 GDPEVO 的 -train），方法会按配对关系找 Test；不要选 example-
     benchmark。

  5. test_repetitions：第一次建议填 1，否则默认 3 次会把测试成本翻三倍。
  6. 「优化重点」里可以明确写下面内容：
    以被测 Agent 现有的 skills/penguin-support/SKILL.md 为起点，
    只优化这个 Skill；不要改 AGENTS.md，不要改动系统提示词。