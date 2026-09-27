import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../server/src/flaretune.js';

test('current Worker serves static assets and does not expose missing assets', async () => {
    const assetRequest = new Request('https://music.pages.dev/index.html');
    const assetResponse = await worker.fetch(assetRequest, {
        ASSETS: {
            async fetch(req) {
                return new Response('<html>ok</html>', { status: 200 });
            },
        },
    }, {});
    assert.equal(assetResponse.status, 200);
    assert.equal(await assetResponse.text(), '<html>ok</html>');

    const missingAssetsResponse = await worker.fetch(assetRequest, {}, {});
    assert.equal(missingAssetsResponse.status, 404);
});
