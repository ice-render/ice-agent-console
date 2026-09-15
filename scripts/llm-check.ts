/**
 * `npm run llm:check` —— **配完之后先跑这个**。
 *
 * 配大模型最容易卡住的地方不是代码，是那三行配置：token 打错一位、baseUrl 少了 `/v1`、
 * 模型名不存在、接口不支持 tool calling……这些错误在界面上看起来都只是"没反应"。
 * 与其让人去翻日志，不如给一条命令，它把每一步的结果直接说出来。
 *
 * 它做的事：
 *   1. 报当前配置（token 只打前后各 4 位）；
 *   2. 打一次最小请求，确认**能连上、token 有效、模型名存在**；
 *   3. 再打一次**带工具的**请求，确认这个模型**支持 tool calling** ——
 *      这一条是这个工程能不能用的关键，很多便宜的模型不支持，而报错信息通常很含糊；
 *   4. 把模型的原文打出来，让人一眼看出它在不在状态。
 */
import { loadConfig } from '../server/config';
import { chat, LlmHttpError, type ChatMessage } from '../server/agents/llm-client';
import { TOOL_DEFINITIONS } from '../server/agents/tools';

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** 把接口的错误翻译成人能直接动手改的一句话。 */
function hint(err: unknown): string {
  if (err instanceof LlmHttpError) {
    const body = err.body.toLowerCase();
    if (err.status === 401 || err.status === 403) return 'token 不对或没有权限 —— 检查 ICE_LLM_API_KEY';
    if (err.status === 404) return '地址不对 —— 检查 ICE_LLM_BASE_URL 有没有漏掉 /v1，以及模型名是否存在';
    if (err.status === 400 && body.includes('tool')) return '这个模型/接口不支持 tool calling —— 本工程靠它决定画什么，换一个支持的吧';
    if (err.status === 429) return '限流或额度用完了';
    if (err.status >= 500) return '对方服务端出错，稍后再试';
    return '检查配置；响应体见上面那行';
  }
  const msg = (err as Error)?.message ?? String(err);
  if (/timeout|aborted/i.test(msg)) return '超时 —— 本地小模型首字慢，把 ICE_LLM_TIMEOUT_MS 调大试试';
  if (/ECONNREFUSED|fetch failed/i.test(msg)) return '连不上 —— 本地服务起了吗？地址与端口对吗？';
  return '具体原因见上面那行';
}

async function main() {
  const config = loadConfig();
  console.log('\n\x1b[1mice-agent-console · 大模型配置自检\x1b[0m\n');

  if (config.mode !== 'llm' || !config.llm) {
    console.log(bad('当前是剧本模式 —— 没有可检查的模型配置'));
    console.log(dim(`     原因：${config.reason}`));
    console.log(dim('     要接模型：cp .env.example .env，填上 ICE_LLM_API_KEY'));
    process.exit(1);
  }

  const llm = config.llm;
  console.log(`  ${dim('接口')}   ${llm.baseUrl}`);
  console.log(`  ${dim('模型')}   ${llm.model}`);
  console.log(`  ${dim('token')}  ${llm.apiKey.slice(0, 4)}…${llm.apiKey.slice(-4)}（${llm.apiKey.length} 位）`);
  console.log(`  ${dim('超时')}   ${llm.timeoutMs}ms\n`);

  // ---- 1. 最小请求：连通性 / token / 模型名 ----
  const base: ChatMessage[] = [{ role: 'user', content: '只回两个字：收到' }];
  let first: Awaited<ReturnType<typeof chat>>;
  try {
    first = await chat(llm, base, undefined);
    console.log(ok(`接口通了，模型回了：${JSON.stringify(first.text.trim().slice(0, 60))}`));
  } catch (err) {
    console.log(bad('请求失败'));
    console.log(`     ${(err as Error).message.slice(0, 400)}`);
    console.log(`     \x1b[33m→ ${hint(err)}\x1b[0m\n`);
    process.exit(1);
  }

  // ---- 2. 带工具：这个模型会不会用工具 ----
  try {
    const withTools = await chat(
      llm,
      [
        {
          role: 'user',
          content: '把「A 比 B 多」这句话画成柱状图，用 render_chart 工具，数据自己编一组小的。',
        },
      ],
      TOOL_DEFINITIONS
    );
    if (withTools.toolCall) {
      const args = withTools.toolCall.args;
      console.log(ok(`模型会调工具：${withTools.toolCall.name}，参数解析${args === null ? '失败（JSON 不合法）' : '成功'}`));
      console.log(dim(`     参数：${JSON.stringify(args)?.slice(0, 200)}`));
      if (args?.kind) console.log(ok(`认得出图表类型：kind = ${args.kind}`));
    } else {
      console.log(
        `\x1b[33m!\\x1b[0m 模型**没有调工具**，只回了文字：${JSON.stringify(withTools.text.trim().slice(0, 120))}`
      );
      console.log(dim('     可能它不支持 tool calling，或者提示词理解偏了。'));
      console.log(dim('     本工程靠工具调用来决定画什么 —— 不调工具就只会出现文字气泡。'));
    }
  } catch (err) {
    console.log(bad('带工具的请求失败'));
    console.log(`     ${(err as Error).message.slice(0, 400)}`);
    console.log(`     \x1b[33m→ ${hint(err)}\x1b[0m\n`);
    process.exit(1);
  }

  console.log(`\n${ok('配置可用。跑 npm run dev，然后把刚才那句问一遍试试。')}\n`);
}

main().catch((err) => {
  console.log(bad('自检本身出错了'));
  console.log(err);
  process.exit(1);
});
