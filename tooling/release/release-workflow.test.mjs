import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const stages = [workflow.jobs.validate.steps.find((step) => step.id === 'release').run,
  workflow.jobs.publish.steps.find((step) => step.name === 'Confirm immutable tag and prepare notes').run,
  workflow.jobs['publish-npm'].steps.find((step) => step.name === 'Confirm immutable tag before npm publication').run];
const tag = '1.1.3';

function fixture(t, { lightweight = false, offMain = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flaretune-release-test-'));
  t.after(() => {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('flaretune-release-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const clone = join(root, 'checkout');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(source);
  git(source, 'init', '--initial-branch=main');
  git(source, 'config', 'user.name', 'Release fixture');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(source, 'tooling', 'release'), { recursive: true });
  copyFileSync(new URL('./prepare-notes.mjs', import.meta.url), join(source, 'tooling', 'release', 'prepare-notes.mjs'));
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: tag }));
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ version: tag, packages: { '': { version: tag } } }));
  for (const path of ['CHANGELOG.md', 'CHANGELOG.en.md']) writeFileSync(join(source, path), `## ${tag} — 2026-10-03\n\nA complete release.\n`);
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'main');
  if (offMain) {
    git(source, 'switch', '-c', 'outside');
    writeFileSync(join(source, 'outside.txt'), 'outside main');
    git(source, 'add', '.'); git(source, 'commit', '-m', 'outside');
  }
  const commit = git(source, 'rev-parse', 'HEAD');
  if (lightweight) git(source, 'tag', tag);
  else git(source, 'tag', '-a', tag, '-m', 'fixture');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', 'origin', 'main', '--tags');
  git(root, 'clone', remote, clone);
  git(clone, 'checkout', commit);
  // Reproduce actions/checkout's fallback refspec replacing the local tag with event SHA.
  git(clone, 'update-ref', `refs/tags/${tag}`, commit);
  const output = join(root, 'outputs');
  return { root, clone, source, remote, commit, git, run: (script) => spawnSync(bash, ['-e', '-c', script], {
    cwd: clone, encoding: 'utf8', env: { ...process.env, RELEASE_TAG: tag, RUNNER_TEMP: root, GITHUB_OUTPUT: output },
  }) };
}

test('release stages use the authoritative remote annotated tag after checkout synthesized a lightweight local ref', (t) => {
  const candidate = fixture(t);
  assert.equal(candidate.git(candidate.clone, 'cat-file', '-t', tag), 'commit');
  for (const script of stages) {
    const result = candidate.run(script);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Validated bilingual release notes/);
  }
});

test('both release stages reject remote lightweight and off-main tags', (t) => {
  for (const options of [{ lightweight: true }, { offMain: true }]) {
    const candidate = fixture(t, options);
    for (const script of stages) assert.notEqual(candidate.run(script).status, 0);
  }
});

test('release publication rejects a moved remote tag instead of publishing the validated commit under another identity', (t) => {
  const candidate = fixture(t);
  assert.equal(candidate.run(stages[0]).status, 0);
  writeFileSync(join(candidate.source, 'next.txt'), 'another commit');
  candidate.git(candidate.source, 'add', '.'); candidate.git(candidate.source, 'commit', '-m', 'next');
  candidate.git(candidate.source, 'tag', '-fa', tag, '-m', 'moved');
  candidate.git(candidate.source, 'push', '--force', 'origin', 'main', `refs/tags/${tag}`);
  candidate.git(candidate.clone, 'update-ref', '-d', 'refs/release-candidate');
  assert.notEqual(candidate.run(stages[1]).status, 0);
});

test('PR validation cannot start the publication job and recovery checks out the original validated commit', () => {
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.publish.permissions.contents, 'write');
  assert.equal(workflow.jobs.publish.steps[0].with.ref, '${{ needs.validate.outputs.commit }}');
  assert.equal(workflow.jobs.validate.steps[1].with.ref, '${{ inputs.tag || github.ref }}');
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  const npm = workflow.jobs['publish-npm'];
  assert.equal(npm.permissions.contents, 'read');
  assert.equal(npm.permissions['id-token'], 'write');
  assert.equal(workflow.jobs.validate.permissions?.['id-token'], undefined);
  assert.equal(npm.if, "needs.validate.outputs.npm_supported == 'true' && github.repository == 'arctan303/FlareTune' && (github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref_type == 'tag'))");
  assert.equal(npm.steps[0].with.ref, '${{ needs.validate.outputs.commit }}');
  assert.deepEqual(workflow.jobs.publish.needs, ['validate', 'publish-npm']);
});

test('historical 1.1 tags retain GitHub Release recovery while 1.2 and later require npm support', (t) => {
  const candidate = fixture(t);
  const identify = workflow.jobs.validate.steps.find((step) => step.id === 'ingest-package').run;
  for (const [version, supported] of [['1.1.4', false], ['1.2.0', true], ['1.10.0', true], ['2.0.0', true]]) {
    writeFileSync(join(candidate.clone, 'package.json'), JSON.stringify({ version }));
    const result = candidate.run(identify);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(join(candidate.root, 'outputs'), 'utf8').trim().endsWith(`supported=${supported}`));
  }
  for (const command of ['npm run ingest:pack', 'npm run ingest:verify-package']) {
    assert.equal(workflow.jobs.validate.steps.find((step) => step.run === command).if,
      "steps.ingest-package.outputs.supported == 'true'");
  }
});

test('publication conditions reject PRs, forks, failed npm jobs and skipped current packages while allowing legacy recovery', () => {
  const permitted = (job, { legacy = false, npmResult = 'success', validation = 'success', cancelled = false,
    event = 'push', repository = 'arctan303/FlareTune', refType = 'tag' } = {}) => {
    // These workflow conditions use the common JS/GitHub expression subset. Evaluate the actual condition against job results.
    const expression = workflow.jobs[job].if.replaceAll('needs.publish-npm', "needs['publish-npm']");
    return Function('needs', 'github', 'always', 'cancelled', `return Boolean(${expression});`)(
      { validate: { result: validation, outputs: { npm_supported: String(!legacy) } }, 'publish-npm': { result: npmResult } },
      { event_name: event, repository, ref_type: refType }, () => true, () => cancelled);
  };
  assert.equal(permitted('publish-npm'), true);
  for (const options of [{ event: 'pull_request' }, { refType: 'branch' }, { repository: 'another/fork' }, { legacy: true }]) {
    assert.equal(permitted('publish-npm', options), false);
  }
  assert.equal(permitted('publish'), true);
  assert.equal(permitted('publish', { legacy: true, npmResult: 'skipped', event: 'workflow_dispatch' }), true);
  for (const options of [{ npmResult: 'failure' }, { npmResult: 'skipped' }, { validation: 'failure' },
    { event: 'pull_request' }, { cancelled: true }, { legacy: true, npmResult: 'skipped', validation: 'failure' }]) {
    assert.equal(permitted('publish', options), false);
  }
});
