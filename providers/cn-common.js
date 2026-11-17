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
      'cpop':        ['华语流行', '华语 热歌', '华语金曲', '华语 经典', '华语R&B', '国风', '粤语 经典', '华语说唱', '民谣', '华语 新歌', '华语 原创', '综艺 live'],
    },
    // 华语 sub-flavours picked by mood (one chip, mood chips choose the flavour)
    flavors: {
      'cpop': {
        'chill': ['华语 抒情', '民谣', '华语 治愈'], 'groovy': ['华语R&B', '华语 R&B 律动', '华语 放克'], 'deep': ['粤语 经典', '华语 深情', '粤语 抒情'],
        'dreamy': ['国风', '古风', '中国风'], 'dark': ['华语说唱', '中文说唱', '华语 摇滚'], 'happy': ['华语 甜歌', '华语流行', '华语 热歌'],
        'energetic': ['华语说唱', '华语 摇滚', '华语 热歌'],
      },
    },
    // popular artists' catalogues for hit-seeking genres (search terms only; what plays is whatever the platform serves free)
    artists: {
      'cpop': ['周杰伦', '林俊杰', '陈奕迅', '邓紫棋', '薛之谦', '李荣浩', '毛不易', '周深', '王菲', '孙燕姿', '五月天', '蔡依林', '张学友', '汪苏泷',
        '莫文蔚', '陶喆', '王力宏', '田馥甄', '张惠妹', '华晨宇', '许嵩', '李健', '赵雷', '朴树', '告五人', '单依纯', '张杰', '梁静茹', '方大同', '容祖儿', '杨千嬅', '刘惜君'],
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
    prior(term) { term = String(term || '').toLowerCase(); return /dnb|drum|techno|燃|energetic|dubstep|bass|electro|trance|科技/.test(term) ? 0.7 : /lofi|lo-fi|chill|ambient|downtempo|放松|氛围|低保真/.test(term) ? 0.3 : 0.5; },
  };
})();
