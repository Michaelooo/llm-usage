import { clearLine, cursorTo, moveCursor } from 'node:readline';
import { isCiEnvironment } from './config.mjs';

export const ACTIVE_FRAME_INTERVAL_MS = 140;
export const IDLE_FRAME_INTERVAL_MS = 1000;
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
// DECAWM：帧写入器的光标模型要求一行文本只占一行终端行。字宽误算（如终端把
// ● ─ █ ░ 这类歧义字符按双宽渲染）会让行实际超宽而自动折行，光标随之多下移一行。
// 关掉自动折行后超宽部分被终端裁掉，行数恒定，模型不会漂移。
export const DISABLE_WRAP = '\x1b[?7l';
export const ENABLE_WRAP = '\x1b[?7h';

export function createAdaptiveFrameLoop({
  draw,
  isActive,
  activeIntervalMs = ACTIVE_FRAME_INTERVAL_MS,
  idleIntervalMs = IDLE_FRAME_INTERVAL_MS,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
} = {}) {
  let timer;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    draw();
    const delay = isActive() ? activeIntervalMs : idleIntervalMs;
    timer = schedule(tick, delay);
    timer.unref?.();
  };

  tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) cancelSchedule(timer);
    },
  };
}

// 光标回退清除上一帧渲染的行块，供进度动画和 watch 看板共用
export function clearRenderedBlock(stream, lineCount) {
  if (lineCount === 0) return;
  cursorTo(stream, 0);
  for (let index = 0; index < lineCount; index++) {
    clearLine(stream, 0);
    if (index < lineCount - 1) moveCursor(stream, 0, -1);
  }
}

export function isInteractiveStream(stream, env = process.env) {
  return stream?.isTTY === true && !isCiEnvironment(env) && env.TERM !== 'dumb';
}

const ERASE_TO_EOL = '\x1b[K';

// 原地覆写：不做「先清空整块再重写」，那样两步之间存在空白窗口，
// 块越高越容易被终端刷到，表现就是肉眼可见的闪烁。
// 这里逐行覆盖并擦到行尾，屏幕上任一时刻都有完整内容。
export function createFrameWriter(stream) {
  let rendered = [];
  // 光标相对块顶的行号，始终停在块尾
  let cursorRow = 0;
  // 折行由本写入器接管：接管期间关掉，交还终端时（clear）恢复
  let wrapDisabled = false;

  // 整帧一次性写出，避免多次 syscall 之间被终端刷到
  const moveVertical = (out, delta) => {
    if (delta > 0) out.push(`\x1b[${delta}B`);
    else if (delta < 0) out.push(`\x1b[${-delta}A`);
  };

  const repaintAll = lines => {
    const out = [];
    moveVertical(out, -cursorRow);
    out.push('\r');

    lines.forEach((line, index) => {
      out.push(line, ERASE_TO_EOL);
      if (index < lines.length - 1) out.push('\n');
    });

    // 上一帧更长时，把多出来的行擦掉再把光标移回块尾
    const extra = rendered.length - lines.length;
    if (extra > 0) {
      for (let i = 0; i < extra; i++) out.push('\n', ERASE_TO_EOL);
      out.push(`\x1b[${extra}A`);
    }
    return out;
  };

  // 行数不变时只重绘真正变化的行。空闲期通常只有倒计时那一两行在动，
  // 整帧重排 30+ 行纯属浪费，也更容易被看见。
  const repaintChanged = (lines, changed) => {
    const out = [];
    for (const row of changed) {
      moveVertical(out, row - cursorRow);
      cursorRow = row;
      out.push('\r', lines[row], ERASE_TO_EOL);
    }
    moveVertical(out, lines.length - 1 - cursorRow);
    return out;
  };

  return {
    write(lines) {
      let out;
      if (rendered.length === lines.length && lines.length > 0) {
        const changed = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] !== rendered[i]) changed.push(i);
        }
        // 内容没变就完全不写
        if (changed.length === 0) return;
        out = repaintChanged(lines, changed);
      } else {
        out = repaintAll(lines);
      }

      cursorRow = Math.max(0, lines.length - 1);
      rendered = lines;
      if (out.length === 0) return;
      // 关折行必须先于内容，且和内容同一次写出，避免中间态被终端刷到
      if (!wrapDisabled) {
        out.unshift(DISABLE_WRAP);
        wrapDisabled = true;
      }
      stream.write(out.join(''));
    },
    clear() {
      clearRenderedBlock(stream, rendered.length);
      if (wrapDisabled) {
        stream.write(ENABLE_WRAP);
        wrapDisabled = false;
      }
      rendered = [];
      cursorRow = 0;
    },
  };
}
