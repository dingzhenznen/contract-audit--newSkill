#!/usr/bin/env python3
"""Run the contract-audit skill against the cases in ./cases.

    python3 evals/run_evals.py                  # all cases
    python3 evals/run_evals.py --case 03        # id prefix filter
    python3 evals/run_evals.py --dry-run        # print prompts, run nothing
    python3 evals/run_evals.py --self-test      # check cases + grader offline
    python3 evals/run_evals.py --repeat 3       # flakiness check

Each run shells out to `codex exec --ephemeral`, so it costs tokens and time.
Fixtures are frozen under ./fixtures; regenerate with make_fixtures.py.

Exit code: 0 = all passed, 1 = at least one failure, 2 = bad usage.
"""

import argparse
import fnmatch
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

EVALS = Path(__file__).resolve().parent
SKILL = EVALS.parent / "SKILL.md"
CASES = EVALS / "cases"
FIXTURES = EVALS / "fixtures"
REPORTS = EVALS / "reports"
FAILURES_DIR = REPORTS / "failures"

RISK = {"通过": 0, "低风险": 1, "中风险": 2, "高风险": 3}
DATE_RANGE = re.compile(r"^\d{4}年\d{1,2}月\d{1,2}日\s*-\s*\d{4}年\d{1,2}月\d{1,2}日$")
DATE_TOKEN = re.compile(r"(\d{4})\s*[-年/]\s*(\d{1,2})\s*[-月/]\s*(\d{1,2})")
TRANSIENT = ("Reconnecting", "stream disconnected", "error sending request", "timed out", "429", "502", "503")


# ---------------------------------------------------------------- case loading


def load_case(path):
    case = json.loads(path.read_text(encoding="utf-8"))
    case["_path"] = str(path)
    case["_fixtures"] = []
    for entry in case["form"].get("contractFiles", []):
        ref = entry.get("downloadUrl", "")
        if ref.startswith("@fixture:"):
            target = (FIXTURES / case["id"] / ref.split(":", 1)[1]).resolve()
            entry["downloadUrl"] = str(target)
            case["_fixtures"].append(target)
    return case


def truth_text(case):
    path = FIXTURES / case["id"] / "truth.txt"
    return path.read_text(encoding="utf-8") if path.exists() else ""


def fixture_hash(case):
    digest = hashlib.sha256()
    for path in case["_fixtures"]:
        digest.update(path.read_bytes())
    return digest.hexdigest()


def build_prompt(case):
    return (
        f"使用 {SKILL} 这个 skill 完成任务。\n\n"
        "【输入 1 · 规则集】\n"
        + json.dumps(case["ruleSet"], ensure_ascii=False, indent=2)
        + "\n\n【输入 2 · 表单数据 + 合同文件列表】\n"
        + json.dumps(case["form"], ensure_ascii=False, indent=2)
        + "\n\n"
        + case["prompt"]
    )


# -------------------------------------------------------------------- grading


def normalize(text):
    return re.sub(r"\s+", "", text or "")


