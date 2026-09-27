const KANA = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ゔ: 'vu',
};

const DIGRAPHS = {
  き: 'ky', し: 'sh', ち: 'ch', に: 'ny', ひ: 'hy', み: 'my', り: 'ry',
  ぎ: 'gy', じ: 'j', ぢ: 'j', び: 'by', ぴ: 'py',
};

const SMALL_VOWELS = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };

export function romanizeJapaneseKana(value) {
  const input = String(value || '').normalize('NFKC').toLowerCase();
  const chars = [...input].map((char) => {
    const code = char.codePointAt(0);
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : char;
  });
  let result = '';
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const next = chars[i + 1];
    if (char === 'っ') {
      const nextSound = DIGRAPHS[next] || KANA[next] || '';
      result += nextSound.startsWith('ch') ? 't' : nextSound[0] || '';
    } else if (char === 'ー') {
      result += result.match(/[aeiou](?!.*[aeiou])/)?.[0] || '';
    } else if (DIGRAPHS[char] && ['ゃ', 'ゅ', 'ょ'].includes(next)) {
      result += DIGRAPHS[char] + { ゃ: 'a', ゅ: 'u', ょ: 'o' }[next];
      i += 1;
    } else if (KANA[char]) {
      result += KANA[char];
      if (SMALL_VOWELS[next] && /[aeiou]$/.test(result)) {
        result = result.slice(0, -1) + SMALL_VOWELS[next];
        i += 1;
      }
    } else if (/[a-z0-9]/.test(char)) {
      result += char;
    }
  }
  return result;
}

export const isRomanizedSearchQuery = (value) => /^[a-z]{3,}$/i.test(
  String(value || '').normalize('NFKC').replace(/[\s\-_'’]/g, ''),
);
