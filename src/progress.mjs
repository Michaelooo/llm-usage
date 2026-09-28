import { clearRenderedBlock, isInteractiveStream } from './tty.mjs';
import { visualPadEnd, visualTruncate, visualWidth } from './utils.mjs';

const FRAME_INTERVAL_MS = 140;
const RACERS = {
  kimi: { label: 'Kimi', emoji: '🐰', stepMs: 180 },
  glm: { label: 'GLM', emoji: '🐼', stepMs: 300 },
  codex: { label: 'Codex', emoji: '🦊', stepMs: 220 },
  claude: { label: 'Claude', emoji: '🐱', stepMs: 240 },
  tokens: { label: 'Tokens', emoji: '🤖', stepMs: 280 },
};

function formatElapsed(startedAt, now) {
  return `${((now - startedAt) / 1000).toFixed(1)}s`;
}

function statusText(status) {
  if (status === 'fulfilled') return '✓ 完成';
  if (status === 'rejected') return '✗ 失败';
  return '奔跑中';
}

function countStatuses(tasks) {
  const values = [...tasks.values()];
  return {
    done: values.filter(({ status }) => status !== 'pending').length,
    failed: values.filter(({ status }) => status === 'rejected').length,
    total: values.length,
  };
}

function renderTrack(task, trackWidth, elapsedMs) {
  if (task.status !== 'pending') {
    return `${'━'.repeat(trackWidth)} 🏁 ${task.emoji}`;
  }

  const position = Math.min(trackWidth - 1, Math.floor(elapsedMs / task.stepMs));
  return `${'━'.repeat(position)}${task.emoji}${'━'.repeat(trackWidth - position - 1)} 🏁`;
}

export function renderRaceFrame(tasks, { columns = 80, startedAt = 0, now = Date.now() } = {}) {
  const safeColumns = Math.max(1, columns - 1);
  const { done, failed, total } = countStatuses(tasks);
  const elapsed = formatElapsed(startedAt, now);

  if (safeColumns < 24) {
    return [visualTruncate(`${done}/${total} 已结束 · ${elapsed}`, safeColumns)];
  }

  const values = [...tasks.values()];
  const labelWidth = Math.max(...values.map(({ label }) => visualWidth(label)));
  const fixedWidth = labelWidth + visualWidth('  🐯  🏁  ✗ 失败');
  const trackWidth = Math.min(32, Math.max(0, safeColumns - fixedWidth));

  if (trackWidth < 6) {
    return values.map(task => visualTruncate(
      `${task.emoji} ${visualPadEnd(task.label, labelWidth)}  ${statusText(task.status)}`,
      safeColumns,
    ));
  }

  const elapsedMs = Math.max(0, now - startedAt);
  const lines = values.map(task => {
    const line = `${visualPadEnd(task.label, labelWidth)}  ${renderTrack(task, trackWidth, elapsedMs)}  ${statusText(task.status)}`;
    return visualTruncate(line, safeColumns);
  });
  const summary = failed > 0
    ? `${done}/${total} 已结束 · ${failed} 项失败 · ${elapsed}`
    : `${done}/${total} 已结束 · ${elapsed}`;
  lines.push(visualTruncate(summary, safeColumns));
  return lines;
}

export function createLoadingIndicator({
  tasks: taskIds = [],
  disabled = false,
  stream = process.stderr,
  env = process.env,
  now = Date.now,
  schedule = setInterval,
  cancelSchedule = clearInterval,
} = {}) {
  const active = !disabled && isInteractiveStream(stream, env);
  if (!active) return { complete() {}, fail() {}, stop() {} };

  const tasks = new Map(
    taskIds
      .filter(id => RACERS[id])
      .map(id => [id, { ...RACERS[id], status: 'pending' }]),
  );
  if (tasks.size === 0) return { complete() {}, fail() {}, stop() {} };

  const startedAt = now();
  let renderedLineCount = 0;
  let stopped = false;

  const render = () => {
    if (stopped) return;
    const lines = renderRaceFrame(tasks, {
      columns: stream.columns || 80,
      startedAt,
      now: now(),
    });
    clearRenderedBlock(stream, renderedLineCount);
    stream.write(lines.join('\n'));
    renderedLineCount = lines.length;
  };

  const settle = (id, status) => {
    const task = tasks.get(id);
    if (task?.status !== 'pending' || stopped) return;
    task.status = status;
    render();
  };

  render();
  const timer = schedule(render, FRAME_INTERVAL_MS);
  timer.unref?.();

  return {
    complete(id) {
      settle(id, 'fulfilled');
    },
    fail(id) {
      settle(id, 'rejected');
    },
    stop() {
      if (stopped) return;
      cancelSchedule(timer);
      const { failed } = countStatuses(tasks);
      const elapsed = formatElapsed(startedAt, now());
      stopped = true;
      clearRenderedBlock(stream, renderedLineCount);
      const summary = failed > 0
        ? `✗ 数据加载结束，${failed} 项失败 · ${elapsed}`
        : `✓ 数据加载完成 · ${elapsed}`;
      stream.write(`${summary}\n`);
      renderedLineCount = 0;
    },
  };
}
