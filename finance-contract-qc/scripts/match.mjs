#!/usr/bin/env node
/**
 * match.mjs — 财务合同质检的确定性判定核心。
 *
 * 覆盖 references/04-whitelist-and-branching.md 与 references/05-comparison.md：
 *   白名单 → 补充协议数量分流 → 去空/合并 → 合同回填/覆盖 → 严格/容忍比对 → 问题合并
 *
 * 不负责 PDF 转图、OCR 和供应商提取；输入是已经提取好的记录。
 *
 * 用法：
 *   node match.mjs input.json [--pretty] [--debug] [--no-filter]
 *   node match.mjs - < input.json
 *
 * 输入：
 *   {
 *     "report": { "account_name": "...", "account": "..." },
 *     "check_num": 1,
 *     "supplements": [ { "url": "...", "records": [
 *       { "供应商名称": "...", "供应商账号": "...", "confidence": 0.95 }
 *     ] } ],
 *     "contracts":   [ { "url": "...", "records": [ ... ] } ]
 *   }
 *
 * 生产契约：
 *   - report 两个字段必须存在；未知传 ""，两者都空报 EMPTY_REPORT。
 *   - 每份附件必须带 records/columns；提取失败传 []，否则文件计数会变、分流会错。
 *   - 账号 6–32 位、默认不允许字母、91/92 开头的 18 位按税号拒绝。
 *   - confidence 低于阈值（默认 0.6）时，非空字段按不可用处理。
 *   - --lenient 回退工作流原始语义，跳过以上业务护栏。
 *
 * 输出：{ "判断结果": [...], "问题列表": [...] }
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WHITELIST_KEYWORDS = Object.freeze([
  "国网",
  "电网",
  "中国电信",
  "中国移动",
  "中国石油天然气",
  "中国联合网络通信",
  "中国石化",
]);

export const FILTER_KEYWORDS = Object.freeze(["雪花", "金沙", "酒业"]);

export const ISSUE_TYPE = Object.freeze({
  一类问题: "报销单填写问题",
  二类问题: "供应商信息错误",
});

const NAME_KEYS = ["供应商名称", "supplierName", "name", "账户名称", "户名"];
const ACCOUNT_KEYS = ["供应商账号", "supplierAccount", "account", "银行账号", "账号"];

const ACCOUNT_MIN_LENGTH = 6;
const ACCOUNT_MAX_LENGTH = 32;
const NAME_FRAGMENTS = new Set([
  "公司",
  "有限公司",
  "有限责任公司",
  "股份有限公司",
  "账户",
  "专户",
  "账号",
  "开户名",
  "户名",
]);

export class InputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InputError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asText(value) {
  return String(value ?? "").normalize("NFKC");
}

const NAME_ANNOTATION = /[（(【\[]\s*(?:盖章|代收|签章|财务专用章|合同专用章)\s*[）)】\]]/gu;

/** 户名清洗：只保留中文、英文字母、数字。 */
export function normalizeName(value) {
  return asText(value)
    .replace(NAME_ANNOTATION, "")
    .replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "");
}

/** 账号清洗：只保留数字和字母，去掉空格、连字符、全角符号。 */
export function normalizeAccount(value) {
  return asText(value).replace(/[^A-Za-z0-9]/g, "");
}

/** 白名单：命中关键词，或清洗后长度 < 4。空名称不命中。 */
export function isWhitelisted(value) {
  const name = normalizeName(value);
  if (!name) return false;
  if (WHITELIST_KEYWORDS.some((keyword) => name.includes(keyword))) return true;
  return name.length < 4;
}

/** 账号合理性检查：长度、纯数字、排除统一社会信用代码。空值视为合法（交给空值口径）。 */
export function checkAccount(value, { allowAlphanumeric = false } = {}) {
  const account = normalizeAccount(value);
  if (!account) return { ok: true, value: "", reason: "" };
  if (!allowAlphanumeric && /[A-Za-z]/.test(account)) {
    return { ok: false, value: account, reason: "含字母，疑似统一社会信用代码或发票代码" };
  }
  if (account.length < ACCOUNT_MIN_LENGTH || account.length > ACCOUNT_MAX_LENGTH) {
    return {
      ok: false,
      value: account,
      reason: `长度 ${account.length} 不在 ${ACCOUNT_MIN_LENGTH}-${ACCOUNT_MAX_LENGTH} 之间`,
    };
  }
  if (account.length === 18 && /^(91|92)/.test(account)) {
    return { ok: false, value: account, reason: "18 位且以 91/92 开头，疑似统一社会信用代码" };
  }
  return { ok: true, value: account, reason: "" };
}

