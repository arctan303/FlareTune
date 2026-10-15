import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent, nodes } from '../../test/lyricCandidateHarness.js';

test('ambient controls expose translated tooltips for every breathing state', () => {
  const translations = { '开启音乐呼吸': 'Enable music breathing', '音乐呼吸：强劲': 'Music breathing: intense',
    '音乐呼吸：标准': 'Music breathing: standard', '音乐呼吸：轻': 'Music breathing: subtle' };
  const component = hookComponent({ file: fileURLToPath(new URL('./ImmersiveChrome.jsx', import.meta.url)),
    modules: { '../../i18n/index.js': { t: key => translations[key] || key }, 'lucide-react': {} } });
  for (const [enabled, intensity, expected] of [
    [false, 'subtle', 'Enable music breathing'], [true, 'subtle', 'Music breathing: subtle'],
    [true, 'standard', 'Music breathing: standard'], [true, 'intense', 'Music breathing: intense'],
  ]) {
    const tree = component.render({ isVisible: true, ambientEnabled: enabled, ambientIntensity: intensity });
    const titles = nodes(tree).filter(node => node.type === 'button').map(node => node.props.title);
    assert.ok(titles.includes(expected));
  }
  component.unmount();
});
