import test from "node:test";
import assert from "node:assert/strict";

import {
  isWhitelisted,
  mergeRecords,
  normalizeAccount,
  normalizeName,
  runMatch,
} from "./match.mjs";

const REPORT = {
  account_name: "河南和之也商贸有限公司",
  account: "6222020200112233445",
};

function supplement(records, url = "https://example.com/s.pdf") {
  return { url, records };
}

function contract(records, url = "https://example.com/c.pdf") {
  return { url, records };
}

function decide(input) {
  return runMatch({ report: REPORT, check_num: 1, ...input }).result;
}

test("清洗：户名只留中英文数字，账号去掉分隔符", () => {
  assert.equal(normalizeName(" 河南和之也商贸有限公司（盖章） "), "河南和之也商贸有限公司");
  assert.equal(normalizeName("河南·和之也"), "河南和之也");
  assert.equal(normalizeAccount("6222 0202-0011—2233 445"), "6222020200112233445");
  assert.equal(normalizeAccount("６２２２"), "6222");
});

test("白名单：关键词与长度阈值", () => {
  assert.equal(isWhitelisted("国网河南省电力公司"), true);
  assert.equal(isWhitelisted("水务局"), true);
  assert.equal(isWhitelisted(""), false);
  assert.equal(isWhitelisted("金沙县水务局"), false);
  assert.equal(isWhitelisted("河南和之也商贸有限公司"), false);
});

test("白名单命中直接 PASS，不读附件", () => {
  const result = runMatch({
    report: { account_name: "中国移动通信集团河南有限公司", account: "1" },
    check_num: "7",
    supplements: [supplement([{ 供应商名称: "别家", 供应商账号: "2" }])],
  }).result;
  assert.deepEqual(result, {
    判断结果: [{ 稽核行号: "7", 判断结果: "PASS" }],
    问题列表: [],
  });
});

test("单份补充协议齐全且一致 -> PASS", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: REPORT.account }])],
  });
  assert.equal(result.判断结果[0].判断结果, "PASS");
  assert.deepEqual(result.问题列表, []);
});

test("单份补充协议账号不一致 -> HOLD，只报账号", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: "999" }])],
  });
  assert.equal(result.判断结果[0].判断结果, "HOLD");
  assert.equal(result.问题列表.length, 1);
  assert.match(result.问题描述 ?? result.问题列表[0].问题描述, /银行账号/);
  assert.doesNotMatch(result.问题列表[0].问题描述, /户名'为/);
});

test("名称与账号都错 -> 合并为一条问题", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: "另一家公司", 供应商账号: "999" }])],
  });
  assert.equal(result.问题列表.length, 1);
  assert.match(result.问题列表[0].问题描述, /户名/);
  assert.match(result.问题列表[0].问题描述, /银行账号/);
});

test("补充协议只给名称，合同补账号 -> 严格比对 PASS", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: "" }])],
    contracts: [contract([{ 供应商名称: "", 供应商账号: REPORT.account }])],
  });
  assert.equal(result.判断结果[0].判断结果, "PASS");
});

test("补充协议只给名称，合同也没有账号 -> 容忍口径 PASS", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: "" }])],
    contracts: [],
  });
  assert.equal(result.判断结果[0].判断结果, "PASS");
});

test("单条合同记录已有名称时不覆盖 -> 补充协议值被忽略", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: "" }])],
    contracts: [contract([{ 供应商名称: "合同里的另一家", 供应商账号: REPORT.account }])],
  });
  assert.equal(result.判断结果[0].判断结果, "HOLD");
  assert.match(result.问题列表[0].问题描述, /合同里的另一家/);
});

test("多条合同记录：补充协议非空值覆盖每一条 -> PASS", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: "" }])],
    contracts: [
      contract([
        { 供应商名称: "干扰项", 供应商账号: REPORT.account },
        { 供应商名称: "另一个干扰项", 供应商账号: REPORT.account },
      ]),
    ],
  });
  assert.equal(result.判断结果[0].判断结果, "PASS");
});

test("多条记录：名称与账号来自不同记录不算匹配", () => {
  const result = decide({
    supplements: [
      supplement([
        { 供应商名称: REPORT.account_name, 供应商账号: "111" },
        { 供应商名称: "别家", 供应商账号: REPORT.account },
      ]),
    ],
  });
  assert.equal(result.判断结果[0].判断结果, "HOLD");
});

test("多份补充协议合并后多条，任意一条同时匹配 -> PASS", () => {
  const result = decide({
    supplements: [
      supplement([{ 供应商名称: "别家", 供应商账号: "111" }], "https://example.com/s1.pdf"),
      supplement(
        [{ 供应商名称: REPORT.account_name, 供应商账号: REPORT.account }],
        "https://example.com/s2.pdf"
      ),
    ],
  });
  assert.equal(result.判断结果[0].判断结果, "PASS");
});

