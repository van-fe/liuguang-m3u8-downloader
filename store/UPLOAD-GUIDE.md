# 流光 Chrome 应用商店上传包说明

本目录中的脚本和材料用于准备发布，不会自动接受协议、付费、提交审核或操作 Chrome 应用商店账户。

## 重新生成

在项目根目录运行：

```powershell
npm ci
npm test
npm run build:store
```

执行前必须完成 `store/assets/` 中与当前版本一致的真实界面截图。第三方源码附件可以独立准备；若 `store/third-party/liuguang-third-party-sources-<版本>.zip` 尚未生成，脚本会先生成较小的上架资料包，并在报告中明确标记源码附件未完成。附件齐全后重新构建，再公开分发和送审。临时目录和工具缓存使用项目 E 盘路径，不在 C 盘建立测试配置或大型副本。

## 哪个文件上传到哪里

`dist/chrome-web-store/` 中的文件用途不同：

| 文件 | 用途 |
| --- | --- |
| `liuguang-m3u8-<版本>.zip` | **只有这个文件上传至 Chrome Web Store 的扩展包上传框。**根目录直接包含 `manifest.json`，不含测试配置和内部测试报告。 |
| `liuguang-store-materials-<版本>.zip` | 解压后取得可粘贴文案、权限与数据说明、截图、审核步骤及静态网站。不要把它作为扩展包上传。 |
| `liuguang-third-party-sources-<版本>.zip` | 与扩展一同公开提供的第三方对应源码、构建文件和许可资料；作为 GitHub Release 附件发布，不放进商店扩展包。 |
| `SHA256SUMS`、`build-report.json` | 用于核对版本、文件大小、SHA-256、图片尺寸和构建检查结果。 |

大体积源码附件优先以硬链接放入输出目录，不额外复制相同数据。重新构建会替换本版本输出文件；保留源文件和已交付的版本附件。

## 填写与审核

1. 注册并验证开发者账户，按控制台要求提供真实账户联系信息和两步验证。此准备包不会代填法律身份、邮箱、地址、税务或付款信息。
2. 上传 `liuguang-m3u8-<版本>.zip`。中文文案位于 `materials/listing/`；详细操作单位于 `materials/review/submission-guide.zh_CN.txt`。
3. 使用 `materials/assets/icon-128.png` 及四张 `screenshot-*.png`；小宣传图和横幅是另行提供的可选图片。素材源自真实插件界面与自生成演示视频。
4. 在 Privacy practices 中按 `dashboard-fields.json`、`permissions.zh_CN.txt` 和 `data-practices.zh_CN.txt` 核对权限、数据类型及 Limited Use 认证。不能填写“完全不处理用户数据”。
5. 隐私政策填写 `https://van-fe.github.io/liuguang-m3u8-downloader/privacy.html`。送审前确认主页、隐私页、源码、支持页和演示页均可在未登录浏览器访问。
6. 审核说明使用 `reviewer-notes.en.txt`。演示媒体为本项目自行生成，既不需要账号，也不需要 Cookie、会员或付费访问权限。
7. 根据真实用途选择分发方式。Unlisted 也需要审核；仅在准备就绪后由发布者点击最终送审按钮。此文件不表示 Google 已批准扩展。

## 公开源码与隐私网站

仓库：<https://github.com/van-fe/liuguang-m3u8-downloader>。自有代码按 GPL-2.0-or-later 授权；第三方代码保留原许可证。

`docs/` 是由 `store/site/`、扩展隐私政策和授权演示自动生成的 GitHub Pages 内容，包含 `.nojekyll`。项目网站使用 GitHub Pages 从 `main:/docs` 发布；配置 Pages 和上传源码附件由发布者另行完成。不要用无法公开访问或需要登录的页面代替隐私政策网址。

官方填写依据：

- <https://developer.chrome.com/docs/webstore/publish>
- <https://developer.chrome.com/docs/webstore/cws-dashboard-listing>
- <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- <https://developer.chrome.com/docs/webstore/images>

商店账户联系方式、认证、分发与最终送审仍需发布者按实际情况确认。
