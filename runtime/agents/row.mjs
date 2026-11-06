import os from 'node:os';
import path from 'node:path';

// The status color every task row shares: green for work in progress or done,
// yellow for a question or permission, red for a problem, gray for idle.
export const COLOR = Object.freeze({ running: 'green', done: 'green', question: 'yellow', permission: 'yellow', stuck: 'red', failed: 'red', aborted: 'red', idle: 'gray' });

const HOME = os.homedir();

// One task-window row. `name` is the project folder and `place` is that folder
// as the user would write it, with the home directory shortened to ~.
export function agentRow({ contextPercent = null, ...fields }) {
  const percent = contextPercent ?? (fields.tokens && fields.contextWindow ? fields.tokens / fields.contextWindow * 100 : null);
  const cwd = typeof fields.cwd === 'string' ? fields.cwd : '';
  const place = HOME && (cwd === HOME || cwd.startsWith(HOME + path.sep)) ? '~' + cwd.slice(HOME.length) : cwd;
  return { ...fields, name: path.basename(cwd) || '未知项目', place, color: COLOR[fields.state],
    contextPercent: percent === null ? null : Math.min(100, Math.round(percent * 10) / 10) };
}
