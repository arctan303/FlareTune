import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownSafe } from './assistantMarkdownRenderer.js';

test('XiaoA Markdown renders headings, lists, quotes, tables, hr, and code', () => {
    const input = `
# 一级标题
## 二级标题
### 三级标题

> 这是一段引用

- 列表项 1
- 列表项 2

1. 序号 1
2. 序号 2

---

| 歌名 | 歌手 |
| --- | --- |
| 晴天 | 周杰伦 |

\`\`\`js
console.log('hello');
\`\`\`

这里有 **粗体**、*斜体*、~~删除线~~、以及 \`行内代码\`。
`;
    const html = renderMarkdownSafe(input);
    assert.match(html, /<h1>一级标题<\/h1>/);
    assert.match(html, /<h2>二级标题<\/h2>/);
    assert.match(html, /<h3>三级标题<\/h3>/);
    assert.match(html, /<blockquote>[\s\S]*这是一段引用[\s\S]*<\/blockquote>/);
    assert.match(html, /<ul>[\s\S]*<li>列表项 1<\/li>[\s\S]*<\/ul>/);
    assert.match(html, /<ol>[\s\S]*<li>序号 1<\/li>[\s\S]*<\/ol>/);
    assert.match(html, /<hr>/);
    assert.match(html, /<table>[\s\S]*<th>歌名<\/th>[\s\S]*<td>晴天<\/td>[\s\S]*<\/table>/);
    assert.match(html, /<div class="assistant-table-scroll" role="region" aria-label="表格，可左右滚动" tabindex="0"><table>[\s\S]*<\/table><\/div>/);
    assert.match(html, /<pre><code[\s\S]*console\.log\((?:'|&#39;)hello(?:'|&#39;)\);[\s\S]*<\/code><\/pre>/);
    assert.match(html, /<strong>粗体<\/strong>/);
    assert.match(html, /<em>斜体<\/em>/);
    assert.match(html, /<del>删除线<\/del>/);
    assert.match(html, /<code>行内代码<\/code>/);
});

test('XiaoA Markdown transforms internal song markers into interactive inline song pills', () => {
    const input = '你可以听听这首 [《絆》](song:416d748fc252ca08) 或者 [《Once Upon a Time》](https://external.example.test/?id=591a465d8e29f0a8)。';
    const html = renderMarkdownSafe(input);
    
    assert.doesNotMatch(html, /<a[^>]*href="song:/);
    assert.match(html, /<a href="https:\/\/external\.example\.test\/\?id=591a465d8e29f0a8"/);

    // 应转换为内联可点击歌曲胶囊
    assert.match(html, /<span class="xiaoa-inline-song" data-song-id="416d748fc252ca08"[^>]*>《絆》<\/span>/);
    assert.doesNotMatch(html, /data-song-id="591a465d8e29f0a8"/);
});

test('XiaoA Markdown keeps external article links as ordinary safe links', () => {
    const input = '推荐阅读 [《从E5炸弹机到AI助手》](https://blog.example.test/post/21) 这篇文章。';
    const html = renderMarkdownSafe(input);
    
    assert.match(html, /<a href="https:\/\/blog\.example\.test\/post\/21" target="_blank" rel="noopener noreferrer" class="xiaoa-markdown-link"/);
});
