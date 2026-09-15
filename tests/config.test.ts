/**
 * 配置：`.env` 解析、优先级、两种模式的判定。
 *
 * 这一组的重点是**"不配也能跑、配错要响亮"**这两条边界：
 * 没配 key 走剧本（clone 下来就能看），显式要 llm 却没 key 就**启动失败**
 * —— 静默退回剧本会让人以为配好了，实际一直在看假的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseEnvFile, describeConfig } from '../server/config';

const ENV_KEYS = [
  'ICE_LLM_API_KEY',
  'ICE_LLM_BASE_URL',
  'ICE_LLM_MODEL',
  'ICE_LLM_TEMPERATURE',
  'ICE_LLM_TIMEOUT_MS',
  'ICE_LLM_MODE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
];

function withCleanEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** 造一个临时目录当"仓库根"，可选写一份 `.env`。 */
function tmpRoot(envFile?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ice-cfg-'));
  if (envFile !== undefined) fs.writeFileSync(path.join(dir, '.env'), envFile, 'utf8');
  return dir;
}

describe('parseEnvFile', () => {
  it('认 KEY=VALUE、注释、空行、成对引号与 export 前缀', () => {
    expect(
      parseEnvFile(
        [
          '# 注释',
          '',
          'A=1',
          'B = hello world ',
          'C="带 空格"',
          "D='单引号'",
          'export E=2',
          '=没有键',
          'F=',
        ].join('\n')
      )
    ).toEqual({ A: '1', B: 'hello world', C: '带 空格', D: '单引号', E: '2', F: '' });
  });
});

describe('两种模式', () => {
  it('没配 key → 剧本模式，且理由说清了怎么配', () => {
    withCleanEnv(() => {
      const c = loadConfig(tmpRoot());
      expect(c.mode).toBe('scripted');
      expect(c.llm).toBeNull();
      expect(c.reason).toContain('ICE_LLM_API_KEY');
    });
  });

  it('配了 key → 模型模式，默认值补齐', () => {
    withCleanEnv(() => {
      const c = loadConfig(tmpRoot('ICE_LLM_API_KEY=sk-test-1234567890\n'));
      expect(c.mode).toBe('llm');
      expect(c.llm).toMatchObject({
        apiKey: 'sk-test-1234567890',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        temperature: 0.3,
        timeoutMs: 60_000,
      });
    });
  });

  it('baseUrl 结尾的斜杠会被去掉（要拼 /chat/completions）', () => {
    withCleanEnv(() => {
      const c = loadConfig(tmpRoot('ICE_LLM_API_KEY=k\nICE_LLM_BASE_URL=http://localhost:11434/v1///\n'));
      expect(c.llm!.baseUrl).toBe('http://localhost:11434/v1');
    });
  });

  it('`ICE_LLM_MODE=scripted` 显式要剧本 —— 就算配了 key 也走剧本', () => {
    withCleanEnv(() => {
      const c = loadConfig(tmpRoot('ICE_LLM_API_KEY=k\nICE_LLM_MODE=scripted\n'));
      expect(c.mode).toBe('scripted');
      expect(c.reason).toContain('scripted');
    });
  });

  it('`ICE_LLM_MODE=llm` 却没 key → **抛**，不静默退回剧本', () => {
    // 静默退回会让人以为配好了、实际一直在看剧本。宁可启动就红。
    withCleanEnv(() => {
      expect(() => loadConfig(tmpRoot('ICE_LLM_MODE=llm\n'))).toThrow(/ICE_LLM_API_KEY/);
    });
  });

  it('也认业界通用的 OPENAI_* 名字（本机已经有的话不用再抄一遍）', () => {
    withCleanEnv(() => {
      const c = loadConfig(tmpRoot('OPENAI_API_KEY=sk-from-openai\nOPENAI_MODEL=gpt-4o\n'));
      expect(c.mode).toBe('llm');
      expect(c.llm!.apiKey).toBe('sk-from-openai');
      expect(c.llm!.model).toBe('gpt-4o');
    });
  });

  it('环境变量优先于 .env（容器里注入的不该被仓库里的文件顶掉）', () => {
    withCleanEnv(() => {
      process.env.ICE_LLM_MODEL = 'from-env';
      const c = loadConfig(tmpRoot('ICE_LLM_API_KEY=k\nICE_LLM_MODEL=from-file\n'));
      expect(c.llm!.model).toBe('from-env');
    });
  });

  it('数字项写错时退回默认值，不抛', () => {
    withCleanEnv(() => {
      const c = loadConfig(tmpRoot('ICE_LLM_API_KEY=k\nICE_LLM_TEMPERATURE=热\nICE_LLM_TIMEOUT_MS=abc\n'));
      expect(c.llm!.temperature).toBe(0.3);
      expect(c.llm!.timeoutMs).toBe(60_000);
    });
  });
});

describe('启动横幅', () => {
  it('token 只打前后各 4 位 —— 日志经常被贴到 issue 里', () => {
    withCleanEnv(() => {
      const c = loadConfig(tmpRoot('ICE_LLM_API_KEY=sk-abcdefghijklmnop\n'));
      const lines = describeConfig(c).join('\n');
      expect(lines).toContain('sk-a');
      expect(lines).toContain('mnop');
      expect(lines).not.toContain('abcdefghijklmnop');
    });
  });

  it('没配时说明走的是剧本，并给出配的入口', () => {
    withCleanEnv(() => {
      const lines = describeConfig(loadConfig(tmpRoot())).join('\n');
      expect(lines).toContain('未配置');
      expect(lines).toContain('.env.example');
    });
  });

  it('读到了 .env 会说出来（排查"我改了怎么没生效"）', () => {
    withCleanEnv(() => {
      const lines = describeConfig(loadConfig(tmpRoot('ICE_LLM_API_KEY=k\n'))).join('\n');
      expect(lines).toContain('.env');
    });
  });
});