/** 名称残片检查：只剩「有限公司」「账户」等字样时按空值处理。 */
export function checkName(value) {
  const name = normalizeName(value);
  if (!name) return { ok: true, value: "", reason: "" };
  if (NAME_FRAGMENTS.has(name) || name.length < 2) {
    return { ok: false, value: "", reason: `名称残片「${name}」` };
  }
  return { ok: true, value: name, reason: "" };
}

function assertFiles(files, name) {
  if (files === undefined) return;
  if (!Array.isArray(files)) {
    throw new InputError("INVALID_INPUT", `${name} must be an array`);
  }
  files.forEach((file, index) => {
    if (!isPlainObject(file)) {
      throw new InputError("INVALID_INPUT", `${name}[${index}] must be an object`);
    }
    const hasColumns =
      Array.isArray(file.records) ||
      Array.isArray(file.columns) ||
      isPlainObject(file.columns);
    if (!hasColumns) {
      throw new InputError(
        "INVALID_INPUT",
        `${name}[${index}] must include records/columns; pass [] when extraction failed so the file still counts`
      );
    }
  });
}

/**
 * 输入契约校验。结构问题始终报错；空报账单/无附件属于业务护栏，--lenient 可回退。
 */
export function assertInput(input, options = {}) {
  if (!isPlainObject(input)) {
    throw new InputError("INVALID_INPUT", "input must be an object");
  }
  if (!isPlainObject(input.report)) {
    throw new InputError("INVALID_INPUT", "report is required");
  }
  for (const key of ["account_name", "account"]) {
    if (!(key in input.report)) {
      throw new InputError(
        "INVALID_INPUT",
        `report.${key} is required; use "" when the value is unknown`
      );
    }
  }
  if (options.lenient !== true) {
    const name = normalizeName(input.report.account_name);
    const account = normalizeAccount(input.report.account);
    if (!name && !account) {
      throw new InputError(
        "EMPTY_REPORT",
        "report.account_name and report.account are both empty"
      );
    }
  }
  assertFiles(input.supplements ?? input["合同补充协议"], "supplements");
  assertFiles(input.contracts ?? input["合同"], "contracts");
}

