import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATABASE_VERSION } from '../server/store.ts';
import { version } from '../shared/version.ts';
const command = process.argv[2];
if (!['check', 'package'].includes(command))
  throw new Error('Use check or package.');
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('Use a stable semantic version.');
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
if (lock.version !== version || lock.packages[''].version !== version)
  throw new Error('Lockfile version must match package.json.');
for (const file of [
  'deploy/compose/compose.yaml',
  'deploy/compose/.env.example',
  'deploy/kubernetes/restore-pod.example.yaml',
]) {
  const images = [
    ...readFileSync(file, 'utf8').matchAll(
      /ghcr\.io\/rdpr\/checkpoint:([\d.]+)/g,
    ),
  ];
  if (!images.length || images.some((match) => match[1] !== version))
    throw new Error(`Default image in ${file} must match ${version}.`);
}
if (
  !readFileSync('Dockerfile', 'utf8').includes(`ARG BUILD_VERSION=${version}\n`)
)
  throw new Error('Docker build version must match package.json.');
if (
  !readFileSync('deploy/kubernetes/values.yaml', 'utf8').includes(
    `tag: '${version}'`,
  )
)
  throw new Error('Helm default image tag must match package.json.');
const chart = readFileSync('deploy/kubernetes/Chart.yaml', 'utf8');
for (const key of ['version', 'appVersion']) {
  if (
    !new RegExp(
      `^${key}: ['"]?${version.replaceAll('.', '\\.')}['"]?$`,
      'm',
    ).test(chart)
  )
    throw new Error(`Chart ${key} must match package version ${version}.`);
}
const changelog = readFileSync('CHANGELOG.md', 'utf8');
if (!changelog.includes(`## ${version}`))
  throw new Error('Add release notes to CHANGELOG.md.');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
if (!files.length)
  throw new Error('Stage the release source before checking it.');
for (const file of files) {
  if (
    /(^|\/)(AGENTS\.md|SKILL\.md|\.data|\.hosting|node_modules|dist|secrets|test-results|playwright-report)(\/|$)/i.test(
      file,
    ) ||
    /\.(sqlite[^/]*|pem|key|private\.json|private\.yaml)$/.test(file) ||
    /(^|\/)\.env($|\.(?!example$))/.test(file)
  )
    throw new Error(`Private/generated file staged for publication: ${file}`);
  if (
    file.endsWith('.md') &&
    ![
      'README.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'THIRD_PARTY_NOTICES.md',
    ].includes(file) &&
    !file.startsWith('docs/')
  )
    throw new Error(`Unrecognized documentation in release: ${file}`);
}
console.log(
  `Checkpoint ${version}; database schema ${DATABASE_VERSION}; ${files.length} source files.`,
);
if (command === 'package') {
  if (
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
    }).trim()
  )
    throw new Error('Release source must be committed and clean.');
  rmSync('release', { recursive: true, force: true });
  mkdirSync('release');
  execFileSync('git', [
    'archive',
    '--format=tar.gz',
    `--prefix=checkpoint-${version}/`,
    '-o',
    `release/checkpoint-${version}-source.tar.gz`,
    'HEAD',
  ]);
  execFileSync('git', [
    'archive',
    '--format=tar.gz',
    '-o',
    `release/checkpoint-${version}-deploy.tar.gz`,
    'HEAD',
    'deploy',
    'docs/installation.md',
    'docs/operations.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ]);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  writeFileSync(
    join('release', 'release.json'),
    JSON.stringify(
      {
        name: 'checkpoint',
        version,
        commit,
        databaseSchema: DATABASE_VERSION,
        platforms: ['linux/amd64'],
        image: process.env.RELEASE_IMAGE ?? null,
        workflow: process.env.GITHUB_RUN_ID
          ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
      },
      null,
      2,
    ) + '\n',
  );
  const notes = changelog
    .split(`## ${version}`)[1]
    .split('\n## ')[0]
    .split('\n')
    .slice(1) // The heading may include a release date.
    .join('\n')
    .trim()
    .replace(
      /\]\((docs\/[^)]+)\)/g,
      `](https://github.com/rdpr/checkpoint/blob/v${version}/$1)`,
    );
  writeFileSync(
    'release/RELEASE_NOTES.md',
    notes +
      `\n\nImage: \`${process.env.RELEASE_IMAGE ?? 'local packaging: image not published'}\`\n\nDatabase schema: ${DATABASE_VERSION}. See the operations guide before upgrading or restoring.\n`,
  );
}
