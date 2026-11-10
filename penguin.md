

会，但默认优化器是"混合改"，Skill 只是其中一类载体。

  agent-optimization 的分工写得很明确（plugins/default-rsi-toolkit/skills/agent-optimization/
  SKILL.md:66）：

  - 行为指导 → AGENTS.md
  - 可复用、属于目标 Agent 自身的能力 → 一个聚焦的 Skill（agent_state/skills/<name>/SKILL.md）
  - 运行时限制 → system_config.yaml 的安全字段
  - 不动 system_prompt，不动 model.thinking_level，也不改库提供的 Skill（插件/内置库里那份，避免把
    目标特定行为写回公共库）

  所以每一轮 Candidate 可以选择只改 AGENTS.md、只改/新建一个 Skill，或两者组合——判据只看最终 score
  是否严格更高，不限定改动类型。

  如果想把"优化 Skill"作为主线

  penguin 还提供了一组专门以 Skill 为优化对象的 RSI 工具包：

  - plugins/skillopt-rsi-toolkit/skills/skillopt-rsi-toolkit/SKILL.md — 从轨迹中学有界的 Skill 编
    辑，在固定评测任务上选 Candidate。

  - plugins/openskill-rsi-toolkit/skills/openskill-rsi-toolkit/SKILL.md — 研究领域知识、用独立虚拟
    测试反复精炼可复用 Skill。

  - plugins/skilladam-rsi-toolkit/skills/skilladam-rsi-toolkit/SKILL.md — 持续 Session 里训练一
    次，冻结学到的 Skill，再到 held-out 任务上评测。

  - plugins/trace-rsi-toolkit/skills/trace-rsi-toolkit/SKILL.md — 从 Actor 轨迹训练模块化 skill
    bank，再和 no-Skill 基线对比。

  - plugins/awm-rsi-toolkit/skills/awm-rsi-toolkit/SKILL.md — 从成功轨迹归纳可复用 workflow 并冻结
    成记忆。

  - plugins/ace-rsi-toolkit/skills/ace-rsi-toolkit/SKILL.md — 用 Reflector/Curator 维护一个规则
    playbook。

  注意这里有个容易踩的边界：优化器可以创建/修改被测 Agent 自己的 Skill，但不能为了刷分去改公共库
  Skill——那样分数不可迁移，下一次别的 Agent 装了同一个库 Skill 就被污染了。


  


原因：这 4 个"以 Skill 为优化对象"的工具包还没有随版本发出去。

  现状

  - 代码里确实有：skillopt、openskill、skilladam、trace-rsi-toolkit，都在 rsi 分类下，注册为可选方
    法。

  - 但它们是在 2026-10-30 的 #1374 合入的，而仓库当前版本是 0.2.18（2026-10-27 发布）。所以已发布
    的 Web/桌面/CLI 里，方法下拉只有 5 个：Default、OPRO、APE、ACE、AWM。

  - 方法列表本身不写死，是运行时读插件库的 rsi 分类（packages/web/src/lib/rsi-methods.ts:36），所
    以库里有才会出现。

  为什么从当前代码跑也可能看不到

  插件的卡片声明在 src/index.ts，但运行时读的是构建产物 plugins/<name>/ifaces.json，而这个文件被
  gitignore（.gitignore:53），需要构建生成。没构建时该插件不会进入插件库，自然不出现在方法里。

  pnpm -r build        # 会为每个插件生成 ifaces.json
  pnpm dev             # 重新打开优化弹窗即刷新方法列表

  另外，即使方法出现了，优化器 Agent 还得装对应插件——发布前创建的 Agent 不会自动获得这些工具包，需
  要到「插件市场」给它安装，否则会提示缺 Skill。

  不升级也能做的替代方案

  用 Default 方法，在优化指令里明确要求把改动落到被测 Agent 自己的 Skill：

  优先把改动写进该 Agent 自己的 skill（agent_state/skills/<name>/SKILL.md），
  AGENTS.md 只保留一句何时使用该 skill。

  agent-optimization 本来就允许这么做（plugins/default-rsi-toolkit/skills/agent-optimization/
  SKILL.md:66），只是不会像 SkillOpt/OpenSkill 那样把"有界 Skill 编辑 + 独立测试选择"作为算法本
  身。

  要确认你当前运行的是哪一版、以及库里到底有几个 rsi 插件吗？给我你启动方式（pnpm dev / 桌面版 /
  CLI），我可以直接帮你查。