function pick(source, keys) {
  if (!source || typeof source !== "object") return "";
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function makeRecord(
  raw,
  {
    url = "",
    source = "",
    validate = true,
    minConfidence = 0.6,
    allowAlphanumericAccounts = false,
  } = {}
) {
  const rawName = normalizeName(pick(raw, NAME_KEYS));
  const rawAccount = normalizeAccount(pick(raw, ACCOUNT_KEYS));
  let name = rawName;
  let account = rawAccount;
  let nameRejected = "";
  let accountRejected = "";

  if (validate) {
    const nameCheck = checkName(rawName);
    if (!nameCheck.ok) {
      name = "";
      nameRejected = nameCheck.reason;
    }
    const accountCheck = checkAccount(rawAccount, {
      allowAlphanumeric: allowAlphanumericAccounts,
    });
    if (!accountCheck.ok) {
      account = "";
      accountRejected = accountCheck.reason;
    }
    const confidenceValue = raw?.confidence;
    if (confidenceValue !== undefined && confidenceValue !== null && confidenceValue !== "") {
      const confidence = Number(confidenceValue);
      if (Number.isFinite(confidence) && confidence < minConfidence) {
        const reason = `提取置信度 ${confidence} 低于阈值 ${minConfidence}`;
        if (name) {
          name = "";
          nameRejected = nameRejected || reason;
        }
        if (account) {
          account = "";
          accountRejected = accountRejected || reason;
        }
      }
    }
  }

  const ownUrl = String(
    (raw && (raw.url || raw["url-origin"] || raw.url_origin)) || url || ""
  );
  return {
    name,
    account,
    nameRaw: rawName,
    accountRaw: rawAccount,
    nameRejected,
    accountRejected,
    url: ownUrl,
    nameUrl: ownUrl,
    accountUrl: ownUrl,
    nameSource: source,
    accountSource: source,
  };
}

/**
 * 把一个文件展开成记录。支持三种形态：
 *   { url, records: [{供应商名称, 供应商账号}] }
 *   { url, columns: [{...}] }
 *   { url, columns: {供应商名称, 供应商账号} }
 */
export function flattenFiles(files, source, options = {}) {
  const out = [];
  for (const file of files || []) {
    if (!file) continue;
    if (typeof file === "string") {
      out.push(makeRecord({}, { ...options, url: file, source }));
      continue;
    }
    const url = String(file.url || file["url-origin"] || file.url_origin || "");
    let columns = file.records ?? file.columns;
    if (columns === undefined && (file["供应商名称"] || file["供应商账号"])) {
      columns = [file];
    }
    if (Array.isArray(columns)) {
      for (const item of columns) out.push(makeRecord(item, { ...options, url, source }));
    } else if (columns && typeof columns === "object") {
      out.push(makeRecord(columns, { ...options, url, source }));
    }
  }
  return out;
}

/** 03 的过滤词：命中即丢弃该记录。 */
export function isFilteredRecord(record) {
  const name = record.name.toLowerCase();
  return FILTER_KEYWORDS.some((keyword) => name.includes(keyword));
}

/**
 * 04 的合并算法，与工作流 `清理为空数据&合并结果` 保持一致：
 * 每个字段「相等或至少一方为空」才可合并；合并时保留非空字段更多的记录。
 * 注意：这不是字段级互补拼接；两条各缺一半且非空数相等的记录，会保留先出现的那条。
 */
export function mergeRecords(records) {
  const groups = [];
  for (const current of records) {
    let merged = false;
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      const canMerge =
        (!current.name || !group.name || current.name === group.name) &&
        (!current.account || !group.account || current.account === group.account);
      if (!canMerge) continue;

      const currentCount = (current.name ? 1 : 0) + (current.account ? 1 : 0);
      const groupCount = (group.name ? 1 : 0) + (group.account ? 1 : 0);
      if (currentCount > groupCount) groups[i] = current;
      merged = true;
      break;
    }
    if (!merged) groups.push(current);
  }
  return groups;
}

/** 单条记录路径：只填空，已有值不被覆盖。 */
function fillFromGlobals(base, globals) {
  const out = { ...base };
  if (!out.name && globals.name) {
    out.name = globals.name;
    out.nameUrl = globals.url;
    out.nameSource = globals.source;
    out.nameRejected = "";
  }
  if (!out.account && globals.account) {
    out.account = globals.account;
    out.accountUrl = globals.url;
    out.accountSource = globals.source;
    out.accountRejected = "";
  }
  if (!out.name && !globals.name && globals.nameRejected) {
    out.nameRejected = globals.nameRejected;
    out.nameRaw = globals.nameRaw;
  }
  if (!out.account && !globals.account && globals.accountRejected) {
    out.accountRejected = globals.accountRejected;
    out.accountRaw = globals.accountRaw;
  }
  out.url = out.accountUrl || out.nameUrl || out.url;
  return out;
}

/** 多条记录路径：全局非空值覆盖每一条记录。 */
function overlayGlobals(records, globals, { useUrl = false } = {}) {
  if (!globals.name && !globals.account) return records;
  return records.map((record) => {
    const out = { ...record };
    if (globals.name) {
      out.name = globals.name;
      out.nameUrl = globals.url;
      out.nameSource = globals.source;
      out.nameRejected = "";
    }
    if (globals.account) {
      out.account = globals.account;
      out.accountUrl = globals.url;
      out.accountSource = globals.source;
      out.accountRejected = "";
    }
    if (!globals.name && globals.nameRejected && !out.name) {
      out.nameRejected = globals.nameRejected;
      out.nameRaw = globals.nameRaw;
    }
    if (!globals.account && globals.accountRejected && !out.account) {
      out.accountRejected = globals.accountRejected;
      out.accountRaw = globals.accountRaw;
    }
    if (useUrl) {
      if (globals.name && globals.account && out.nameUrl !== out.accountUrl) {
        out.url = out.accountUrl;
      } else {
        out.url = out.accountUrl || out.nameUrl || out.url;
      }
    }
    return out;
  });
}

