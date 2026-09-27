import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scrollingTextSource = readFileSync(new URL('./ScrollingText.jsx', import.meta.url), 'utf8');
const playerBarSource = readFileSync(new URL('../PlayerBar.jsx', import.meta.url), 'utf8');

test('ScrollingText supports left alignment and avoids hardcoded text-center when aligned left', () => {
    assert.match(scrollingTextSource, /align = 'center'/);
    assert.match(scrollingTextSource, /const isLeft = align === 'left' \|\| className\.includes\('text-left'\);/);
    assert.match(scrollingTextSource, /\$\{isLeft \? 'text-left' : 'text-center'\}/);
    assert.match(scrollingTextSource, /isLeft \? 'justify-start w-full' : 'justify-center w-full'/);
});

test('ScrollingText uses left-anchored mask gradient when aligned left with overflow', () => {
    assert.match(scrollingTextSource, /linear-gradient\(to right, black 0%, black calc\(100% - 14px\), transparent 100%\)/);
});

test('PlayerBar expanded bottom metadata uses items-start and align="left" for flush left alignment', () => {
    assert.match(playerBarSource, /<div key=\{currentSong\?\.id \+ '-meta'\} className="flex flex-col items-start text-left w-full max-w-md animate-player-content-drift-in pointer-events-auto">/);
    assert.match(playerBarSource, /<ScrollingText className="font-bold transition-colors text-white\/95 text-\[13px\] tracking-wide text-left w-full" align="left">/);
    assert.match(playerBarSource, /<ScrollingText className="transition-colors text-\[11px\] mt-0\.5 text-white\/60 text-left w-full" align="left">/);
});
