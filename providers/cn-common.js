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
      'hiphop':      ['instrumental hip hop', '嘻哈 伴奏', 'boom bap', 'jazz rap'],
      'lofi':        ['lofi', 'lo-fi', '低保真', 'lofi 学习', 'chillhop'],
      'downtempo':   ['downtempo', 'chillout', '氛围音乐', 'trip hop', 'ambient'],
      'cpop':        ['华语说唱', '中文说唱', '华语 trap', '中文 trap', '新说唱', '华语 R&B'],
    },
    // 华语 sub-flavours picked by mood — artists (searched for their own tracks), all hip-hop / trap / club / R&B
    flavors: {
      'cpop': {
        'energetic': ['GAI', '法老', 'BrAnTB小胖', 'Higher Brothers', '艾福杰尼', '黄旭'], 'dark': ['法老', '谢帝', '派克特', '福克斯', '弹壳', 'KEY.L刘聪'],
        'groovy': ['马思唯', 'Jony J', '王以太', '刘至佳', 'Higher Brothers', 'Vava'], 'chill': ['王以太', '刘柏辛', '沙一汀', '刘至佳', 'Tia Ray袁娅维', '那吾克热'],
        'dreamy': ['刘柏辛', '沙一汀', '王以太', '欧阳娜娜', 'Capper'], 'happy': ['Vava', '万妮达', '王嘉尔', '蔡徐坤', '布瑞吉', 'J-Fever'],
        'deep': ['杨和苏', 'KEY.L刘聪', '那吾克热', '法老', 'Jony J'],
      },
    },
    // artists searched for hit-seeking genres (search terms only; what plays is whatever the platform serves free).
    // 华语: this generation's rap / trap / club acts …
    artists: {
      'cpop': ['Higher Brothers', 'GAI', '马思唯', '谢帝', '艾福杰尼', '那吾克热', '法老', '杨和苏', 'KEY.L刘聪', 'Vava', '万妮达', 'BrAnTB小胖',
        '刘柏辛', '沙一汀', 'Jony J', 'ICE 说唱', 'Ty. 说唱', 'TT 说唱', '黄旭', '小鬼王琳凯', '派克特', '福克斯', 'J-Fever', '布瑞吉', 'Capper', '弹壳', 'Lil Jet'],
    },
    // … plus ~1 in 6 searches for modern R&B / urban pop
    artists2: {
      'cpop': ['王以太', '刘至佳', 'Tia Ray袁娅维', '蔡徐坤', '王嘉尔', '欧阳娜娜', '刘雨昕', '周柯宇', '刘耀文'],
    },
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
