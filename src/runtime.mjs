import { isCiEnvironment } from './config.mjs';

export function canRunInteractiveSetup(
  args,
  {
    env = process.env,
    stdinIsTTY = process.stdin.isTTY,
    stdoutIsTTY = process.stdout.isTTY,
  } = {},
) {
  return !args.json && !isCiEnvironment(env) && stdinIsTTY === true && stdoutIsTTY === true;
}
