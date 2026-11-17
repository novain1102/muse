/* Muse — shared helpers for Chinese music platforms (Kugou, QQ Music, NetEase Cloud Music).
 * Search keywords: these catalogues are mostly Mandarin pop, so each app genre / mood maps to a mix of the
 * English scene terms the platforms' DJ / electronic uploads are tagged with and the Chinese terms listeners use. */
(function () {
  'use strict';
  const P = window.NEONDJ.providers;
  const KEYWORDS = {
    genres: {
      'house':       ['house music', '浩室', 'house 电子', 'soulful house'],
      'deep-house':  ['deep house', '深浩室', 'deep house 电子', 'deep house chill'],
      'tech-house':  ['tech house', '科技浩室', 'tech house 电子', 'minimal tech house'],
      'techno':      ['techno', '科技舞曲', 'techno 电子', 'melodic techno'],
      'progressive': ['progressive house', '渐进浩室', 'melodic house', 'trance'],
      'electro':     ['electro house', '电气浩室', 'breakbeat', 'uk garage'],
      'disco':       ['nu disco', '迪斯科', 'disco', 'funk disco'],
      'dnb':         ['drum and bass', '鼓打贝斯', 'liquid dnb', 'jungle'],
      'bass':        ['dubstep', '回响贝斯', 'future bass', 'bass music'],
      'hiphop':      ['trap', '欧美说唱', 'melodic trap', 'trap rap'],
      'lofi':        ['lofi', 'lo-fi', '低保真', 'lofi 学习', 'chillhop'],
      'downtempo':   ['downtempo', 'chillout', '氛围音乐', 'trip hop', 'ambient'],
    },
    // (华语 has no keyword lists here: its seed artists live in GENRES.cpop.scene and scene.js ranks the rest)
    moods: {
      'chill': ['chill', '放松'], 'groovy': ['groove', '律动'], 'deep': ['deep', '深夜'], 'dreamy': ['dreamy', '梦幻'],
      'dark': ['dark', '暗黑'], 'happy': ['happy', '快乐'], 'energetic': ['energetic', '燃'],
    },
  };
  const stripTags = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  const https = u => String(u || '').replace(/^http:\/\//, 'https://');
  P.cn = { KEYWORDS, stripTags, https,
    /* rough energy prior from the search term that found the track */
    prior(term) { term = String(term || '').toLowerCase(); return /dnb|drum|techno|燃|energetic|dubstep|bass|electro|trance|科技|trap|drill|club|炸场|派对/.test(term) ? 0.7 : /lofi|lo-fi|chill|ambient|downtempo|放松|氛围|低保真|r&b|旋律/.test(term) ? 0.3 : 0.5; },
  };
})();
