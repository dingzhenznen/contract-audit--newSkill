# 02 · 附件合并与合同类文件分类

> 覆盖 workflow 步骤 2 + 3：先把三路文件合成一个列表，再筛出合同与合同补充协议。

## 本文包含

- 一、附件合并与去重：三路来源、递归提取、排除分支、去重键、异常兜底
- 二、合同类附件分类：文件类型路由、通用/对公预付款提示词、输出结构

## 一、附件合并与去重

### 目标

把三路文件来源合并成一个 `file_list`，供文件分类使用：

1. 附件列表
2. 电子影像
3. 报账单 JSON 内部嵌套的文件对象

### 合并顺序

```
file_list = 附件列表 + 电子影像 + 报账单递归提取的文件对象
```

三路都按原顺序追加，最后统一去重。

### 报账单内部文件提取

递归遍历报账单 JSON，收集同时满足下面两个条件的对象：

- 含 `filename` 字段；
- 含 `url` 或 `url_origin` 字段。

命中后复制整个对象，加入 `file_list`。

#### 必须跳过的分支

遍历时，如果**父级键名**是以下任意一个，整个分支跳过，不再向下递归：

- `发票列表`
- `其他信息-预付款核销`

这两类分支里的文件不属于合同质检范围，混进来会增加分类噪声。

#### 递归伪代码

```js
function findFileObjects(root) {
  const result = [];
  function walk(node, parentKey = null) {
    if (node === null || typeof node !== "object") return;
    if (parentKey === "发票列表") return;
    if (parentKey === "其他信息-预付款核销") return;

    if (!Array.isArray(node)
        && Object.prototype.hasOwnProperty.call(node, "filename")
        && (Object.prototype.hasOwnProperty.call(node, "url")
            || Object.prototype.hasOwnProperty.call(node, "url_origin"))) {
      result.push({ ...node });
    }

    if (Array.isArray(node)) {
      node.forEach(item => walk(item, parentKey));
    } else {
      Object.entries(node).forEach(([key, value]) => walk(value, key));
    }
  }
  walk(root);
  return result;
}
```

### 去重键

去重键由「文件名 + URL 主干」组成：

```
key = filename + "_" + baseUrl
baseUrl = (item["url-origin"] || item.url_origin || "").split("?")[0]
```

说明：

- 签名参数（`?sign=...`）不参与去重，否则同一文件每次签名不同会被当成多份。
- `filename` 为空时按空字符串参与，仍可与相同 URL 主干去重。
- 只保留第一次出现的项，后续重复项丢弃。

### 异常兜底

任一步解析失败时，退化为最朴素的合并：

```js
return {
  file_list: [
    ...JSON.parse(attachmentStr || "[]"),
    ...JSON.parse(imageStr || "[]")
  ]
};
```

即：不做报账单内部提取、不做去重，先保证后续有文件可处理。

### 本步骤产出

```json
{
  "file_list": [
    {
      "filename": "合同补充协议.pdf",
      "url": "https://.../contract-supplement.pdf?sign=...",
      "url-origin": "https://.../contract-supplement.pdf"
    }
  ]
}
```

### 对应节点

- `i7srtOdnR7CsNO9V` 附件合并

### 易错点

- 不要把报账单里所有带 `url` 的对象都收进来；必须同时有 `filename`。
- 不要漏掉 `url_origin` 命名变体，老数据可能没有 `url`。
- 去重前不要先按文件名单独去重；同名不同 URL 的文件可能是两份不同附件。
- 跳过「发票列表」时要跳过整棵子树，而不是只跳过当前对象。

## 二、合同类附件分类

### 目标

把 `file_list` 按文件内容分成三类：

- `合同`
- `合同补充协议`
- `其他附件`

只有前两类进入后续供应商信息提取。

### 前置判断

附件数量为 0 时直接返回空对象 `{}`，不做分类。业务类别不是跳过条件，而是提示词分支条件。

准确口径：

| 条件 | 处理 |
|------|------|
| 附件数 == 0 | 返回 `{}` |
| 业务类别 == `对公预付款` | 使用「对公预付款专用提示词」 |
| 其他 | 使用「通用提示词」 |

### 单个文件的类型路由

逐个文件解析链接并转换后，按扩展名分流：

| 文件类型 | 处理 |
|----------|------|
| `.pdf` | 先转成图片，再按「多页同一文档」分类 |
| `.png` / `.jpg` / `.jpeg` | 直接按图片分类 |
| `.xls` / `.xlsx` 等表格 | 不做内容分类，直接归为「其他附件」 |
| 其他 | 先做文档解析，再用解析文本分类 |
| 链接转换失败 | 结束该文件处理，不产生分类结果 |

### 分类提示词（通用）

分类时把同一份文档的多页图片放在一起看，**整份文档只输出一个分类**，不得逐页单独分类。

按优先级从高到低，命中即停止：

#### 1. 其他附件（优先排除）

标题满足任意一条：

- 包含 `请示`
- 包含 `合同备案单`
- 以 `说明` 结尾
- 以 `申请` 结尾
- 以 `确认函` 结尾

或文件内容包含「审批意见」列表，特征为同时出现：

- 审批时间
- 审批环节
- 审批人
- 操作
- 审批意见

→ `其他附件`

#### 2. 合同补充协议

标题包含 `补充`、`变更`、`修正` 中任意一个关键词。

→ `合同补充协议`

#### 3. 合同

标题包含 `合同` 或 `协议`，且标题不同时包含 `项目结算`。

→ `合同`

#### 4. 默认兜底

以上都没命中 → `其他附件`。

### 分类提示词（对公预付款专用）

与通用版的差异只有两处：

- 优先排除项里，`请示` 换成 `签报登记`；
- 「合同」判定里，**以 `请示` 结尾的标题也算合同**。

其余规则相同。

### 输出结构

分类模块返回一个对象，键为文件类型，值为该类型的文件链接数组：

```json
{
  "合同": ["https://.../contract.pdf"],
  "合同补充协议": ["https://.../supplement-1.pdf", "https://.../supplement-2.pdf"],
  "其他附件": ["https://.../approval.pdf"]
}
```

调用方只取 `合同` 与 `合同补充协议` 两个键；缺失的键按空数组处理。

### 对应节点

- `tTGandQ7Qc0BdlEP` 文件分类_合同质检（子流程）
- 子流程内：`turaLRpWrdgQJNPd` 判断器#3、`dAUna8rjspKW9Hzk` / `i6Fdb0ZULEppPoeb` 判断器#4、`valO5DM9TbR3mSWB` / `iORoOI4rpQgixLsX` / `x8l2HlPpFbPorby2` 分类节点、`tB43JH7hEkRwQL70` 结果归并

### 易错点

- 同一份文档的多页必须合并判断；逐页分类会把封面判成其他附件。
- 标题含「项目结算」的协议不要归为合同。
- 含「审批意见」表格的通常是审批单，不要因为标题里有「合同」就归为合同。
- 分类失败或链接失效时，该文件按「其他附件」处理，不要中断整个流程。

