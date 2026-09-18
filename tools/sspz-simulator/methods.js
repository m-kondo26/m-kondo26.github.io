(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  const language = query.get('lang') === 'en' ? 'en' : 'ja';
  const content = globalThis.SSPZ_METHODS;
  const topic = Object.hasOwn(content.topics, query.get('topic')) ? query.get('topic') : 'aperture';
  const copy = language === 'en' ? {
    back: '← SSPz simulator', label: 'CT geometry and SSPz — Calculation methods',
    skip: 'Skip to content', nav: 'Calculation guides', other: '日本語',
    version: 'Explanation pages updated 2026-09-18 · Web build 2026-09-18.17',
    description: 'Detector aperture, axial interpolation, focal blur and calculation methods for the CT geometry and SSPz simulator.'
  } : {
    back: '← SSPzシミュレーション', label: 'CT展開図・SSPz — 計算方法',
    skip: '本文へ', nav: '計算方法の説明', other: 'English',
    version: '説明ページ更新：2026-09-18 · Web build 2026-09-18.17',
    description: 'CT展開図・SSPzシミュレーションの開口幅、補間、焦点ボケと計算方法の説明。'
  };
  const href = (key, lang = language) => `methods.html?topic=${key}${lang === 'en' ? '&lang=en' : ''}`;
  const $ = id => document.getElementById(id);
  document.documentElement.lang = language;
  const page = content.topics[topic][language];
  document.title = `${page.title} | CT ${language === 'en' ? 'geometry and SSPz' : '展開図・SSPz'}`;
  document.querySelector('meta[name="description"]').content = copy.description;
  $('guide-title').textContent = page.title;
  $('guide-label').textContent = copy.label;
  $('skip-link').textContent = copy.skip;
  $('guide-version').textContent = copy.version;
  for (const id of ['back-link', 'footer-back']) {
    $(id).textContent = copy.back;
    $(id).href = language === 'en' ? 'index-en.html' : 'index.html';
  }
  const other = language === 'en' ? 'ja' : 'en';
  $('language-link').textContent = copy.other;
  $('language-link').lang = other;
  $('language-link').href = href(topic, other);
  $('topic-nav').setAttribute('aria-label', copy.nav);
  for (const [key, translations] of Object.entries(content.topics)) {
    const link = document.createElement('a');
    link.textContent = translations[language].label;
    link.href = href(key);
    if (key === topic) link.setAttribute('aria-current', 'page');
    $('topic-nav').append(link);
  }
  // The HTML comes exclusively from versioned, local authoring fragments.
  $('method-content').innerHTML = page.html;
  // Keep related guides in the entry language, including future content links.
  for (const link of $('method-content').querySelectorAll('a[href]')) {
    const url = new URL(link.getAttribute('href'), location.href);
    if (url.pathname.endsWith('/methods.html') && url.origin === location.origin) {
      if (language === 'en') url.searchParams.set('lang', 'en');
      else url.searchParams.delete('lang');
      link.href = url.href;
    }
  }
  // Tables stay readable on narrow screens without widening the whole page.
  for (const table of $('method-content').querySelectorAll('table')) {
    if (!table.parentElement.classList.contains('table-scroll')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'table-scroll';
      table.before(wrapper);
      wrapper.append(table);
    }
  }
})();
