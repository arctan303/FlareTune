import test from 'node:test';
import assert from 'node:assert/strict';
import { getCenteredQueueScrollTop } from './queueScroll.js';

test('centers a queue item within the available viewport', () => {
    assert.equal(getCenteredQueueScrollTop({
        itemTop: 520,
        itemHeight: 56,
        viewportHeight: 280,
        scrollHeight: 1120,
    }), 408);
});

test('clamps queue centering at the start and end of the list', () => {
    assert.equal(getCenteredQueueScrollTop({
        itemTop: 0,
        itemHeight: 56,
        viewportHeight: 280,
        scrollHeight: 1120,
    }), 0);
    assert.equal(getCenteredQueueScrollTop({
        itemTop: 1064,
        itemHeight: 56,
        viewportHeight: 280,
        scrollHeight: 1120,
    }), 840);
});

test('keeps short or invalid queue layouts at the top', () => {
    assert.equal(getCenteredQueueScrollTop({
        itemTop: 56,
        itemHeight: 56,
        viewportHeight: 280,
        scrollHeight: 200,
    }), 0);
    assert.equal(getCenteredQueueScrollTop({
        itemTop: Number.NaN,
        itemHeight: 56,
        viewportHeight: 280,
        scrollHeight: 1120,
    }), 0);
});