/** 严格：字面相等；容忍：空字段视为无误。 */
function compareRecord(record, report, mode) {
  const tolerant = mode === "tolerant";
  const nameOk = record.nameRejected
    ? !report.account_name
    : tolerant && !record.name
      ? true
      : record.name === report.account_name;
  const accountOk = record.accountRejected
    ? !report.account
    : tolerant && !record.account
      ? true
      : record.account === report.account;
  return { nameOk, accountOk };
}

/** 失败时选一条最能说明问题的记录：先看匹配字段数，再看非空字段数。 */
function pickCandidate(records, report) {
  let best = records[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const { nameOk, accountOk } = compareRecord(record, report, "strict");
    const score =
      (nameOk ? 2 : 0) + (accountOk ? 2 : 0) + (record.name ? 1 : 0) + (record.account ? 1 : 0);
    if (score > bestScore) {
      best = record;
      bestScore = score;
    }
  }
  return best;
}

function sourceLabel(source) {
  if (source === "contract") return "合同";
  if (source === "supplement") return "合同补充协议";
  return "附件";
}

function sourceText(source, url) {
  const label = sourceLabel(source);
  return url ? `来源附件：${label}，url：${url}` : `来源附件：${label}`;
}

function buildIssue(report, record, nameOk, accountOk) {
  const reportName = report.account_name;
  const reportAccount = report.account;
  const nameSource = sourceText(record.nameSource, record.nameUrl || record.url);
  const accountSource = sourceText(record.accountSource, record.accountUrl || record.url);
  const nameLabel = sourceLabel(record.nameSource);
  const accountLabel = sourceLabel(record.accountSource);
  const bothSources =
    nameSource === accountSource ? nameSource : `${nameSource}；${accountSource}`;
  const rejected = Boolean(record.nameRejected || record.accountRejected);
  const verb = rejected ? "无法比对" : "不一致";

  const nameValue = record.nameRejected
    ? `'${record.nameRaw}'不可用（${record.nameRejected}）`
    : `'${record.name}'`;
  const accountValue = record.accountRejected
    ? `'${record.accountRaw}'不可用（${record.accountRejected}）`
    : `'${record.account}'`;

  let description;
  if (!nameOk && !accountOk) {
    const supplierPart =
      rejected || nameLabel !== accountLabel
        ? `${nameLabel}供应商名称${nameValue}、${accountLabel}账号${accountValue}`
        : `${nameLabel}供应商名称${nameValue}、账号${accountValue}`;
    description =
      `报账单中'员工/供应商-户名'为'${reportName}'、'员工/供应商-银行账号'为'${reportAccount}'，` +
      `与${supplierPart}${verb}（${bothSources}）`;
  } else if (!nameOk) {
    description =
      `报账单中'员工/供应商-户名'为'${reportName}'，` +
      `${nameLabel}供应商名称为${nameValue}，${verb}（${nameSource}）`;
  } else {
    description =
      `报账单中'员工/供应商-银行账号'为'${reportAccount}'，` +
      `${accountLabel}供应商账号为${accountValue}，${verb}（${accountSource}）`;
  }

  return { ...ISSUE_TYPE, 问题描述: description };
}

function buildResult(checkNum, pass, issues) {
  return {
    判断结果: [{ 稽核行号: checkNum, 判断结果: pass ? "PASS" : "HOLD" }],
    问题列表: pass ? [] : issues,
  };
}

function emptyGlobals(source = "") {
  return {
    name: "",
    account: "",
    url: "",
    source,
    nameUrl: "",
    accountUrl: "",
    nameSource: source,
    accountSource: source,
    nameRaw: "",
    accountRaw: "",
    nameRejected: "",
    accountRejected: "",
  };
}

/**
 * 执行完整判定。
 * @returns {{result: object, trace: object}}
 */
