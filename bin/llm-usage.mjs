#!/usr/bin/env node
import { unwatchFile, watchFile } from 'node:fs';
import {
  loadConfig,
  ensureConfig,
  CONFIG_PATH,
  getProviderSecrets,
  resolveWatchIntervals,
} from '../src/config.mjs';
import { getEnabledProviders, listProviderNames } from '../src/providers/index.mjs';
import {
  printOverviewHeader, printTokenHeader, printProvider, computeColumnWidths, computeMetaWidths,
  renderJson,
  printError, printQuotaHeading, printTokenUsage, printTokenError,
} from '../src/renderer.mjs';
import { fetchTodayTokenUsage, runTokscale } from '../src/tokscale.mjs';
import { createLoadingIndicator } from '../src/progress.mjs';
import { redactSecrets, oneLine, COLORS, DIM, RESET } from '../src/utils.mjs';
import { canRunInteractiveSetup } from '../src/runtime.mjs';

function parsePositiveInt(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    console.error(`\n${flag} 必须是大于 0 的数字`);
    process.exit(1);
  }
  return number;
}

function parseArgs(argv) {
  const args = {
    json: false,
    config: false,
    providers: [],
    help: false,
    setup: false,
    tokenCommand: false,
    tokscaleArgs: [],
    watch: false,
    quotaIntervalSec: undefined,
    tokenIntervalSec: undefined,
    webCommand: false,
    webPort: 0,
    webOpen: true,
  };

  if (argv[0] === 'token') {
    args.tokenCommand = true;
    args.tokscaleArgs = argv.slice(1);
    return args;
  }

  if (argv[0] === 'web') {
    args.webCommand = true;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--port') args.webPort = parsePositiveInt(argv[++i], '--port');
      else if (argv[i] === '--no-open') args.webOpen = false;
    }
    return args;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--config' || arg === '-c') args.config = true;
    else if (arg === '--provider' || arg === '-p') {
      const next = argv[++i];
      if (next) args.providers = next.split(',').map(s => s.trim()).filter(Boolean);
    }
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--setup') args.setup = true;
    else if (arg === '--watch' || arg === '-w') args.watch = true;
    else if (arg === '--interval') {
      args.quotaIntervalSec = parsePositiveInt(argv[++i], '--interval');
    }
    else if (arg === '--token-interval') {
      args.tokenIntervalSec = parsePositiveInt(argv[++i], '--token-interval');
    }
    else if (arg === '--list-providers') {
      console.log(listProviderNames().join('\n'));
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
用法: llm-usage [选项]

选项:
  -p, --provider <names>   只查询指定 provider，多个用逗号分隔
  -j, --json              输出 JSON 格式
  -c, --config            显示配置文件路径
  -w, --watch             定时刷新模式，原地重绘并显示变化量（Ctrl-C 退出）
      --interval <秒>     watch 下额度刷新间隔（默认 60，最小 10）
      --token-interval <秒> watch 下 Token 统计间隔（默认 900，最小 60）
      --setup             交互式配置 provider（启用/填 Key，保留已填值）
      --list-providers    列出所有支持的 provider
  -h, --help              显示帮助

子命令:
  token                   查看本机 Token 消耗；其余参数交给 Tokscale
  web [--port N]          打开本地网页配置面板（--no-open 只打印地址，不拉起浏览器）

直接运行 llm-usage 时，会同时显示模型额度和今天的 Token 消耗。

配置热重载：config.yaml 改动后，正在运行的 watch 会自动重载，无需重启。
网页面板保存、llm-usage --setup、手工编辑文件都算改动。

配置文件: ${CONFIG_PATH}
`);
}

async function printTokenSummary() {
  printTokenHeader();
  const loading = createLoadingIndicator({ tasks: ['tokens'] });
  let report;
  let error;
  try {
    report = await fetchTodayTokenUsage();
    loading.complete('tokens');
  } catch (reason) {
    error = reason;
    loading.fail('tokens');
  } finally {
    loading.stop();
  }

  if (error) {
    printTokenError(error);
    process.exitCode = 1;
    return;
  }
  printTokenUsage(report);
}

async function runFirstTimeSetup(message) {
  console.log(`\n${message}`);
  const { configureProviders } = await import('../src/setup.mjs');
  await configureProviders();
  return loadConfig();
}

async function printOverview(args) {
  const interactive = canRunInteractiveSetup(args);
  let config = loadConfig();
  if (!config && interactive) {
    config = await runFirstTimeSetup('首次使用 llm-usage，请先选择并配置需要的 Provider。');
  }

  if (!config) {
    ensureConfig();
    console.error(`\n配置文件不存在，已生成默认配置: ${CONFIG_PATH}`);
    console.error('当前环境不支持交互配置，请编辑该文件，或在终端中运行 llm-usage --setup。');
    process.exitCode = 1;
    return;
  }

  let enabled = getEnabledProviders(config, args.providers);
  if (enabled.length === 0 && interactive && args.providers.length === 0) {
    config = await runFirstTimeSetup('当前没有启用的 Provider，请先完成配置。');
    enabled = getEnabledProviders(config, args.providers);
  }

  if (enabled.length === 0) {
    console.error('\n没有启用的 provider。');
    console.error(`请设置 LLM_USAGE_* 环境变量、编辑 ${CONFIG_PATH}，或运行 llm-usage --setup。`);
    process.exitCode = 1;
    return;
  }

  if (!args.json) printOverviewHeader();
  const configSecrets = getProviderSecrets(config);
  const loading = createLoadingIndicator({
    tasks: [...enabled.map(({ name }) => name), 'tokens'],
    disabled: args.json,
  });
  const quotaPromise = Promise.allSettled(
    enabled.map(({ name, provider, label, config: providerConfig }) =>
      provider.fetch(providerConfig).then(result => {
        loading.complete(name);
        return { provider, label, result };
      })
        .catch(err => {
          loading.fail(name);
          const safeError = new Error(redactSecrets(err?.message || err, configSecrets));
          safeError.providerName = label;
          throw safeError;
        })
    )
  );
  const tokenPromise = fetchTodayTokenUsage()
    .then(value => {
      loading.complete('tokens');
      return { status: 'fulfilled', value };
    })
    .catch(reason => {
      loading.fail('tokens');
      return {
        status: 'rejected',
        reason: new Error(redactSecrets(reason?.message || reason, configSecrets)),
      };
    });

  let results;
  let tokenResult;
  try {
    [results, tokenResult] = await Promise.all([quotaPromise, tokenPromise]);
  } finally {
    loading.stop();
  }

  if (args.json) {
    const output = JSON.parse(renderJson(results));
    if (tokenResult.status === 'fulfilled') output.tokenUsage = tokenResult.value;
    else output.tokenUsage = { error: tokenResult.reason.message };
    console.log(JSON.stringify(output, null, 2));
    if (results.some(r => r.status === 'rejected') || tokenResult.status === 'rejected') {
      process.exitCode = 1;
    }
    return;
  }

  printQuotaHeading();

  let hasError = false;
  const widths = computeColumnWidths(results);
  // results 与 enabled 同序，metaWidths 按下标取
  const metaWidths = computeMetaWidths(enabled);
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      hasError = true;
      printError(result.reason);
      return;
    }
    const { provider, label, result: quota } = result.value;
    printProvider({ name: label, color: provider.color }, quota, widths, metaWidths[index]);
  });

  if (tokenResult.status === 'fulfilled') printTokenUsage(tokenResult.value);
  else {
    hasError = true;
    printTokenError(tokenResult.reason);
  }

  if (hasError) process.exitCode = 1;
}

function loadEnabledOrExit(args) {
  const config = loadConfig();
  if (!config) {
    console.error(`\n配置文件不存在，请先运行 llm-usage --setup 或设置 LLM_USAGE_* 环境变量。`);
    process.exitCode = 1;
    return null;
  }
  const enabled = getEnabledProviders(config, args.providers);
  if (enabled.length === 0) {
    console.error('\n没有启用的 provider。');
    console.error(`请设置 LLM_USAGE_* 环境变量、编辑 ${CONFIG_PATH}，或运行 llm-usage --setup。`);
    process.exitCode = 1;
    return null;
  }
  return { config, enabled };
}

async function runWebCommand(args) {
  ensureConfig();
  const { startWebServer, openBrowser } = await import('../src/web/server.mjs');

  let session;
  try {
    session = await startWebServer({ port: args.webPort });
  } catch (error) {
    console.error(`\n配置面板启动失败: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${COLORS.green}✓${RESET} 配置面板: ${session.url}`);
  console.log(`${DIM}链接里的令牌是本次运行专用的，仅本机可访问；按 Ctrl-C 停止${RESET}`);
  if (args.webOpen) openBrowser(session.url);

  const stop = () => { session.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await new Promise(() => {});
}

async function runWatch(args) {
  const { createWatcher, pushEvent } = await import('../src/watch.mjs');
  const { renderDashboard } = await import('../src/renderer.mjs');
  const {
    createAdaptiveFrameLoop, createFrameWriter, isInteractiveStream, HIDE_CURSOR, SHOW_CURSOR,
  } = await import('../src/tty.mjs');

  const stream = process.stdout;
  if (!isInteractiveStream(stream)) {
    console.error('\n--watch 需要交互式终端（当前是管道 / CI / TERM=dumb）。');
    process.exitCode = 1;
    return;
  }
  if (args.json) {
    console.error('\n--watch 与 --json 不能同时使用。');
    process.exitCode = 1;
    return;
  }

  const loaded = loadEnabledOrExit(args);
  if (!loaded) return;

  let intervals = resolveWatchIntervals(loaded.config, args);
  const watcher = createWatcher({
    entries: loaded.enabled,
    secrets: getProviderSecrets(loaded.config),
    quotaIntervalSec: intervals.quotaIntervalSec,
    tokenIntervalSec: intervals.tokenIntervalSec,
    fetchTokenUsage: fetchTodayTokenUsage,
  });

  const writer = createFrameWriter(stream);
  const draw = () => writer.write(
    renderDashboard(watcher.state, {
      columns: stream.columns || 100,
      rows: stream.rows || 0,
    }),
  );

  stream.write(HIDE_CURSOR);
  const frameLoop = createAdaptiveFrameLoop({
    draw,
    isActive: () => watcher.state.quota.pending || watcher.state.token.pending,
  });
  let quotaTimer = setInterval(() => { watcher.refreshQuota(); }, intervals.quotaIntervalSec * 1000);
  let tokenTimer = setInterval(() => { watcher.refreshToken(); }, intervals.tokenIntervalSec * 1000);

  // 配置文件改动后就地重载，不必重启 watch。网页面板保存、--setup、手工编辑都走这条路径。
  const reloadConfig = () => {
    let next;
    try {
      const config = loadConfig();
      if (!config) throw new Error('配置文件不存在');
      const enabled = getEnabledProviders(config, args.providers);
      if (enabled.length === 0) throw new Error('没有启用的 provider');
      next = { config, enabled };
    } catch (error) {
      // 配置写坏时保留旧配置继续跑，比把看板打空更有用
      pushEvent(watcher.state, `配置重载失败，沿用旧配置：${oneLine(error.message)}`, Date.now(), 'error');
      draw();
      return;
    }

    watcher.updateEntries(next.enabled, getProviderSecrets(next.config));

    const nextIntervals = resolveWatchIntervals(next.config, args);
    if (nextIntervals.quotaIntervalSec !== intervals.quotaIntervalSec) {
      clearInterval(quotaTimer);
      quotaTimer = setInterval(() => { watcher.refreshQuota(); }, nextIntervals.quotaIntervalSec * 1000);
    }
    if (nextIntervals.tokenIntervalSec !== intervals.tokenIntervalSec) {
      clearInterval(tokenTimer);
      tokenTimer = setInterval(() => { watcher.refreshToken(); }, nextIntervals.tokenIntervalSec * 1000);
    }
    intervals = nextIntervals;

    pushEvent(watcher.state, '配置已重载', Date.now(), 'success');
    draw();
    watcher.refreshQuota();
  };

  // 用 watchFile（轮询 stat）而不是 watch：编辑器「写临时文件再改名」的保存方式
  // 会让 fs.watch 的句柄失效，watchFile 不受影响
  watchFile(CONFIG_PATH, { interval: 2000 }, (curr, prev) => {
    // mtimeMs 为 0 表示文件此刻不存在，是保存过程中的中间态，等下一次回调
    if (curr.mtimeMs === 0) return;
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    reloadConfig();
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    frameLoop.stop();
    clearInterval(quotaTimer);
    clearInterval(tokenTimer);
    unwatchFile(CONFIG_PATH);
    writer.clear();
    stream.write(SHOW_CURSOR);
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  draw();
  watcher.refreshQuota();
  watcher.refreshToken();

  // 定时器保持进程存活，直到 SIGINT
  await new Promise(() => {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.webCommand) {
    await runWebCommand(args);
    return;
  }

  if (args.tokenCommand) {
    if (args.tokscaleArgs.length > 0) process.exitCode = await runTokscale(args.tokscaleArgs);
    else await printTokenSummary();
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  if (args.config) {
    ensureConfig();
    console.log(CONFIG_PATH);
    return;
  }

  if (args.setup) {
    const { configureProviders } = await import('../src/setup.mjs');
    await configureProviders();
    return;
  }

  if (args.watch) {
    await runWatch(args);
    return;
  }

  await printOverview(args);
}

main().catch(err => {
  console.error(`\n意外错误: ${redactSecrets(err.message)}`);
  process.exit(1);
});