test("过滤词：酒业主体被丢弃，回退合同", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: "贵州金沙窖酒酒业有限公司", 供应商账号: "999" }])],
    contracts: [contract([{ 供应商名称: REPORT.account_name, 供应商账号: REPORT.account }])],
  });
  assert.equal(result.判断结果[0].判断结果, "PASS");
});

test("合并算法：非空字段更多者胜出，不做互补拼接", () => {
  const merged = mergeRecords([
    { name: "A", account: "" },
    { name: "", account: "6222" },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0].name, merged[0].account], ["A", ""]);
});

test("稽核行号类型原样保留", () => {
  const files = { supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: REPORT.account }])] };
  const numeric = runMatch({ report: REPORT, check_num: 3, ...files }).result;
  const text = runMatch({ report: REPORT, check_num: "3", ...files }).result;
  assert.equal(numeric.判断结果[0].稽核行号, 3);
  assert.equal(text.判断结果[0].稽核行号, "3");
});

test("输入契约：缺 report 字段直接报错", () => {
  assert.throws(
    () => runMatch({ report: { account_name: "A" }, supplements: [supplement([])] }),
    (error) => error.code === "INVALID_INPUT"
  );
});

test("输入契约：报账单两个字段都空 -> EMPTY_REPORT", () => {
  assert.throws(
    () => runMatch({ report: { account_name: "", account: "" }, supplements: [supplement([])] }),
    (error) => error.code === "EMPTY_REPORT"
  );
});

test("输入契约：无附件 -> NO_ATTACHMENTS，lenient 回退 PASS", () => {
  assert.throws(() => runMatch({ report: REPORT }), (error) => error.code === "NO_ATTACHMENTS");
  const result = runMatch({ report: REPORT }, { lenient: true }).result;
  assert.equal(result.判断结果[0].判断结果, "PASS");
});

test("输入契约：文件条目必须带 records，提取失败传 []", () => {
  assert.throws(
    () => runMatch({ report: REPORT, contracts: [{ url: "https://example.com/c.pdf" }] }),
    (error) => error.code === "INVALID_INPUT"
  );
  assert.throws(
    () => runMatch({ report: REPORT, contracts: [{ url: "https://example.com/c.pdf", records: [] }] }),
    (error) => error.code === "NO_EXTRACTED_RECORDS"
  );
  const { result, trace } = runMatch(
    { report: REPORT, contracts: [{ url: "https://example.com/c.pdf", records: [] }] },
    { lenient: true }
  );
  assert.equal(result.判断结果[0].判断结果, "PASS");
  assert.ok(
    trace.steps.some((step) => step.step === "contract" && step.branch === "single" && step.records === 0)
  );
});

test("账号护栏：91/92 开头的 18 位税号不可用 -> HOLD", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: "913200001234567890" }])],
  });
  assert.equal(result.判断结果[0].判断结果, "HOLD");
  assert.match(result.问题列表[0].问题描述, /不可用/);
  assert.match(result.问题列表[0].问题描述, /统一社会信用代码/);
});

test("账号护栏：长度异常不可用 -> HOLD", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: "12345" }])],
  });
  assert.equal(result.判断结果[0].判断结果, "HOLD");
  assert.match(result.问题列表[0].问题描述, /长度 5/);
});

test("账号护栏：no-validate 时按原值比对", () => {
  const taxId = "913200001234567890";
  const input = {
    report: { account_name: REPORT.account_name, account: taxId },
    supplements: [supplement([{ 供应商名称: REPORT.account_name, 供应商账号: taxId }])],
  };
  assert.equal(runMatch(input).result.判断结果[0].判断结果, "HOLD");
  assert.equal(runMatch(input, { validate: false }).result.判断结果[0].判断结果, "PASS");
});

test("置信度护栏：低于阈值 -> HOLD", () => {
  const result = decide({
    supplements: [
      supplement([{ 供应商名称: REPORT.account_name, 供应商账号: REPORT.account, confidence: 0.3 }]),
    ],
  });
  assert.equal(result.判断结果[0].判断结果, "HOLD");
  assert.match(result.问题列表[0].问题描述, /置信度/);
});

test("置信度护栏：达到阈值 -> 正常 PASS", () => {
  const result = decide({
    supplements: [
      supplement([{ 供应商名称: REPORT.account_name, 供应商账号: REPORT.account, confidence: 0.92 }]),
    ],
  });
  assert.equal(result.判断结果[0].判断结果, "PASS");
});

test("名称护栏：名称残片按不可用处理 -> HOLD", () => {
  const result = decide({
    supplements: [supplement([{ 供应商名称: "有限公司", 供应商账号: REPORT.account }])],
  });
  assert.equal(result.判断结果[0].判断结果, "HOLD");
  assert.match(result.问题列表[0].问题描述, /名称残片/);
});
