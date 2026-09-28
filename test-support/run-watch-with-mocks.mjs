import './mock-runtime.mjs';

// watch 要求交互式终端，测试里 stdout 是管道，这里伪装成固定尺寸的 TTY
process.stdout.isTTY = true;
process.stdout.columns = 120;
process.stdout.rows = 40;

await import('../bin/llm-usage.mjs');
