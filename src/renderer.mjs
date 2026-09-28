import {
  RESET, BOLD, DIM, COLORS,
  fmtValue, fmtUsd, fmtNumber, fmtCompactNumber,
  visualWidth, visualPadEnd, visualPadStart, visualTruncateAnsi, oneLine,
  formatReset, formatCountdown,
} from './utils.mjs';
import { isStale } from './watch.mjs';

function terminalColumns() {
  return process.stdout.isTTY ? (process.stdout.columns || 100) : 100;
}

function progressBarWidth() {
  const columns = terminalColumns();
  if (columns >= 160) return 28;
  if (columns >= 120) return 22;
  return 14;
}

function sectionWidth() {
  return Math.min(140, Math.max(36, terminalColumns() - 2));
}

function printSectionHeading(title, detail = '') {
  const suffix = detail ? `  ${DIM}${detail}${RESET}` : '';
  console.log(`\n${BOLD}${title}${RESET}${suffix}`);
  console.log(`${DIM}${'─'.repeat(sectionWidth())}${RESET}`);
}

export function progressBar(percent, width = progressBarWidth()) {
  const clamped = Math.max(0, Math.min(100, percent));
  let filled = Math.round((clamped / 100) * width);
  if (percent > 0 && filled === 0) filled = 1;
  if (percent < 100 && filled === width) filled = width - 1;
  const empty = width - filled;
  let color = COLORS.green;
  if (clamped >= 85) color = COLORS.red;
  else if (clamped >= 60) color = COLORS.yellow;
  return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}${RESET}`;
}

function plainUsage(line) {
  if (line.used === undefined || line.limit === undefined) return '';
  return `${fmtValue(line.used, line.unit)} / ${fmtValue(line.limit, line.unit)}`;
}

function renderLine(line, { labelWidth, usageWidth, percentWidth = 0 }) {
  const plainLabel = `[${line.label}]`;
  const labelCol = `${DIM}${plainLabel}${RESET}${' '.repeat(Math.max(0, labelWidth - visualWidth(plainLabel)))}`;

  const plainUse = plainUsage(line);
  const usageCol = plainUse
    ? plainUse + ' '.repeat(Math.max(0, usageWidth - visualWidth(plainUse)))
    : ' '.repeat(usageWidth);

  const bar = progressBar(line.percent);
  // 右对齐：1.0% 比 40.0% 少一位，不补齐会让后面的 (剩余/重置) 整列漂移
  const percent = visualPadStart(formatPercent(line.percent), percentWidth);

  const extras = [];
  if (line.remaining !== undefined) {
    if (line.remaining >= 0) extras.push(`剩余 ${fmtValue(line.remaining, line.unit)}`);
    else extras.push(`超额 ${fmtValue(-line.remaining, line.unit)}`);
  }
  if (line.resetTime) extras.push(`重置 ${formatReset(line.resetTime)}`);
  if (line.resetAfter > 0) extras.push(`重置 ${formatCountdown(line.resetAfter)}`);
  const extra = extras.length ? `  ${DIM}(${extras.join(' · ')})${RESET}` : '';

  return `  ${labelCol}  ${usageCol}  ${bar}  ${percent}${extra}`;
}

// 标题行的 meta 只在同一实现的多个账号之间对齐：它们本来就是一组。
// 跨 provider 对齐没有意义 —— 名字短的 provider 要凑到最长的那个宽度得垫一大串空格。
export function computeMetaWidths(entries) {
  const widths = new Array(entries.length).fill(0);
  for (let start = 0; start < entries.length;) {
    let end = start + 1;
    while (end < entries.length && entries[end].type === entries[start].type) end++;
    // 单实例不补齐，避免短名字后面拖出一片空列
    if (end - start > 1) {
      const groupWidth = Math.max(...entries.slice(start, end).map(e => visualWidth(e.label)));
      widths.fill(groupWidth, start, end);
    }
    start = end;
  }
  return widths;
}

function renderTitle({ label, color, metaWidth = 0 }, suffix) {
  // 只在有后缀时补齐，否则会给标题拖一串看不见的尾随空格
  const pad = suffix ? ' '.repeat(Math.max(0, metaWidth - visualWidth(label))) : '';
  return `${color}${BOLD}● ${label}${RESET}${pad}${suffix}`;
}

export function printProvider(provider, result, widths, metaWidth = 0) {
  const meta = result.meta ? `  ${DIM}· ${result.meta}${RESET}` : '';
  console.log(`\n${renderTitle({ label: provider.name, color: provider.color, metaWidth }, meta)}`);

  for (const line of result.lines) {
    console.log(renderLine(line, widths));
  }
}

function formatPercent(percent) {
  return `${percent.toFixed(1)}%`;
}

export function computeColumnWidths(results) {
  let labelWidth = 0;
  let usageWidth = 0;
  let percentWidth = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const line of r.value.result.lines) {
      labelWidth = Math.max(labelWidth, visualWidth(`[${line.label}]`));
      usageWidth = Math.max(usageWidth, visualWidth(plainUsage(line)));
      percentWidth = Math.max(percentWidth, visualWidth(formatPercent(line.percent)));
    }
  }
  return { labelWidth, usageWidth, percentWidth };
}

export function renderJson(results) {
  const out = {};
  for (const r of results) {
    if (r.status === 'rejected') {
      out[r.reason.providerName || 'unknown'] = { error: r.reason.message };
      continue;
    }
    out[r.value.label || r.value.provider.name] = r.value.result;
  }
  return JSON.stringify(out, null, 2);
}

export function printOverviewHeader() {
  console.log(`\n${BOLD}🤖 LLM 使用总览${RESET}`);
}

export function printTokenHeader() {
  console.log(`\n${BOLD}🤖 Token 使用总览${RESET}`);
}

export function printError(err) {
  console.error(`\n${COLORS.red}● 查询失败${RESET}: ${err.message}`);
}

export function printQuotaHeading() {
  printSectionHeading('模型额度');
}

function tokenTotal(entry) {
  return (entry.input || 0) + (entry.output || 0) + (entry.cacheRead || 0) + (entry.cacheWrite || 0);
}

function titleCase(value) {
  if (!value) return '-';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function tokenUsageDetail(report) {
  const entries = (report.entries || []).filter(entry => tokenTotal(entry) > 0 || entry.cost > 0);
  const clientCount = new Set(entries.map(entry => entry.client)).size;
  return `今天 · 全部本地来源 · ${clientCount} 个客户端 / ${entries.length} 条记录 · 费用为估算`;
}

// 表格渲染抽成纯函数，一次性输出和 watch 看板共用同一套排版
export function buildTokenUsageLines(report, { columns = terminalColumns(), spaced = true } = {}) {
  const entries = (report.entries || []).filter(entry => tokenTotal(entry) > 0 || entry.cost > 0);

  if (entries.length === 0) {
    return [`  ${DIM}今天尚未发现 Token 使用记录${RESET}`];
  }

  const expanded = columns >= 120;
  const formatTokens = value => expanded ? fmtNumber(value || 0) : fmtCompactNumber(value);
  const rows = entries.map(entry => ({
    client: titleCase(entry.client),
    provider: titleCase(entry.provider),
    model: entry.model || '-',
    messages: fmtNumber(entry.messageCount || 0),
    input: formatTokens(entry.input),
    output: formatTokens(entry.output),
    cacheRead: formatTokens(entry.cacheRead),
    cacheWrite: formatTokens(entry.cacheWrite),
    cache: formatTokens((entry.cacheRead || 0) + (entry.cacheWrite || 0)),
    total: formatTokens(tokenTotal(entry)),
    cost: fmtUsd(entry.cost || 0),
  }));

  const compactColumns = [
    ['client', '客户端', 'left'],
    ['model', '模型', 'left'],
    ['input', '输入', 'right'],
    ['output', '输出', 'right'],
    ['cache', '缓存', 'right'],
    ['total', '总计', 'right'],
    ['cost', '费用', 'right'],
  ];
  const expandedColumns = [
    ['client', '客户端', 'left'],
    ['provider', 'Provider', 'left'],
    ['model', '模型', 'left'],
    ['messages', '消息', 'right'],
    ['input', '输入', 'right'],
    ['output', '输出', 'right'],
    ['cacheRead', '缓存读取', 'right'],
    ['cacheWrite', '缓存写入', 'right'],
    ['total', 'Token 总计', 'right'],
    ['cost', '估算费用', 'right'],
  ];
  const tableColumns = (expanded ? expandedColumns : compactColumns).map(([key, label, align]) => ({
    key,
    label,
    align,
  })).map(column => ({
    ...column,
    width: Math.max(visualWidth(column.label), ...rows.map(row => visualWidth(row[column.key]))),
  }));

  const renderRow = row => tableColumns.map(column => {
    const value = row[column.key];
    return column.align === 'right'
      ? visualPadStart(value, column.width)
      : visualPadEnd(value, column.width);
  }).join('  ');

  const lines = [
    `  ${DIM}${renderRow(Object.fromEntries(tableColumns.map(column => [column.key, column.label])))}${RESET}`,
  ];
  if (spaced) lines.push('');
  rows.forEach((row, index) => {
    lines.push(`  ${renderRow(row)}`);
    if (spaced && index < rows.length - 1) lines.push('');
  });

  const totalTokens = (report.totalInput || 0)
    + (report.totalOutput || 0)
    + (report.totalCacheRead || 0)
    + (report.totalCacheWrite || 0);
  lines.push(`  ${DIM}${'─'.repeat(Math.max(0, visualWidth(renderRow(rows[0]))))}${RESET}`);
  lines.push(`  ${BOLD}合计${RESET}  ${formatTokens(totalTokens)} Token · ${fmtNumber(report.totalMessages || 0)} 条消息 · ${COLORS.green}${fmtUsd(report.totalCost || 0)}${RESET}`);
  return lines;
}

export function printTokenUsage(report) {
  printSectionHeading('今日消耗', tokenUsageDetail(report));
  for (const line of buildTokenUsageLines(report)) console.log(line);
}

export function printTokenError(err) {
  printSectionHeading('Token 消耗');
  console.error(`  ${COLORS.red}${err.message}${RESET}`);
}

// ---------------------------------------------------------------------------
// watch 看板：纯函数，输入 state 输出行数组，便于快照测试
// ---------------------------------------------------------------------------

const SPIN_EMOJI = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const SPIN_DOTS = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
export const FRAME_INTERVAL_MS = 140;

function spinnerFrame(frames, now) {
  return frames[Math.floor(now / FRAME_INTERVAL_MS) % frames.length];
}

function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// 「多久之前」用 mm:ss 读起来别扭，改成 19s / 3m / 1h
function formatAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function formatTime(at) {
  if (!at) return '--:--:--';
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(v => String(v).padStart(2, '0'))
    .join(':');
}

function findPrevLine(prev, label) {
  return prev?.lines?.find(line => line.label === label);
}

// delta 是「原地重绘还能看出变化」的关键：对比上一轮成功值
function formatDelta(line, prevLine) {
  if (!prevLine) return '';
  const useRemaining = line.remaining !== undefined && prevLine.remaining !== undefined;
  const current = useRemaining ? line.remaining : line.percent;
  const previous = useRemaining ? prevLine.remaining : prevLine.percent;
  const diff = current - previous;
  if (!Number.isFinite(diff) || Math.abs(diff) < 0.005) return `${DIM}—${RESET}`;

  const magnitude = useRemaining
    ? fmtValue(Math.abs(diff), line.unit)
    : `${Math.abs(diff).toFixed(1)}%`;
  // 剩余额度下降 = 消耗，标红；上升（重置/续期）标绿
  const dropped = useRemaining ? diff < 0 : diff > 0;
  const color = dropped ? COLORS.yellow : COLORS.green;
  return `${color}${dropped ? '↓' : '↑'}${magnitude}${RESET}`;
}

function dashboardProviderLines(entry, widths, now, metaWidth = 0) {
  const lines = [];
  const stale = isStale(entry);
  const title = { label: entry.label, color: entry.color, metaWidth };

  if (!entry.result) {
    const detail = entry.error
      ? `${COLORS.red}${entry.error.message}${RESET}`
      : `${DIM}加载中…${RESET}`;
    lines.push(renderTitle(title, `  ${detail}`));
    return lines;
  }

  const meta = entry.result.meta ? `  ${DIM}· ${entry.result.meta}${RESET}` : '';
  const staleTag = stale
    ? `  ${COLORS.yellow}⚠ ${formatAge(now - entry.at)} 前的数据${RESET}`
    : '';
  lines.push(renderTitle(title, `${meta}${staleTag}`));

  for (const line of entry.result.lines) {
    const base = renderLine(line, widths);
    const delta = formatDelta(line, findPrevLine(entry.prev, line.label));
    lines.push(delta ? `${base}  ${delta}` : base);
  }
  return lines;
}

function dashboardTokenLines(state, now, { columns, compact, spaced }) {
  const { token } = state;
  const spin = token.pending ? ` ${spinnerFrame(SPIN_DOTS, now)}` : '';
  const updated = token.lastAt ? `更新于 ${formatTime(token.lastAt)}` : '尚未统计';
  const next = token.nextAt && !token.pending
    ? ` · 下次 ${formatClock(token.nextAt - now)}`
    : '';
  const staleTag = token.error && token.report ? `  ${COLORS.yellow}⚠ 上次统计失败${RESET}` : '';
  const detail = token.report ? ` · ${tokenUsageDetail(token.report)}` : '';
  const heading = `${BOLD}今日消耗${RESET}  ${DIM}${updated}${next}${detail}${RESET}${spin}${staleTag}`;

  if (token.error && !token.report) {
    return [heading, `  ${COLORS.red}${token.error.message}${RESET}`];
  }
  if (!token.report) {
    return [heading, `  ${DIM}统计中…${RESET}`];
  }

  // 终端放不下完整表格时退回一行汇总，避免帧高超过屏幕导致原地重绘错位
  if (compact) {
    const report = token.report;
    const total = (report.totalInput || 0) + (report.totalOutput || 0)
      + (report.totalCacheRead || 0) + (report.totalCacheWrite || 0);
    return [
      heading,
      `  ${fmtCompactNumber(total)} Token · ${fmtNumber(report.totalMessages || 0)} 条消息 · ${COLORS.green}${fmtUsd(report.totalCost || 0)}${RESET}`,
    ];
  }

  return [heading, ...buildTokenUsageLines(token.report, { columns, spaced })];
}

const EVENT_COLORS = {
  success: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
  info: DIM,
};

function buildDashboardLines(
  state,
  { columns, now, spacedProviders, spacedTable, compactToken },
) {
  const width = Math.min(140, Math.max(36, columns));
  const divider = `${DIM}${'─'.repeat(width)}${RESET}`;

  const status = state.quota.pending
    ? `${spinnerFrame(SPIN_EMOJI, now)} 刷新中 ${spinnerFrame(SPIN_DOTS, now)}`
    : `✅ 已同步 · 下次 ${formatClock((state.quota.nextAt ?? now) - now)}`;

  const lines = [`${BOLD}🤖 LLM 使用总览${RESET}  ${status}`, divider];

  const widths = computeColumnWidths(
    state.providers
      .filter(entry => entry.result)
      .map(entry => ({ status: 'fulfilled', value: { result: entry.result } })),
  );
  const metaWidths = computeMetaWidths(state.providers);
  state.providers.forEach((entry, index) => {
    if (spacedProviders && index > 0) lines.push('');
    lines.push(...dashboardProviderLines(entry, widths, now, metaWidths[index]));
  });

  lines.push(
    divider,
    ...dashboardTokenLines(state, now, { columns, compact: compactToken, spaced: spacedTable }),
  );

  if (state.events.length > 0) {
    lines.push(divider, `${BOLD}最近事件${RESET}`);
    for (const event of state.events) {
      const color = EVENT_COLORS[event.kind] || DIM;
      lines.push(`  ${DIM}${formatTime(event.at)}${RESET}  ${color}${event.text}${RESET}`);
    }
  }

  return lines;
}

// 从最宽松到最紧凑，优先保留留白和明细，放不下才逐级让步。
const DASHBOARD_VARIANTS = [
  { spacedProviders: true, spacedTable: true, compactToken: false },
  { spacedProviders: true, spacedTable: false, compactToken: false },
  { spacedProviders: false, spacedTable: false, compactToken: false },
  { spacedProviders: false, spacedTable: false, compactToken: true },
];

export function renderDashboard(state, { columns = 100, rows = 0, now = Date.now() } = {}) {
  const safeColumns = Math.max(1, columns - 1);
  // 原地覆写要求整帧不超过屏幕高度，否则终端滚动后光标回退会错位
  const maxLines = rows > 0 ? rows - 1 : Number.POSITIVE_INFINITY;

  let lines;
  for (const variant of DASHBOARD_VARIANTS) {
    lines = buildDashboardLines(state, { columns: safeColumns, now, ...variant });
    if (lines.length <= maxLines) break;
  }
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);

  // 帧行必须单行：错误信息可能带响应体的换行，压平后再截断，保证光标模型不错位
  return lines.map(line => visualTruncateAnsi(oneLine(line), safeColumns));
}