def grade(case, raw, truth):
    """Return (failures, parsed_or_None)."""
    expect = case.get("expect", {})
    fails = []
    text = (raw or "").strip()
    if not text:
        return ["输出为空"], None

    probe = text
    if probe.startswith("```"):
        fails.append("输出被 ``` 代码围栏包裹")
        probe = re.sub(r"^```[a-zA-Z0-9]*\n?", "", probe)
        probe = re.sub(r"\n?```$", "", probe).strip()
    elif "```" in text:
        fails.append("输出中途出现 ``` 代码围栏")

    try:
        data = json.loads(probe)
    except Exception as exc:  # noqa: BLE001 - want the message
        return fails + [f"输出不是合法 JSON: {exc}"], None
    if not isinstance(data, dict):
        return fails + ["输出顶层不是对象"], None

    for key in ("riskLevel", "summary", "checkRes"):
        if key not in data:
            fails.append(f"缺少顶层字段 {key}")

    if "riskLevel" in expect and data.get("riskLevel") != expect["riskLevel"]:
        fails.append(f"riskLevel={data.get('riskLevel')!r}，期望 {expect['riskLevel']!r}")

    summary = data.get("summary")
    if not isinstance(summary, str):
        fails.append("summary 不是字符串")
        summary = ""
    if len(summary) > 100:
        fails.append(f"summary 超过 100 字（{len(summary)}）")
    want_summary = expect.get("summary", {})
    if "equals" in want_summary and summary != want_summary["equals"]:
        fails.append(f"summary={summary!r}，期望 {want_summary['equals']!r}")
    if "maxChars" in want_summary and len(summary) > want_summary["maxChars"]:
        fails.append(f"summary 超过 {want_summary['maxChars']} 字（{len(summary)}）")

    items = case["ruleSet"]["items"]
    rules = [item["fieldCode"] for item in items]
    names = {item["fieldCode"]: item["fieldName"] for item in items}
    check_res = data.get("checkRes")
    if not isinstance(check_res, list):
        fails.append("checkRes 不是数组")
        return fails, data
    check_res = [entry for entry in check_res if isinstance(entry, dict)]

    want_count = expect.get("checkResCount", len(rules))
    if len(check_res) != want_count:
        fails.append(f"checkRes 条数 {len(check_res)}，期望 {want_count}")
    want_order = expect.get("fieldOrder", rules)
    got_order = [entry.get("fieldCode") for entry in check_res]
    if got_order != want_order:
        fails.append(f"fieldCode 序列 {got_order}，期望 {want_order}")

    for entry in check_res:
        code = entry.get("fieldCode")
        if code in names and entry.get("fieldName") != names[code]:
            fails.append(f"{code} 的 fieldName 被改写为 {entry.get('fieldName')!r}")
        if entry.get("riskLevel") not in RISK:
            fails.append(f"{code} 的 riskLevel 非法: {entry.get('riskLevel')!r}")

    valid = [entry for entry in check_res if entry.get("riskLevel") in RISK]
    if len(valid) == len(check_res) and valid:
        top = max(valid, key=lambda entry: RISK[entry["riskLevel"]])["riskLevel"]
        if data.get("riskLevel") != top:
            fails.append(f"外层 riskLevel 不是最高档：{data.get('riskLevel')!r} vs {top!r}")

    if expect.get("passedItemsEmptyAuditDesc", True):
        for entry in check_res:
            if entry.get("riskLevel") == "通过" and entry.get("auditDesc", "") != "":
                fails.append(f"{entry.get('fieldCode')} 为通过但 auditDesc 非空")

    by_code = {entry.get("fieldCode"): entry for entry in check_res}
    for spec in expect.get("items", []):
        code = spec["fieldCode"]
        entry = by_code.get(code)
        if entry is None:
            fails.append(f"缺少 {code} 的结果")
            continue
        desc = entry.get("auditDesc", "")
        if "riskLevel" in spec and entry.get("riskLevel") != spec["riskLevel"]:
            fails.append(f"{code} riskLevel={entry.get('riskLevel')!r}，期望 {spec['riskLevel']!r}")
        if "auditDescEquals" in spec and desc != spec["auditDescEquals"]:
            fails.append(f"{code} auditDesc={desc!r}，期望 {spec['auditDescEquals']!r}")
        for piece in spec.get("auditDescContains", []):
            if piece not in desc:
                fails.append(f"{code} auditDesc 缺少 {piece!r}")
        for piece in spec.get("auditDescNotContains", []):
            if piece in desc:
                fails.append(f"{code} auditDesc 不应包含 {piece!r}")
        if "auditDescRegex" in spec and not re.search(spec["auditDescRegex"], desc):
            fails.append(f"{code} auditDesc 不匹配 {spec['auditDescRegex']!r}")
        if "auditDescMaxChars" in spec and len(desc) > spec["auditDescMaxChars"]:
            fails.append(f"{code} auditDesc 超过 {spec['auditDescMaxChars']} 字")

    for piece in expect.get("forbiddenSubstrings", []):
        if piece in text:
            fails.append(f"输出含禁止内容 {piece!r}")

    if "maxOutputChars" in expect and len(text) > expect["maxOutputChars"]:
        fails.append(f"输出长度 {len(text)} 超过 {expect['maxOutputChars']}")

    if expect.get("citationsFromTruth", True) and truth:
        source = truth + "\n" + json.dumps(case["form"], ensure_ascii=False)
        haystack = normalize(source)
        dates = {(int(y), int(m), int(d)) for y, m, d in DATE_TOKEN.findall(source)}
        for entry in check_res:
            for quoted in re.findall(r"'([^']+)'", entry.get("auditDesc", "")):
                pieces = quoted.split("-") if DATE_RANGE.match(quoted.strip()) else [quoted]
                for piece in pieces:
                    found = DATE_TOKEN.findall(piece)
                    if found and len(found) == 1:
                        key = tuple(int(part) for part in found[0])
                        if key not in dates:
                            fails.append(f"{entry.get('fieldCode')} 引文日期在合同/表单中找不到: {quoted!r}")
                    elif normalize(piece) and normalize(piece) not in haystack:
                        fails.append(f"{entry.get('fieldCode')} 引文在合同/表单中找不到: {quoted!r}")

    return fails, data


