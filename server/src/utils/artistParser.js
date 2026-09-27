/**
 * 智能歌手名称标准化与多歌手拆分工具函数
 * 支持常见音乐元数据中的合作、合唱、Feat. 格式：
 * - 斜杠/反斜杠：'周杰伦 / 费玉清'、'周杰伦/温岚'
 * - 英文 Feat/Ft：'Taylor Swift feat. Kendrick Lamar'、'Marshmello ft. CHVRCHES'
 * - 连接词：'米津玄師 & 菅田将暉'、'Coldplay with BTS'、'林俊杰 vs 蔡依林'、'Marshmello x Halsey'
 * - 标点符号：'YOASOBI; Ayase'、'周深, G.E.M.邓紫棋'、'王菲 · 梁朝伟'
 * - 全球语言支持：中文、日文假名（如サカナクション）、韩文（如아이유）、欧美等 Unicode 字母与数字
 */
export function parseArtistNames(rawArtist) {
    if (!rawArtist || typeof rawArtist !== 'string') return [];
    
    const cleaned = rawArtist
        .replace(/\s+(feat\.?|ft\.?|featuring|with|vs\.?|v\.s\.?|x)\s+/gi, ' / ')
        .replace(/[&,;、•·\\|]/g, ' / ');
    
    const parts = cleaned
        .split('/')
        .map(name => name.trim())
        .filter(name => {
            if (!name || name.length === 0) return false;
            // 必须包含至少一个有效 Unicode 文字（中日韩欧美等）或数字，过滤纯标点符号噪声
            return /[\p{L}\p{N}]/u.test(name);
        });

    // 数组去重并保持原有顺序
    const seen = new Set();
    const result = [];
    for (const name of parts) {
        const lower = name.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            result.push(name);
        }
    }
    return result;
}