export function runMatch(input, options = {}) {
  assertInput(input, options);

  const trace = { steps: [] };
  const report = {
    account_name: normalizeName(
      input.report?.account_name ?? input.report?.name ?? input["报账单户名"] ?? ""
    ),
    account: normalizeAccount(
      input.report?.account ?? input.report?.bank_account ?? input["报账单账号"] ?? ""
    ),
  };
  const checkNum = input.check_num ?? input["稽核行号"] ?? input.report?.check_num ?? "";
  trace.report = report;

  if (isWhitelisted(report.account_name)) {
    trace.steps.push({ step: "whitelist", hit: true, nameLength: report.account_name.length });
    return { result: buildResult(checkNum, true, []), trace };
  }
  trace.steps.push({ step: "whitelist", hit: false, nameLength: report.account_name.length });

  const supplementFiles = input.supplements ?? input["合同补充协议"] ?? [];
  const contractFiles = input.contracts ?? input["合同"] ?? [];
  const useFilter = options.filter !== false;
  const recordOptions = {
    validate: options.validate !== false && options.lenient !== true,
    minConfidence: options.minConfidence ?? 0.6,
    allowAlphanumericAccounts: options.allowAlphanumericAccounts === true,
  };

  if (supplementFiles.length === 0 && contractFiles.length === 0 && options.lenient !== true) {
    throw new InputError(
      "NO_ATTACHMENTS",
      "supplements and contracts are both empty; cannot verify supplier information"
    );
  }

  const prepare = (files, source, dropEmpty) => {
    let records = flattenFiles(files, source, recordOptions);
    if (useFilter) records = records.filter((record) => !isFilteredRecord(record));
    if (dropEmpty) records = records.filter((record) => record.name || record.account);
    return records;
  };

  let globals = emptyGlobals();
  let mode = null;
  let candidates = null;
  let branch = "";

  if (supplementFiles.length === 1) {
    const records = prepare(supplementFiles, "supplement", false);
    trace.steps.push({ step: "supplement", branch: "single", records: records.length });

    if (records.length > 1) {
      mode = "strict";
      candidates = records;
      branch = "supplement.single.multi-record";
    } else if (records.length === 0) {
      globals = emptyGlobals("supplement");
      branch = "supplement.single.empty";
    } else {
      const record = records[0];
      if (record.name && record.account) {
        mode = "strict";
        candidates = [record];
        branch = "supplement.single.complete";
      } else {
        globals = {
          ...emptyGlobals("supplement"),
          ...record,
        };
        branch = "supplement.single.partial";
      }
    }
  } else if (supplementFiles.length > 1) {
    const records = prepare(supplementFiles, "supplement", true);
    const merged = mergeRecords(records);
    trace.steps.push({
      step: "supplement",
      branch: "multi",
      records: records.length,
      merged: merged.length,
    });

    if (merged.length > 1) {
      mode = "strict";
      candidates = merged;
      branch = "supplement.multi.multi-record";
    } else if (merged.length === 0) {
      globals = emptyGlobals("supplement");
      branch = "supplement.multi.empty";
    } else {
      const record = merged[0];
      if (record.name && record.account) {
        mode = "strict";
        candidates = [record];
        branch = "supplement.multi.complete";
      } else {
        globals = {
          ...emptyGlobals("supplement"),
          ...record,
        };
        branch = "supplement.multi.partial";
      }
    }
  } else {
    trace.steps.push({ step: "supplement", branch: "none" });
    branch = "supplement.none";
  }

  if (!mode) {
    if (contractFiles.length === 0) {
      mode = "tolerant";
      candidates = [{ ...globals }];
      branch = "contract.none";
      trace.steps.push({ step: "contract", branch: "none" });
    } else if (contractFiles.length === 1) {
      const records = prepare(contractFiles, "contract", false);
      trace.steps.push({ step: "contract", branch: "single", records: records.length });

      if (records.length > 1) {
        mode = "strict";
        candidates = overlayGlobals(records, globals, { useUrl: false });
        branch = "contract.single.multi-record";
      } else {
        const base = records[0] || makeRecord({}, { source: "contract" });
        const filled = fillFromGlobals(base, globals);
        candidates = [filled];
        mode = filled.name && filled.account ? "strict" : "tolerant";
        branch = `contract.single.${mode}`;
      }
    } else {
      const records = prepare(contractFiles, "contract", true);
      const merged = mergeRecords(records);
      trace.steps.push({
        step: "contract",
        branch: "multi",
        records: records.length,
        merged: merged.length,
      });

      if (merged.length > 1) {
        mode = "strict";
        candidates = overlayGlobals(merged, globals, { useUrl: true });
        branch = "contract.multi.multi-record";
      } else {
        const base = merged[0] || makeRecord({}, { source: "contract" });
        const filled = fillFromGlobals(base, globals);
        candidates = [filled];
        mode = filled.name && filled.account ? "strict" : "tolerant";
        branch = `contract.multi.${mode}`;
      }
    }
  }

  let matched = null;
  const hasUsable = candidates.some(
    (record) => record.name || record.account || record.nameRejected || record.accountRejected
  );
  if (!hasUsable && options.lenient !== true) {
    throw new InputError(
      "NO_EXTRACTED_RECORDS",
      "no usable supplier name/account after extraction and filtering"
    );
  }

  if (mode === "strict") {
    matched = candidates.find((record) => {
      const { nameOk, accountOk } = compareRecord(record, report, "strict");
      return nameOk && accountOk;
    });
  } else {
    const { nameOk, accountOk } = compareRecord(candidates[0], report, "tolerant");
    if (nameOk && accountOk) matched = candidates[0];
  }

  const chosen = matched || pickCandidate(candidates, report);
  const comparison = compareRecord(chosen, report, mode);
  const pass = Boolean(matched);

  trace.steps.push({
    step: "compare",
    branch,
    mode,
    candidates: candidates.length,
    chosen: {
      name: chosen.name,
      account: chosen.account,
      source: chosen.nameSource,
      nameRejected: chosen.nameRejected || "",
      accountRejected: chosen.accountRejected || "",
    },
    nameOk: comparison.nameOk,
    accountOk: comparison.accountOk,
  });
  trace.globals = globals;
  trace.mode = mode;
  trace.branch = branch;

  const issues = pass ? [] : [buildIssue(report, chosen, comparison.nameOk, comparison.accountOk)];
  return { result: buildResult(checkNum, pass, issues), trace };
}

