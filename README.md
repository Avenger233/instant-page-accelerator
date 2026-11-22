# 网页加速器 v4

用 **Speculation Rules API** 预取「你正要点的链接」，让页面跳转几乎瞬间完成。

> 独立重写实现，参考 [instant.page](https://instant.page/) 与 [Speculation Rules API](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API) 规范。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 点这里安装：**https://jb.tsgz.xyz/web-accelerator.user.js**
3. 点油猴图标 → **⚙️ 网页加速器设置** 可改配置

> 主安装地址走 CDN，国内直连更快；[web-accelerator.user.js](web-accelerator.user.js) 是本仓库里的同一份源码。

## 它是怎么工作的

悬停链接 → 浏览器预取该文档 → 点击时直接命中缓存，省掉一次网络往返。

和手写 hover 计时的旧方案不同，这里只用一条 **document 规则**：

~~~
{
  "prefetch": [
    {
      "source": "document",
      "where": { "and": [{ "href_matches": "/*" }] },
      "eagerness": "moderate"
    }
  ]
}
~~~

由浏览器自己判断「你是不是要点」—— 省电模式、省流量模式、请求优先级、跨站隐私限制全部自动生效，脚本不需要插手。

## 设置项

| 项 | 默认 | 说明 |
|---|---|---|
| 启用加速 | 开 | |
| 允许跨站预取 | 关 | 跨站预取只在目标站无 Cookie 时生效，且要求匿名化客户端 IP |
| 预取激进度 | 标准 | 保守 / 标准（悬停约 200ms）/ 激进 |
| 兼容模式 | 关 | 改用 link rel=prefetch，适用于严格 CSP 站点 |
| 排除域名 | 空 | 一行一个，支持子域 |
| 排除关键词 | logout 等 | 只匹配路径和查询串，不误伤域名 |

## 已知限制

- **只预取 HTML 文档**，不含子资源（CSS / JS / 图片）。省下的是 TTFB 那一段，典型 100–600ms。想要真正的「秒开」需要 prerender，但那会执行目标页的 JS，副作用风险更高。
- **严格 CSP 的站点**（如 GitHub、X）会拦掉内联 speculation rules，需要勾上兼容模式。
- 浏览器支持：Chrome / Edge 110+、Firefox 163+、Safari 27.3+。不支持时自动降级到 rel=prefetch。

## 和旧版的关系

不是 fork。旧版（油小猴 instantpage、v3.2.2）分别用的是手写 hover + link rel=prefetch、以及每个 URL 建一个 script 标签；这里是按规范重写的独立实现：

- 整页一条 document 规则，不再每个链接建一个 script 标签
- 加了 @noframes，不再在每个 iframe 里空跑
- 移除「商店镜像」改写（原版会把你导向第三方镜像站，且预取了却不改 href）
- 零外部依赖，设置面板用原生 dialog，不再从 CDN 拉 sweetalert2

## 许可证

MIT

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
