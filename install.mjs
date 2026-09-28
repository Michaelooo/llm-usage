#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, appendFileSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { CONFIG_PATH } from './src/config.mjs';
import { configureProviders } from './src/setup.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOME = homedir();
const BIN_DIR = join(HOME, '.local/bin');
const BIN_TARGET = join(BIN_DIR, 'llm-usage');
const APP_DIR = join(HOME, '.local/share/llm-usage');

// bootstrap 重启时带 --resume：第二次进程跳过版本检查/复制/重启，直接续接安装
const RESUME = process.argv.includes('--resume');

function log(...args) {
  console.log(...args);
}

function checkNodeVersion() {
  const v = process.version;
  const major = Number(v.slice(1).split('.')[0]);
  if (major < 18) {
    throw new Error(`需要 Node.js >= 18，当前 ${v}`);
  }
  log(`✓ Node.js ${v}`);
}

function installApp() {
  // 防御：如果 install.mjs 已经在目标目录运行，不要自毁复制
  if (__dirname === APP_DIR || __dirname.startsWith(`${APP_DIR}/`)) {
    log(`✓ 应用目录已经是当前目录: ${APP_DIR}`);
    return;
  }

  // 把当前项目完整拷贝到 ~/.local/share/llm-usage
  if (existsSync(APP_DIR)) {
    rmSync(APP_DIR, { recursive: true, force: true });
  }
  mkdirSync(APP_DIR, { recursive: true });
  cpSync(__dirname, APP_DIR, { recursive: true, filter: (src) => !src.includes('node_modules') });
  log(`✓ 已安装应用目录: ${APP_DIR}`);
}

function bootstrapToAppDir() {
  // 如果当前不在 APP_DIR，复制过去后重新在 APP_DIR 运行 install.mjs
  // 这样 npm install 和 import 依赖都在 APP_DIR 上下文
  if (__dirname === APP_DIR || __dirname.startsWith(`${APP_DIR}/`)) {
    return;
  }
  log('→ 切换到应用目录继续安装...');
  execSync(`node "${APP_DIR}/install.mjs" --resume`, { stdio: 'inherit' });
  process.exit(0);
}

function installDeps() {
  const requiredDeps = [
    'node_modules/@inquirer/prompts',
    'node_modules/@tokscale/cli',
  ];
  const hasDeps = requiredDeps.every(path => existsSync(join(APP_DIR, path)));
  if (hasDeps) {
    log('✓ 依赖已安装');
    return;
  }
  log('→ 安装依赖...');
  execSync('npm install --omit=dev', {
    cwd: APP_DIR,
    stdio: 'inherit',
  });
}

function installBinary() {
  mkdirSync(BIN_DIR, { recursive: true });
  const wrapper = `#!/usr/bin/env sh
exec node "${APP_DIR}/bin/llm-usage.mjs" "$@"
`;
  writeFileSync(BIN_TARGET, wrapper, 'utf-8');
  chmodSync(BIN_TARGET, 0o755);
  log(`✓ 已安装可执行文件: ${BIN_TARGET}`);
}

function ensureShellAlias() {
  const shells = [
    { file: join(HOME, '.zshrc'), name: 'zsh' },
    { file: join(HOME, '.bashrc'), name: 'bash' },
  ];

  const aliasLine = `alias llm-usage='${BIN_TARGET}'`;

  for (const { file, name } of shells) {
    if (!existsSync(file)) continue;
    let content = readFileSync(file, 'utf-8');
    if (content.includes('llm-usage=')) {
      content = content.replace(/alias\s+llm-usage=.*/g, aliasLine);
      writeFileSync(file, content, 'utf-8');
      log(`✓ 已更新 ${name} 中的 llm-usage alias`);
      continue;
    }
    appendFileSync(file, `\n# llm-usage\n${aliasLine}\n`);
    log(`✓ 已添加 alias 到 ${file}`);
  }
}

async function main() {
  if (!RESUME) {
    checkNodeVersion();
    installApp();
    bootstrapToAppDir();
  }
  installDeps();
  installBinary();
  ensureShellAlias();
  // 仅首次安装（无 config）才交互配置；重装不覆盖已有 config
  if (!existsSync(CONFIG_PATH)) {
    await configureProviders();
  }

  log('\n安装完成。请重新加载 shell 配置或新建终端窗口：');
  log('  source ~/.zshrc');
  log('  # 或');
  log('  source ~/.bashrc');
  log('\n然后运行: llm-usage');
  log('如需添加/修改 provider: llm-usage web（网页面板）或 llm-usage --setup（终端交互）');
}

main().catch((err) => {
  console.error(`\n安装失败: ${err.message}`);
  process.exit(1);
});