function usage() {
  return [
    "用法: node match.mjs <input.json|-> [选项]",
    "",
    "  --pretty                        格式化输出 JSON",
    "  --debug                         把判定轨迹输出到 stderr",
    "  --no-filter                     关闭 03 的供应商过滤词（雪花/金沙/酒业）",
    "  --lenient                       回退工作流原始语义（允许空报账单、无附件、关闭提取校验）",
    "  --no-validate                   只关闭提取校验，保留输入契约",
    "  --min-confidence <0-1>          低置信度阈值，默认 0.6；记录未带 confidence 时不生效",
    "  --allow-alphanumeric-accounts   允许账号含字母（默认含字母视为不可用）",
    "",
    "输入示例见 templates/match-input.example.json。",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    pretty: false,
    debug: false,
    filter: true,
    file: null,
    help: false,
    lenient: false,
    validate: true,
    minConfidence: 0.6,
    allowAlphanumericAccounts: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pretty") options.pretty = true;
    else if (arg === "--debug") options.debug = true;
    else if (arg === "--no-filter") options.filter = false;
    else if (arg === "--lenient") options.lenient = true;
    else if (arg === "--no-validate") options.validate = false;
    else if (arg === "--allow-alphanumeric-accounts") options.allowAlphanumericAccounts = true;
    else if (arg === "--min-confidence") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("--min-confidence 需要 0-1 之间的数值");
      }
      options.minConfidence = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "-" || !arg.startsWith("-")) {
      if (options.file) throw new Error(`未知参数: ${arg}`);
      options.file = arg;
    } else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  try {
    const file = options.file || "-";
    const raw =
      file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(file), "utf8");
    const input = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const { result, trace } = runMatch(input, options);
    process.stdout.write(
      `${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`
    );
    if (options.debug) {
      process.stderr.write(`${JSON.stringify(trace, null, 2)}\n`);
    }
  } catch (error) {
    const code = error instanceof InputError ? error.code : "INVALID_INPUT";
    process.stderr.write(`${JSON.stringify({ error: error.message, code })}\n`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
