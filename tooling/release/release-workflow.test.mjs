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
  workflow.jobs.publish.steps.find((step) => step.name === 'Confirm immutable tag and prepare notes').run];
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
  assert.equal(workflow.jobs.publish.if, "github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref_type == 'tag')");
  assert.equal(workflow.jobs.publish.steps[0].with.ref, '${{ needs.validate.outputs.commit }}');
  assert.equal(workflow.jobs.validate.steps[1].with.ref, '${{ inputs.tag || github.ref }}');
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
});
