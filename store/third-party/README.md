# 第三方源码与构建资料

本目录为「流光 · M3U8 视频下载」1.2.11 的第三方源码交付材料。它与扩展安装 ZIP 分开提供，不需要把这些源码压缩包上传为 Chrome 扩展运行文件。

## 下载与提供方式

- 第三方源码完整包：`liuguang-third-party-sources-1.2.11.zip`。
- 计划公开下载地址：[GitHub Release 源码附件](https://github.com/van-fe/liuguang-m3u8-downloader/releases/download/v1.2.11/liuguang-third-party-sources-1.2.11.zip)。此地址仅在同名附件上传后生效，发布前需要核验。
- 项目自身源码：[van-fe/liuguang-m3u8-downloader](https://github.com/van-fe/liuguang-m3u8-downloader)。发布包应同时提供对应版本的项目源码标签及项目源码压缩包。

GPL 组件的源码应与二进制版本一起公开提供，不能只在说明中写一个指向上游 `main` 分支的链接。将本目录完整打包为 Release 附件，并保留源码访问说明和许可证，可让接收安装包的人取得所附第三方组件的首选修改形式、原有版权信息和构建脚本。项目自己的授权由根目录 `LICENSE` 说明，第三方组件仍遵循各自许可证。

## 文件索引

| 文件或目录 | 内容 |
| --- | --- |
| `archives/` | 上游不可变 commit 的完整源码快照，另含 Emscripten 指定的 SDL2 源码 ZIP。 |
| `sources.json` | 组件版本、上游仓库、源码 commit、来源 URL、下载大小和 SHA-256；记录本地实际运行文件哈希。 |
| `SHA256SUMS.txt` | 每个源码压缩包的 SHA-256 校验值。 |
| `licenses/` | 从源码快照提取的许可证、版权和专利声明，按组件分目录。原始文本也保留在源码包内。 |
| `evidence/npm-release-metadata.json` | 官方 npm 注册表返回的固定发布版本及发布包校验信息。 |
| `evidence/bundled-core-build-info.txt` | 实际随扩展提供的 WebAssembly 引擎运行 `-version`、`-buildconf` 和一次 x264 编码后的输出。 |
| `evidence/published-core-package-verification.json` | 官方 npm tarball 的 SHA-512 验证，以及随附 JS/WASM 与该发布包内 ESM 文件的逐字节比对。 |
| `evidence/upstream-v12.15.Dockerfile`、`.Makefile` | 上游发布版本原始构建步骤。 |
| `evidence/emscripten-3.1.40-sdl2-port.py` | SDL2 端口版本和官方 SHA-512 来源。 |
| `Dockerfile.pinned` | 将上游构建脚本中的媒体库 Git 引用固定到本次归档 commit 的版本。 |
| `BUILD-SOURCES.md` | 构建环境、步骤、文件对应关系和验证范围。 |

## 重要版本对应关系

`@ffmpeg/core 0.12.10` 和 `@ffmpeg/ffmpeg 0.12.15` 对应的是上游 **`v12.15`** 发布，源码 commit 为 `71aa99d37c02a7b4c435275ca9ef50e612f6efa1`。不要误用上游旧的 `v0.12.10` 标签：该标签实际上包含 core 0.12.6。

实际引擎自报 FFmpeg 5.1.4 和 Emscripten 3.1.40，构建选项与归档 Dockerfile 中 `--enable-gpl`、单线程和媒体库清单一致。官方 npm tarball 按发布元数据的 SHA-512 验证后，所附 JS/WASM 与包内 ESM 文件逐字节一致。SDL2 2.24.2 源码包按 Emscripten 端口内的 SHA-512 值验证。

上游 Dockerfile 对 x264 使用 `4-cores` 分支，对 LAME 使用 `master` 分支。本资料将它们固定为归档 commit；这些分支当前的顶端提交分别发生于 2022-08-22 和 2020-10-29，早于上游 2025-01-07 的发布。没有取得当年的容器构建证明，因此本资料不声称已经复现出逐字节相同的 WASM 文件。能够核对的版本、commit、原始脚本、文件哈希和实际二进制输出均已记录。

## 对外发布核验

1. 将本目录完整打包，保留所有 `archives/`、许可证和构建资料。
2. 将源码包作为与 1.2.11 安装 ZIP 同一 Release 的公开附件上传，核验上文下载链接实际可访问。
3. 核对根目录 `THIRD_PARTY_NOTICES.md`、扩展内的第三方声明和隐私页面使用相同的源码地址。
4. 后续更新任一第三方运行文件时，重新生成资料并记录新的哈希、版本、源码和发布附件，不能继续沿用本次源码包说明。

参考：[上游 v12.15 发布](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15)、[ffmpeg.wasm 许可说明](https://ffmpegwasm.netlify.app/docs/faq/#what-is-the-license-of-ffmpegwasm)、[FFmpeg 许可说明](https://ffmpeg.org/legal.html)、[GNU GPL v2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)。