# ------------------------------------------------------------------- execution


def run_once(case, args):
    prompt = build_prompt(case)
    before = fixture_hash(case)
    started = time.time()
    with tempfile.TemporaryDirectory(prefix="contract-eval-") as tmp:
        out_file = Path(tmp) / "last-message.txt"
        cmd = [
            "codex", "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "-C", tmp,
            "-s", args.sandbox,
            "--color", "never",
            "-o", str(out_file),
        ]
        if args.model:
            cmd += ["-m", args.model]
        cmd.append(prompt)
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=args.timeout,
                                  stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return "", ["超时（%.0fs）" % args.timeout], time.time() - started, ""
        raw = out_file.read_text(encoding="utf-8") if out_file.exists() else (proc.stdout or "")
        stderr = proc.stderr or ""
    elapsed = time.time() - started
    if fixture_hash(case) != before:
        return raw, ["fixture 被修改（原件只读约束不通过）"], elapsed, stderr
    fails, _ = grade(case, raw, truth_text(case))
    if proc.returncode != 0 and not raw.strip():
        hint = ""
        if "Operation not permitted" in stderr:
            hint = "（若在沙箱内运行，请改用可启动 codex 的终端执行）"
        fails.append(f"codex exec 退出码 {proc.returncode}{hint}: {stderr.strip()[-300:]}")
    return raw, fails, elapsed, stderr


# ---------------------------------------------------------------------- checks


def lint_case(case):
    problems = []
    items = case["ruleSet"]["items"]
    codes = [item["fieldCode"] for item in items]
    expect = case["expect"]
    if expect.get("fieldOrder", codes) != codes:
        problems.append("fieldOrder 与规则集 items 顺序不一致")
    if expect.get("checkResCount", len(codes)) != len(codes):
        problems.append("checkResCount 与 items 数量不一致")
    for spec in expect.get("items", []):
        if spec["fieldCode"] not in codes:
            problems.append(f"断言引用了不存在的 fieldCode: {spec['fieldCode']}")
    levels = [spec.get("riskLevel") for spec in expect.get("items", []) if spec.get("riskLevel")]
    if levels and len(levels) == len(items):
        top = max(levels, key=lambda level: RISK[level])
        if expect.get("riskLevel") != top:
            problems.append(f"expect.riskLevel={expect.get('riskLevel')} 与逐项最高档 {top} 不一致")
    for fixture in case["_fixtures"]:
        if not fixture.exists():
            problems.append(f"fixture 不存在: {fixture}（先跑 make_fixtures.py）")
    return problems


def self_test(cases):
    fake_case = {
        "id": "self-test",
        "ruleSet": {"items": [{"fieldCode": "A", "fieldName": "经销商名称"}]},
        "form": {"customerName": "X"},
        "expect": {
            "riskLevel": "中风险",
            "summary": {"equals": "共1项风险。中风险1项：经销商名称不一致。"},
            "checkResCount": 1,
            "fieldOrder": ["A"],
            "items": [{
                "fieldCode": "A",
                "riskLevel": "中风险",
                "auditDescEquals": "合同中经销商名称为'Y'，表单中为'X'，不一致",
            }],
        },
    }
    good = {
        "riskLevel": "中风险",
        "summary": "共1项风险。中风险1项：经销商名称不一致。",
        "checkRes": [{
            "fieldCode": "A",
            "fieldName": "经销商名称",
            "riskLevel": "中风险",
            "auditDesc": "合同中经销商名称为'Y'，表单中为'X'，不一致",
        }],
    }
    bad = json.loads(json.dumps(good))
    bad["checkRes"][0]["riskLevel"] = "通过"
    bad["riskLevel"] = "通过"
    bad["checkRes"][0]["auditDesc"] = "看起来没问题"

    failures = []
    if grade(fake_case, json.dumps(good, ensure_ascii=False), "甲方：Y")[0]:
        failures.append("grader 把正确输出判成了失败")
    if not grade(fake_case, json.dumps(bad, ensure_ascii=False), "甲方：Y")[0]:
        failures.append("grader 没抓到错误输出")
    if not grade(fake_case, "```json\n" + json.dumps(good, ensure_ascii=False) + "\n```", "甲方：Y")[0]:
        failures.append("grader 没抓到代码围栏")

    for case in cases:
        failures.extend(f"{case['id']}: {problem}" for problem in lint_case(case))
    return failures


