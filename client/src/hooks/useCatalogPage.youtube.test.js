import * as musicSources from '../services/musicSources.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

test('merged local and YouTube pages follow server offsets rather than the merged row count', async () => {
  const requests = [];
  const local = Array.from({ length:20 }, (_,i) => ({ id:`local-${i}`, name:'Same' }));
  const youtube = Array.from({ length:20 }, (_,i) => ({ id:`yt:artist:UC${i}`, name:'Same', source:'youtube' }));
  const harness = createBackgroundModuleHarness({ file: new URL('./useCatalogPage.js',import.meta.url), exportName:'useCatalogPage',
    modules: {
      '../services/catalogRead.js': { readCatalog: async (_type, options) => {
        requests.push(options.offset);
        return requests.length === 1
          ? { items:[...local,...youtube], hasMore:true, nextOffset:20, sourceWarnings:[] }
          : { items:[{id:'last-local'}], hasMore:false, nextOffset:40, sourceWarnings:[{source:'youtube',code:'unavailable'}] };
      } },
      '../services/apiBase.js': { getApiBaseUrl: () => 'test-merged-pages' },
    },
    globals:{ AbortController }, render: (exports, props) => exports.useCatalogPage('artists',props),
  });
  harness.render({query:'Same',limit:20}); await flushBackgroundAsync();
  let page=harness.render();
  assert.equal(page.items.length,40);
  assert.equal(page.items.filter(item=>item.name==='Same').length,40,'same-name sources are not deduplicated');
  await page.loadMore(); page=harness.render();
  assert.deepEqual(requests,[0,20]);
  assert.equal(page.items.length,41);
  assert.equal(page.hasMore,false);
  assert.equal(page.sourceWarnings[0].code,'unavailable');
  await page.loadMore(); assert.deepEqual(requests,[0,20],'a finite source cannot loop the last page');
  harness.unmount();
});


test('source change immediately retains local results, refreshes, and rejects an old in-flight YouTube page', async () => {
  const requests=[];
  const local={id:'local',name:'Local'};
  const fixture=createBackgroundModuleHarness({file:new URL('./useCatalogPage.js',import.meta.url),exportName:'useCatalogPage',
    modules:{
      '../services/musicSources.js':musicSources,
      '../services/apiBase.js':{getApiBaseUrl:()=> 'source-revision-pages'},
      '../services/catalogRead.js':{readCatalog:(_type,options)=>new Promise(resolve=>requests.push({options,resolve}))},
    },globals:{AbortController},render:(exports,props)=>exports.useCatalogPage('artists',props),
  });
  fixture.render({query:'Same'});
  requests[0].resolve({items:[local,{id:'yt:artist:UCold',source:'youtube'}],hasMore:true,nextOffset:20});
  await flushBackgroundAsync();let page=fixture.render();assert.equal(page.items.length,2);
  const oldMore=page.loadMore();
  musicSources.notifyMusicSourcesChanged();
  page=fixture.render();assert.deepEqual(page.items.map(item=>item.id),['local']);
  assert.equal(requests.length,3);
  requests[1].resolve({items:[{id:'yt:artist:UCstale',source:'youtube'}],hasMore:false,nextOffset:40});
  await oldMore;page=fixture.render();assert.deepEqual(page.items.map(item=>item.id),['local']);
  requests[2].resolve({items:[local],hasMore:false,nextOffset:20});
  await flushBackgroundAsync();page=fixture.render();assert.deepEqual(page.items.map(item=>item.id),['local']);
  fixture.unmount();
});
