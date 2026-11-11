# 02 · 附件合并与去重

## 目标

把三路文件来源合并成一个 `file_list`，供文件分类使用：

1. 附件列表
2. 电子影像
3. 报账单 JSON 内部嵌套的文件对象

## 合并顺序

```
file_list = 附件列表 + 电子影像 + 报账单递归提取的文件对象
```

三路都按原顺序追加，最后统一去重。

## 报账单内部文件提取

递归遍历报账单 JSON，收集同时满足下面两个条件的对象：

- 含 `filename` 字段；
- 含 `url` 或 `url_origin` 字段。

命中后复制整个对象，加入 `file_list`。

### 必须跳过的分支

遍历时，如果**父级键名**是以下任意一个，整个分支跳过，不再向下递归：

- `发票列表`
- `其他信息-预付款核销`

这两类分支里的文件不属于合同质检范围，混进来会增加分类噪声。

### 递归伪代码

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

## 去重键

去重键由「文件名 + URL 主干」组成：

```
key = filename + "_" + baseUrl
baseUrl = (item["url-origin"] || item.url_origin || "").split("?")[0]
```

说明：

- 签名参数（`?sign=...`）不参与去重，否则同一文件每次签名不同会被当成多份。
- `filename` 为空时按空字符串参与，仍可与相同 URL 主干去重。
- 只保留第一次出现的项，后续重复项丢弃。

## 异常兜底

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

## 本步骤产出

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

## 对应节点

- `i7srtOdnR7CsNO9V` 附件合并

## 易错点

- 不要把报账单里所有带 `url` 的对象都收进来；必须同时有 `filename`。
- 不要漏掉 `url_origin` 命名变体，老数据可能没有 `url`。
- 去重前不要先按文件名单独去重；同名不同 URL 的文件可能是两份不同附件。
- 跳过「发票列表」时要跳过整棵子树，而不是只跳过当前对象。
