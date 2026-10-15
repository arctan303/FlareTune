import test from 'node:test';
import assert from 'node:assert/strict';
import {createResilientStorage} from './browserStorage.js';
test('denied storage keeps session changes and removal usable',()=>{
 const storage=createResilientStorage(()=>{throw new DOMException('denied','SecurityError');});
 assert.equal(storage.getItem('a'),null);
 storage.setItem('a','one');assert.equal(storage.getItem('a'),'one');
 storage.removeItem('a');assert.equal(storage.getItem('a'),null);
});
test('quota failure retains previous reads and new values without restoring stale disk values',()=>{
 let fail=false;const disk=new Map([['a','old'],['b','saved']]);
 const storage=createResilientStorage(()=>({getItem:k=>disk.get(k)??null,setItem(k,v){if(fail)throw Error('quota');disk.set(k,v);},removeItem:k=>disk.delete(k)}));
 assert.equal(storage.getItem('a'),'old');assert.equal(storage.getItem('b'),'saved');
 storage.setItem('a','persisted');assert.equal(disk.get('a'),'persisted');
 fail=true;storage.setItem('a','temporary');
 assert.equal(storage.getItem('a'),'temporary');assert.equal(storage.getItem('b'),'saved');
 storage.removeItem('b');assert.equal(storage.getItem('b'),null);
});
