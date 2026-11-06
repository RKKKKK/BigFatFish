// Publish the current HEAD to GitHub through the REST API when git's smart-HTTP
// endpoint is blocked but api.github.com is reachable.
//
//   $env:GITHUB_TOKEN = 'github_pat_...'
//   node scripts/publish-github.mjs
//
// The token needs repository Contents read/write. It is never printed or saved.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OWNER = 'RKKKKK';
const REPO = 'BigFatFish';
const BRANCH = 'main';
const API = 'https://api.github.com';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
if (!token) {
  console.error('Set GITHUB_TOKEN to a fine-grained token with Contents: Read and write.');
  process.exit(2);
}

const portableGit = 'C:\\Users\\Lenovo\\AppData\\Local\\Programs\\WorkBuddy\\resources\\vendor\\PortableGit\\cmd\\git.exe';
const git = process.env.GIT_BIN || (fs.existsSync(portableGit) ? portableGit : 'git');
const root = process.cwd();
const json = async (method, route, body) => {
  const response = await fetch(API + route, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'BigFatFish-publisher',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = data && typeof data === 'object' ? data.message : String(data || '');
    throw new Error(method + ' ' + route + ' -> ' + response.status + ' ' + message);
  }
  return data;
};

const treeOutput = execFileSync(git, ['ls-tree', '-r', '-z', 'HEAD'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const entries = [];
for (const record of treeOutput.toString('utf8').split('\0')) {
  if (!record) continue;
  const tab = record.indexOf('\t');
  if (tab < 0) continue;
  const [mode, type, sha] = record.slice(0, tab).split(' ');
  const file = record.slice(tab + 1);
  if (type !== 'blob') continue;
  entries.push({ mode, path: file, local: path.join(root, ...file.split('/')) });
}

const commit = execFileSync(git, ['log', '-1', '--format=%an%n%ae%n%cn%n%ce%n%s', 'HEAD'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n');
const [authorName, authorEmail, committerName, committerEmail, subject] = commit;
const treeEntries = [];
for (let index = 0; index < entries.length; index++) {
  const entry = entries[index];
  const content = fs.readFileSync(entry.local).toString('base64');
  const blob = await json('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
    content, encoding: 'base64',
  });
  treeEntries.push({ path: entry.path, mode: entry.mode === '100755' ? '100755' : '100644', type: 'blob', sha: blob.sha });
  if ((index + 1) % 25 === 0 || index + 1 === entries.length) {
    console.log('uploaded ' + (index + 1) + '/' + entries.length);
  }
}

const tree = await json('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', { tree: treeEntries });
let parents = [];
try {
  const ref = await json('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  if (ref?.object?.sha) parents = [ref.object.sha];
} catch (error) {
  if (!/ 404 /.test(error.message) && !/ 409 /.test(error.message)) throw error;
}

const created = await json('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
  message: subject || 'BigFatFish',
  tree: tree.sha,
  parents,
  author: { name: authorName, email: authorEmail },
  committer: { name: committerName, email: committerEmail },
});
try {
  await json('POST', '/repos/' + OWNER + '/' + REPO + '/git/refs', {
    ref: 'refs/heads/' + BRANCH, sha: created.sha,
  });
} catch (error) {
  if (!/ 422 /.test(error.message)) throw error;
  await json('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, {
    sha: created.sha, force: false,
  });
}
console.log('published https://github.com/' + OWNER + '/' + REPO + '/commit/' + created.sha);
