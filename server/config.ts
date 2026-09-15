/**
 * 配置：**一个可选的 `.env` + 环境变量**，没有配置文件、没有命令行参数。
 *
 * ## 为什么是 `.env` 而不是别的
 *
 * 这个工程的使用场景是"某人 clone 下来想接自己的模型"。那种场景下最短的路径是：
 * `cp .env.example .env` → 填三行 → `npm run dev`。配置文件（JSON/YAML）要解释放哪、
 * 什么格式；命令行参数每次都要带上。`.env` 还天然进了 `.gitignore`，token 不会被误提交。
 *
 * 自己写解析而不是引 `dotenv`：格式就三行（`KEY=VALUE`、`#` 注释、可选的引号），
 * 而这个工程的运行时依赖刻意收得很紧（服务端只有 `@ag-ui/core`）。
 *
 * ## 优先级
 *
 * `process.env` > `.env` 文件。**已存在的环境变量不会被 `.env` 覆盖** ——
 * 容器里注入的变量不该被仓库里的一份文件顶掉。
 *
 * ## 不配模型会怎样
 *
 * 不配也能跑：退到 `ScriptedAgent`（确定性的剧本演示）。这不是"降级"，
 * 是这个工程本来的形态 —— M1 就是脚本化的，M2 才是接模型。
 * 见 README「两种模式」。
 */
import fs from 'node:fs';
import path from 'node:path';

export type AgentMode = 'scripted' | 'llm';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

export interface AppConfig {
  /** 实际用哪种 agent。 */
  mode: AgentMode;
  /** 为什么是这种模式 —— 启动横幅里会打出来，省得人猜"为什么没走模型"。 */
  reason: string;
  /** 只有 mode === 'llm' 时有值。 */
  llm: LlmConfig | null;
  /** 从哪个文件读到的配置（没读到就是 null）。 */
  envFile: string | null;
}

/** `.env` 里认得的键（用于启动横幅里报"你配了什么"）。 */
export const ENV_KEYS = [
  'ICE_LLM_API_KEY',
  'ICE_LLM_BASE_URL',
  'ICE_LLM_MODEL',
  'ICE_LLM_TEMPERATURE',
  'ICE_LLM_TIMEOUT_MS',
  'ICE_LLM_MODE',
] as const;

/** 也认这几个业界通用的名字 —— 很多人本机已经有它们了，不用再抄一遍。 */
const FALLBACK_KEYS: Record<string, string[]> = {
  ICE_LLM_API_KEY: ['OPENAI_API_KEY'],
  ICE_LLM_BASE_URL: ['OPENAI_BASE_URL', 'OPENAI_API_BASE'],
  ICE_LLM_MODEL: ['OPENAI_MODEL'],
};

/**
 * 极简 `.env` 解析。返回 `KEY → VALUE`。
 *
 * 支持：空行、`#` 注释、`KEY=VALUE`、值两边的成对引号、`export KEY=VALUE`。
 * 不支持：多行值、变量插值 —— 用不上，不写。
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

/** 找一个 `.env`：先看仓库根，再看 `server/`（有人习惯放那儿）。*/
function loadDotEnv(root: string): { values: Record<string, string>; file: string | null } {
  for (const rel of ['.env', 'server/.env']) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    return { values: parseEnvFile(fs.readFileSync(file, 'utf8')), file };
  }
  return { values: {}, file: null };
}

function pick(env: Record<string, string | undefined>, key: string): string | undefined {
  const own = env[key];
  if (own && own.trim()) return own.trim();
  for (const alt of FALLBACK_KEYS[key] ?? []) {
    const v = env[alt];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function pickNumber(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = pick(env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 读配置。
 *
 * `root` 可注入，方便测试；正常跑就是 `process.cwd()`。
 */
export function loadConfig(root: string = process.cwd()): AppConfig {
  const { values: fileValues, file } = loadDotEnv(root);
  // `process.env` 优先：已存在的变量不被 `.env` 顶掉
  const env: Record<string, string | undefined> = { ...fileValues, ...process.env };

  const apiKey = pick(env, 'ICE_LLM_API_KEY');
  const baseUrl = pick(env, 'ICE_LLM_BASE_URL') ?? 'https://api.openai.com/v1';
  const model = pick(env, 'ICE_LLM_MODEL') ?? 'gpt-4o-mini';
  const forced = (pick(env, 'ICE_LLM_MODE') ?? 'auto').toLowerCase();

  const llm: LlmConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: apiKey ?? '',
    model,
    temperature: pickNumber(env, 'ICE_LLM_TEMPERATURE', 0.3),
    timeoutMs: pickNumber(env, 'ICE_LLM_TIMEOUT_MS', 60_000),
  };

  if (forced === 'scripted') {
    return { mode: 'scripted', reason: 'ICE_LLM_MODE=scripted（显式要求走剧本）', llm: null, envFile: file };
  }
  if (forced === 'llm' && !apiKey) {
    // 显式要 llm 却不给 key：**不要**静默退回剧本。
    // 你说了要走模型，那就必须走模型；退回剧本会让你以为配好了，实际一直在看假的。
    throw new Error(
      'ICE_LLM_MODE=llm 但没有配 ICE_LLM_API_KEY —— 要么补上 token，要么把模式改回 auto/scripted'
    );
  }
  if (!apiKey) {
    return {
      mode: 'scripted',
      reason: '没有配 ICE_LLM_API_KEY —— 走内置剧本演示（要接模型见 README「接自己的大模型」）',
      llm: null,
      envFile: file,
    };
  }
  return {
    mode: 'llm',
    reason: `${model} @ ${llm.baseUrl}`,
    llm,
    envFile: file,
  };
}

/**
 * 启动横幅里那几行。
 *
 * **token 只打前后各 4 位**：启动日志经常被贴到 issue 里，打全等于泄露。
 * 这也是"配置项要暴露出来"的一部分 —— 暴露的是**配什么**，不是**配了什么值**。
 */
export function describeConfig(config: AppConfig): string[] {
  const lines: string[] = [];
  if (config.envFile) {
    lines.push(`[config] 读到了 ${path.basename(path.dirname(config.envFile))}/${path.basename(config.envFile)}`);
  } else {
    lines.push('[config] 没有 .env —— 只读环境变量（cp .env.example .env 可以开始配）');
  }
  if (config.mode === 'llm' && config.llm) {
    const k = config.llm.apiKey;
    lines.push(`[config] 模型   ${config.llm.model}`);
    lines.push(`[config] 接口   ${config.llm.baseUrl}`);
    lines.push(`[config] token  ${k.length > 10 ? `${k.slice(0, 4)}…${k.slice(-4)}（${k.length} 位）` : '（已配置，过短未显示）'}`);
    lines.push(`[config] 温度   ${config.llm.temperature}`);
  } else {
    lines.push(`[config] 模型   未配置 —— ${config.reason}`);
  }
  return lines;
}
