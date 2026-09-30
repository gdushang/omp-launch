// omp-launch: postinstall — fetch a static ffmpeg only when FFMPEG_BIN, PATH and the local copy all lack one.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/** ffmpeg-static release whose asset naming (`ffmpeg-<platform>-<arch>.gz`) we reuse. */
const RELEASE = "b6.1.1";
const BASE_URL = (
	process.env.FFMPEG_BINARIES_URL || "https://github.com/eugeneware/ffmpeg-static/releases/download"
).replace(/\/+$/, "");
const EXE_NAME = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
const BIN_DIR = join(AGENT_DIR, "launch", "bin");
const TARGET = join(BIN_DIR, EXE_NAME);

/** True when `ffmpeg` resolves on PATH: the copy the extension itself would spawn. */
function onPath() {
	const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	const dirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
	return dirs.some(dir => dir && exts.some(ext => existsSync(join(dir, `ffmpeg${ext}`))));
}

const explicit = process.env.FFMPEG_BIN;
if (explicit && existsSync(explicit)) {
	console.log(`omp-launch：FFMPEG_BIN 指向 ${explicit}，跳过下载`);
	process.exit(0);
}

if (onPath()) {
	console.log("omp-launch：PATH 上已有 ffmpeg，跳过下载");
	process.exit(0);
}

if (existsSync(TARGET)) {
	console.log(`omp-launch：本地已有 ${TARGET}，跳过下载`);
	process.exit(0);
}

const url = `${BASE_URL}/${RELEASE}/ffmpeg-${process.platform}-${process.arch}.gz`;
console.log(`omp-launch：PATH 与本地都没有 ffmpeg，开始下载 ${url}`);
console.log("omp-launch：约 36MB，视网络可能需要几分钟（可用 FFMPEG_BIN 指向已有 ffmpeg 跳过）");

let response;
try {
	response = await fetch(url);
} catch (error) {
	console.error(`omp-launch：下载失败：${error instanceof Error ? error.message : String(error)}`);
	console.error("omp-launch：可改用系统 ffmpeg —— 放进 PATH，或设置 FFMPEG_BIN=<ffmpeg 路径>");
	process.exit(1);
}

if (!response.ok) {
	console.error(`omp-launch：下载失败（HTTP ${response.status}）：${url}`);
	process.exit(1);
}

const binary = gunzipSync(Buffer.from(await response.arrayBuffer()));
mkdirSync(BIN_DIR, { recursive: true });
writeFileSync(TARGET, binary);
if (process.platform !== "win32") chmodSync(TARGET, 0o755);
console.log(`omp-launch：已写入 ${TARGET}（${(binary.length / 1e6).toFixed(1)}MB）`);
