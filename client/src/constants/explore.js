import zhImage from '../assets/categories/zh.jpg';
import enImage from '../assets/categories/en.jpg';
import instrumentalImage from '../assets/categories/instrumental.jpg';
import jaImage from '../assets/categories/ja.jpg';
import otherImage from '../assets/categories/other.jpg';
import koImage from '../assets/categories/ko.jpg';

/**
 * 03 / EXPLORE 曲库探索 6 大核心分类配置与默认外显设定
 */

export const CANONICAL_EXPLORE_KEYS = Object.freeze([
  'zh',
  'en',
  'instrumental',
  'ja',
  'other',
  'ko',
]);

export const EXPLORE_PRESETS = Object.freeze({
  zh: {
    key: 'zh',
    label: '中文',
    tag: 'ZH',
    subtitle: '华语流行',
    gradient: 'from-[#d97706] to-[#f59e0b]',
    accentColor: '#d97706',
    image: zhImage,
  },
  en: {
    key: 'en',
    label: '英语',
    tag: 'EN',
    subtitle: '欧美精选',
    gradient: 'from-[#1d4ed8] to-[#3b82f6]',
    accentColor: '#1d4ed8',
    image: enImage,
  },
  instrumental: {
    key: 'instrumental',
    label: '纯音乐',
    tag: 'BGM',
    subtitle: '器乐原声',
    gradient: 'from-[#047857] to-[#10b981]',
    accentColor: '#047857',
    image: instrumentalImage,
  },
  ja: {
    key: 'ja',
    label: '日语',
    tag: 'JA',
    subtitle: '日系声色',
    gradient: 'from-[#7e22ce] to-[#a855f7]',
    accentColor: '#7e22ce',
    image: jaImage,
  },
  other: {
    key: 'other',
    label: '小语种',
    tag: 'OTH',
    subtitle: '世界探索',
    gradient: 'from-[#c2410c] to-[#f97316]',
    accentColor: '#c2410c',
    image: otherImage,
  },
  ko: {
    key: 'ko',
    label: '韩语',
    tag: 'KO',
    subtitle: '流行K-POP',
    gradient: 'from-[#be123c] to-[#fb7185]',
    accentColor: '#be123c',
    image: koImage,
  },
});

export const EXPLORE_CATEGORIES = Object.freeze(
  CANONICAL_EXPLORE_KEYS.map((key) => EXPLORE_PRESETS[key]),
);
