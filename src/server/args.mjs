// src/server/args.mjs (node N5)
// Command-line parsing for bin/wfviz.mjs. Pure: no I/O, no process access, so it can be unit-tested.

import { parseArgs } from 'node:util';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// setTimeout stores its delay in a signed 32-bit int; larger values fire after 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;
export const MAX_IDLE_SECONDS = Math.floor(MAX_TIMER_MS / 1000);
export const DEFAULT_IDLE_SECONDS = 120;
export const DEFAULT_PORT = 0;
// The replay clamps its speed to this range; the CLI only refuses what is no speed at all.
const DEFAULT_SPEED = 4;
const MIN_SPEED = 0.25;
const MAX_SPEED = 100;
const DECIMAL = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function usage() {
  return [
    'Usage: wfviz [options]',
    '',
    'Local, read-only visualizer for Claude Code Dynamic Workflow runs.',
    '',
    'Options:',
    '  --demo             serve built-in demo runs instead of real ones',
    '  --replay <run>     replay one saved run at the pace of its own timestamps: a run directory',
    '                     (<session>/subagents/workflows/wf_<id>) or a run id, looked up under --root',
    '                     it starts when the first browser page connects, once (no loop; restart wfviz to see it again)',
    `  --speed <n>        replay speed factor, a number above 0 (default ${DEFAULT_SPEED}; clamped to ${MIN_SPEED}..${MAX_SPEED}); only with --replay`,
    `  --port <n>         port on 127.0.0.1 (default ${DEFAULT_PORT} = any free port)`,
    '  --no-open          do not open a browser',
    '  --root <dir>       projects directory to scan, or to look a --replay run id up in (default: ~/.claude/projects)',
    '  --since <hours>    runs changed within the last <hours> are loaded at start (read in full, watched); every run is listed (default: 24; Infinity = all; not used by --replay)',
    '  --offline          never fetch model prices (OpenRouter\'s public list): costs show as unknown',
    `  --idle <seconds>   exit this long after the last browser client leaves (default ${DEFAULT_IDLE_SECONDS}; 0 = never)`,
    '  -h, --help         show this help',
    '',
  ].join('\n');
}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{ demo: boolean, replay: string|undefined, speed: number|undefined, port: number, noOpen: boolean,
 *             root: string|undefined, sinceHours: number|undefined, idleSeconds: number, offline: boolean, help: boolean }}
 * @throws {UsageError}
 */
export function parseArgv(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        demo: { type: 'boolean' },
        replay: { type: 'string' },
        speed: { type: 'string' },
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        root: { type: 'string' },
        since: { type: 'string' },
        idle: { type: 'string' },
        offline: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }

  const result = {
    demo: values.demo === true,
    replay: undefined,
    speed: undefined,
    port: DEFAULT_PORT,
    noOpen: values['no-open'] === true,
    root: undefined,
    sinceHours: undefined,
    idleSeconds: DEFAULT_IDLE_SECONDS,
    offline: values.offline === true,
    help: values.help === true,
  };

  if (values.replay !== undefined) {
    if (values.replay.trim() === '') throw new UsageError('--replay needs a run directory or a run id');
    if (result.demo) throw new UsageError('--replay and --demo cannot be used together');
    result.replay = values.replay;
  }

  if (values.speed !== undefined) {
    if (result.replay === undefined) throw new UsageError('--speed only works with --replay');
    const speed = DECIMAL.test(values.speed) ? Number(values.speed) : NaN;
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new UsageError(`--speed must be a number above 0 (the replay clamps it to ${MIN_SPEED}..${MAX_SPEED}), got ${JSON.stringify(values.speed)}`);
    }
    result.speed = speed;
  }

  if (values.port !== undefined) {
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) {
      throw new UsageError(`--port must be an integer from 0 to 65535, got "${values.port}"`);
    }
    result.port = Number(values.port);
  }

  if (values.root !== undefined) {
    if (values.root.trim() === '') throw new UsageError('--root must not be empty');
    result.root = values.root;
  }

  if (values.since !== undefined) {
    const hours = values.since.trim() === '' ? NaN : Number(values.since);
    if (Number.isNaN(hours) || hours <= 0) {
      throw new UsageError(`--since must be a positive number of hours (or Infinity), got "${values.since}"`);
    }
    result.sinceHours = hours;
  }

  if (values.idle !== undefined) {
    const seconds = values.idle.trim() === '' ? NaN : Number(values.idle);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_IDLE_SECONDS) {
      throw new UsageError(`--idle must be a number of seconds from 0 to ${MAX_IDLE_SECONDS}, got "${values.idle}"`);
    }
    result.idleSeconds = seconds;
  }

  return result;
}
