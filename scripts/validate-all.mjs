/** Reproducible release gate. Stream logs to disk and bound every child process. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const reports = path.join(root, 'reports');
await fs.mkdir(reports, {recursive: true});
const tests = (await fs.readdir(path.join(root, 'tests')))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => 'tests/' + name);
const testArgs = ['--test', '--test-concurrency=1', '--test-timeout=30000', '--test-reporter=tap'];
const commands = [
  ['check', [process.execPath, 'scripts/check.mjs']],
  ['tests', [process.execPath, ...testArgs, ...tests]],
  ['adapter', [process.env.PYTHON ?? 'python3', 'scripts/test-adapter.py']],
  ['coverage', [process.execPath, ...testArgs, '--experimental-test-coverage', ...tests]],
  ['benchmark', [process.execPath, 'benchmarks/run.mjs']],
];
const runs = [];
for (const [name, [exe, ...args]] of commands) {
  const start = Date.now();
  const log = await fs.open(path.join(reports, name + '.log'), 'w');
  // File descriptors avoid pipe buffering and preserve partial diagnostics on timeout.
  const child = spawn(exe, args, {cwd: root, env: process.env, stdio: ['ignore', log.fd, log.fd]});
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 180000);
  const outcome = await new Promise(resolve => {
    child.once('error', error => resolve({code: null, signal: null, error: error.message}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  clearTimeout(timer);
  await log.close();
  const run = {name, exit_code: outcome.code, signal: outcome.signal, timed_out: timedOut,
    elapsed_ms: Date.now() - start, log: `reports/${name}.log`};
  if (outcome.error) run.error = outcome.error;
  runs.push(run);
  console.log(`${name}: ${outcome.code === 0 ? 'PASS' : 'FAIL'} (${run.elapsed_ms}ms)`);
  if (outcome.code !== 0) {
    console.error((await fs.readFile(path.join(reports, name + '.log'), 'utf8')).slice(-16000));
    break;
  }
}
const testLog = await fs.readFile(path.join(reports, 'tests.log'), 'utf8').catch(() => '');
const count = name => Number(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm').exec(testLog)?.[1] ?? 0);
const adapter=JSON.parse(await fs.readFile(path.join(reports,'adapter-validation.json'),'utf8').catch(()=>'null'));
const summary = {
  generated_at: new Date().toISOString(),
  environment: {node: process.version, platform: process.platform, arch: process.arch},
  runs,
  tests: {total: count('tests'), passed: count('pass'), failed: count('fail'),
    cancelled: count('cancelled'), skipped: count('skipped')},
  adapter_tests: adapter,
  total_offline_tests: count('tests')+(adapter?.tests??0),
  live_models: {status: 'NOT_EXECUTED', providers: ['jev','kev','laya'], reason: 'No real model or provider credentials available; run npm run test:live against each deployment.'},
  native_hosts: {status: 'NOT_EXECUTED', reason: 'Claude Code and Codex binaries/authenticated sessions are absent in the build environment; tests use explicit host CLI doubles.'},
  subagents: {status: 'NOT_USED', reason: 'No subagent runner was available; direct source review and regression tests were used.'},
  all_executed_checks_green: runs.length === 5 && adapter?.all_green===true && runs.every(run => run.exit_code === 0) && count('tests') > 0 && count('tests') === count('pass') && count('fail') === 0 && count('cancelled') === 0 && count('skipped') === 0,
};
await fs.writeFile(path.join(reports, 'validation.json'), JSON.stringify(summary, null, 2) + '\n');
if (!summary.all_executed_checks_green) process.exitCode = 1;
