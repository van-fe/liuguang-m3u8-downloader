# 第三方组件声明

本项目的运行时包含以下第三方组件。各组件的版权和许可条款由其原作者保留；项目构建时将相关许可文本放入扩展产物的 `licenses/` 目录。本文件用于说明组件来源，不能替代完整许可证。

本项目自有代码由发布者 van-fe 按 GPL-2.0-or-later 发布，完整文本见 `LICENSE`。该授权不替代下列第三方组件各自适用的许可证。当前发布版本的扩展源码、对应第三方源码快照、构建配方、许可和校验值可从 [v1.2.11 发布页](https://github.com/van-fe/liuguang-m3u8-downloader/releases/tag/v1.2.11) 获取；第三方源码包为 [liuguang-third-party-sources-1.2.11.zip](https://github.com/van-fe/liuguang-m3u8-downloader/releases/download/v1.2.11/liuguang-third-party-sources-1.2.11.zip)。

| 组件 | 固定版本 | 上游声明的许可证 | 用途 |
| --- | --- | --- | --- |
| `@ffmpeg/ffmpeg` | `0.12.15` | MIT | 浏览器中的 FFmpeg Worker 封装与调用。 |
| `@ffmpeg/core` | `0.12.10` | GPL-2.0-or-later | 单线程 FFmpeg WebAssembly 引擎，用于本地音视频封装。 |
| `hls.js` | `1.6.13` | Apache-2.0 | 浏览器 HLS 视频预览及音轨播放。 |

版本由 `package.json` 固定，依赖树由 `package-lock.json` 锁定。类型声明等构建依赖以实际安装包中的声明为准。Playwright 是开发测试工具，不会打包到扩展运行时。

## ffmpeg.wasm

- 项目与源码：[ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)。
- `@ffmpeg/ffmpeg` 元数据：[上游 packages/ffmpeg/package.json](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/packages/ffmpeg/package.json)。
- `@ffmpeg/core` 元数据：[上游 packages/core/package.json](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/packages/core/package.json)。
- 发布版本：[上游 Releases](https://github.com/ffmpegwasm/ffmpeg.wasm/releases)。
- 构建说明：[ffmpeg.wasm Contribution](https://ffmpegwasm.netlify.app/docs/contribution/)。
- 组件许可区别：[ffmpeg.wasm 官方 FAQ](https://ffmpegwasm.netlify.app/docs/faq/#what-is-the-license-of-ffmpegwasm)。

上游维护者包括 Jerome Wu 及 ffmpeg.wasm 贡献者。`@ffmpeg/ffmpeg` 的 JavaScript 封装采用 MIT；`@ffmpeg/core` 的 WebAssembly 包含由 FFmpeg 和其他媒体库编译的代码，沿用这些组件的相应许可。核心包元数据声明为 GPL-2.0-or-later，不能将整个引擎视作 MIT 组件。

## FFmpeg 与核心包内的媒体库

FFmpeg 源码与许可说明见 [FFmpeg 官方网站](https://ffmpeg.org/legal.html) 和 [FFmpeg 源码仓库](https://git.ffmpeg.org/ffmpeg.git)。ffmpeg.wasm 核心的构建配置和所用外部库可在 [上游构建源码](https://github.com/ffmpegwasm/ffmpeg.wasm) 中查询；外部库各自保留原许可证。核心编译产物直接从固定版本 npm 包复制，本项目没有修改核心 WebAssembly 二进制。

大文件支持由本项目的 Worker 和文件系统适配代码实现：使用浏览器 OPFS 保存分片，结合 Emscripten WORKERFS 按需读取输入，并将 MP4 写回磁盘。该适配层没有修改上游 `@ffmpeg/core` WebAssembly 二进制；原有核心及封装组件的许可证保持不变。文件系统行为参考 [Emscripten 文件系统 API](https://emscripten.org/docs/api_reference/Filesystem-API.html) 和 [Chrome 团队的 OPFS 说明](https://web.dev/articles/origin-private-file-system)。

分发含该核心的构建产物时，应保留完整许可证、版权声明和相应源码获取信息，并按所适用组件的许可条款处理。`licenses/` 内的 GPL 文本适用于 GPL 组件，MIT 文本适用于 MIT 封装；这些文本不会改变其他组件自身的许可证。

## 开发工具

预览播放器使用 [video-dev/hls.js](https://github.com/video-dev/hls.js)，原始许可已附于 `licenses/hls.js-LICENSE`。播放器代码随扩展本地打包，不从 CDN 加载。

测试使用 [Microsoft Playwright](https://github.com/microsoft/playwright)，其上游采用 Apache-2.0。测试所调用的本机 FFmpeg 由开发者环境提供，不会作为原生程序附带在扩展包中。