# ------------------------------------------------------------------------ main


def main():
    parser = argparse.ArgumentParser(description="Run contract-audit skill evals")
    parser.add_argument("--case", help="按 id 前缀/通配过滤，如 03 或 '0*'")
    parser.add_argument("--dry-run", action="store_true", help="只打印 prompt，不执行")
    parser.add_argument("--self-test", action="store_true", help="离线检查用例与判分器")
    parser.add_argument("--list", action="store_true", help="列出用例")
    parser.add_argument("--repeat", type=int, default=1, help="每条用例重复次数（查抖动）")
    parser.add_argument("--timeout", type=int, default=600, help="单次运行超时秒数")
    parser.add_argument("--retries", type=int, default=2, help="空输出且疑似断网时重跑次数")
    parser.add_argument("--model", help="传给 codex exec 的模型")
    parser.add_argument("--sandbox", default="read-only",
                        choices=["read-only", "workspace-write", "danger-full-access"])
    args = parser.parse_args()

    paths = sorted(CASES.glob("*.json"))
    if args.case:
        paths = [path for path in paths
                 if fnmatch.fnmatch(path.stem, args.case)
                 or fnmatch.fnmatch(path.stem, args.case + "*")]
    if not paths:
        sys.exit(f"没有匹配的用例（{CASES}）")

    cases = [load_case(path) for path in paths]

    if args.list:
        for case in cases:
            print(f"{case['id']:<28} {case['tier']:<11} {case['title']}")
        return 0

    if args.self_test:
        problems = self_test(cases)
        if problems:
            for problem in problems:
                print(f"FAIL {problem}")
            return 1
        print(f"self-test ok: {len(cases)} 个用例结构合法，判分器行为符合预期")
        return 0

    if args.dry_run:
        for case in cases:
            print("=" * 72)
            print(f"{case['id']} · {case['title']}")
            print(f"fixtures: {[str(p) for p in case['_fixtures']]}")
            print("-" * 72)
            print(build_prompt(case))
        return 0

    REPORTS.mkdir(exist_ok=True)
    results = []
    failures = 0
    started = time.time()

    for case in cases:
        attempts = []
        for _ in range(max(1, args.repeat)):
            raw, fails, elapsed, stderr = run_once(case, args)
            retry = 0
            while (not raw.strip() and retry < args.retries
                   and any(mark in stderr for mark in TRANSIENT)):
                retry += 1
                extra_raw, fails, extra_elapsed, stderr = run_once(case, args)
                raw, elapsed = extra_raw, elapsed + extra_elapsed
            attempts.append({"failures": fails, "elapsed": elapsed})
            if fails:
                break
        worst = next((a for a in attempts if a["failures"]), attempts[0])
        status = "FAIL" if worst["failures"] else "PASS"
        if worst["failures"]:
            failures += 1
            FAILURES_DIR.mkdir(parents=True, exist_ok=True)
            (FAILURES_DIR / f"{case['id']}.txt").write_text(
                "STDERR\n" + (stderr or "") + "\n\nRAW\n" + (raw or ""),
                encoding="utf-8")
        print(f"{case['id']:<28} {status:<5} {len(case['ruleSet']['items']):>2} items "
              f"{worst['elapsed']:>6.1f}s")
        for message in worst["failures"]:
            print(f"    - {message}")
        results.append({
            "id": case["id"],
            "status": status,
            "elapsed": round(worst["elapsed"], 2),
            "failures": worst["failures"],
        })

    total = time.time() - started
    report = {
        "ran_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "total": len(cases),
        "failed": failures,
        "elapsed": round(total, 1),
        "results": results,
    }
    (REPORTS / "latest.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print("-" * 72)
    print(f"{len(cases) - failures}/{len(cases)} passed in {total:.0f}s → {REPORTS / 'latest.json'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
