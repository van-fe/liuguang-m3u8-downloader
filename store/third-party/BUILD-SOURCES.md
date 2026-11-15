# 第三方引擎源码与构建步骤

## 本次提供的源码

运行时固定依赖为 `@ffmpeg/core 0.12.10`、`@ffmpeg/ffmpeg 0.12.15` 和 `hls.js 1.6.13`。`sources.json` 包含这些包的上游元数据、实际文件 SHA-256 和源码快照信息；`archives/` 同时提供 FFmpeg、所链接媒体库、Emscripten 及其 SDL2 端口的源码，相关版权和许可文本位于原源码内及 `licenses/`。

项目修改的是自己的 `extension/media-worker.js` 和 `extension/lib/opfs-fs.js`，用于将 FFmpeg 的文件输入输出连接到浏览器磁盘缓存。发布时未修改上游 `ffmpeg-core.wasm` 或 `ffmpeg-core.js`。项目自身的完整可修改源码随对应 GitHub 标签和项目源码附件提供。

## 上游引擎构建环境

- Linux 容器构建环境，Docker Buildx 和 GNU Make。
- 基础镜像：`emscripten/emsdk:3.1.40`。
- FFmpeg：5.1.4，源码提交 `4729204c17f756e186d622060088371d10b34f7e`。
- 单线程构建：`FFMPEG_ST=yes`，优化参数 `-O3 -msimd128`。
- Emscripten：3.1.40，提交 `5c27e79dd0a9c4e27ef2326841698cdd4f6b5784`。
- 启用 GPL、x264、x265、libvpx、LAME、Theora、Vorbis、Opus、zlib、WebP、FreeType、FriBidi、libass 和 zimg；构建选项原文见 `evidence/bundled-core-build-info.txt`。
- 组件版本及完整 commit 清单以 `sources.json` 为准。SDL2 端口版本为 2.24.2。

## 构建方法

1. 校验 `SHA256SUMS.txt`，解压 `archives/ffmpeg.wasm-71aa99d37c02.tar.gz`，进入其根目录。该归档含 `src/`、`build/`、`Makefile` 和原始 `Dockerfile`。
2. 若要固定 Git 输入，将本目录 `Dockerfile.pinned` 复制到该根目录，作为 `Dockerfile` 使用；它保留原构建流程，固定各媒体库到 `sources.json` 所列 commit。
3. 按上游 Makefile 执行：

   ```sh
   make prd
   ```

   等价的核心命令是：

   ```sh
   EXTRA_CFLAGS="-O3 -msimd128" FFMPEG_ST=yes \
     docker buildx build --build-arg EXTRA_CFLAGS --build-arg FFMPEG_ST \
       -o ./packages/core .
   ```

4. 输出在 `packages/core/dist/esm/ffmpeg-core.js`、`packages/core/dist/esm/ffmpeg-core.wasm`，另有 UMD 版本。
5. JavaScript Worker 封装源码在同一快照的 `packages/ffmpeg/src/`。根目录按上游锁文件安装构建依赖后，执行该包的 `npm run build`。项目实际使用 ESM 输出。
6. `hls.js` 的源码快照固定到 `abb6945bd29eadc04c25b2522528ca6aa619992f`；按该快照的 `package.json` 和锁文件安装依赖并执行 `npm run build`，运行包使用 `dist/hls.min.js`。

本次没有安装大型 Docker 构建镜像或重新编译媒体引擎，因此未验证逐字节可复现性。上述命令由归档的上游构建脚本整理，执行仍需要容器镜像及构建工具；若使用源码归档替代 Git 下载，可在对应构建阶段将归档解压至 `/src`，保留同一 `build/*.sh` 和参数。

## 需要和不需要包含的子模块

上游 `ffmpeg.wasm` 的 `testdata` 子模块和 zimg 的 `test/extra/googletest` 是测试输入，没有编入本扩展的媒体引擎。本资料保留原 `.gitmodules` 和引用信息，但不附带这些测试素材。编译器可执行文件、Docker 基础镜像、系统包管理器提供的通用构建工具不是扩展随附运行文件。

源码包包含所分发组件的首选修改形式和用于构建的项目脚本；这些说明并不替代各组件许可证。后续如修改引擎或使用不同工具链，应记录实际修改和新的来源信息。
