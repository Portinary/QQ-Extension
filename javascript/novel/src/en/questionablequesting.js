const mangayomiSources = [{
  "name": "Questionable Questing",
  "lang": "en",
  "baseUrl": "https://forum.questionablequesting.com",
  "apiUrl": "https://forum.questionablequesting.com",
  "iconUrl": "https://forum.questionablequesting.com/favicon.ico",
  "typeSource": "single",
  "isManga": false,
  "itemType": 2,
  "version": "1.0.5",
  "dateFormat": "",
  "dateFormatLocale": "",
  "isNsfw": true,
  "pkgName": "questionablequesting"
}];

const SITE = 'https://forum.questionablequesting.com';
const NSFW_CREATIVE_WRITING_ID = 29;
const PER_PAGE = 200;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
};

class DefaultExtension extends MProvider {
  upgradeAvatar(src) {
    if (!src) return '';
    const upgraded = src.replace(/\/avatars\/[sm]\//, '/avatars/l/');
    return upgraded.startsWith('http') ? upgraded : SITE + upgraded;
  }

  stripTitlePrefix(title) {
    return title.replace(/^\[(NSFW|Quest|CYOA)\]\s*/i, '').trim();
  }

  normalizeThreadUrl(href) {
    if (!href) return href;
    let h = href;
    h = h.replace(/\/unread(\/|\?|$).*$/, '/');
    h = h.replace(/\/latest(\/|\?|$).*$/, '/');
    h = h.replace(/\/post-\d+.*$/, '/');
    h = h.replace(/\?.*$/, '');
    if (!h.endsWith('/')) h += '/';
    return h;
  }

  async getPopular(page) {
    const safePage = page > 1 ? page : 1;
    const baseUrl = `${SITE}/forums/nsfw-creative-writing.${NSFW_CREATIVE_WRITING_ID}`;
    const url = safePage === 1 ? `${baseUrl}/` : `${baseUrl}/page-${safePage}`;

    const client = new Client();
    const res = await client.get(url, HEADERS);
    const doc = parseHtml(res.body);

    const novels = [];
    const threads = doc.select('.structItem--thread');
    for (const el of threads) {
      if (el.select('.structItem-status--sticky').length > 0) continue;

      const linkEls = el.select('.structItem-title a');
      if (linkEls.length === 0) continue;
      const linkEl = linkEls[linkEls.length - 1];

      const rawHref = linkEl.attr('href');
      if (!rawHref) continue;

      const href = this.normalizeThreadUrl(rawHref);

      const avatarImg = el.select('.structItem-cell--icon img')[0];
      const src = avatarImg
        ? (avatarImg.attr('src') || avatarImg.attr('data-src'))
        : '';

      novels.push({
        name: this.stripTitlePrefix(linkEl.text.trim()),
        url: href,
        imageUrl: src ? this.upgradeAvatar(src) : '',
      });
    }

    return { list: novels, hasNextPage: novels.length >= 20 };
  }

  async runSearch(url) {
    const client = new Client();
    const res = await client.get(url, HEADERS);
    const doc = parseHtml(res.body);

    const novels = [];
    const rows = doc.select('.contentRow');
    for (const el of rows) {
      const linkEl = el.select('.contentRow-title a')[0];
      if (!linkEl) continue;
      const href = linkEl.attr('href');
      if (!href) continue;

      const avatarImg = el.select('.contentRow-figure img')[0];
      const src = avatarImg
        ? (avatarImg.attr('src') || avatarImg.attr('data-src'))
        : '';

      novels.push({
        name: this.stripTitlePrefix(linkEl.text.trim()),
        url: this.normalizeThreadUrl(href),
        imageUrl: src ? this.upgradeAvatar(src) : '',
      });
    }

    return novels;
  }

  async search(query, page, filters) {
    const term = query.trim();
    const titleUrl =
      `${SITE}/search/search?keywords=${encodeURIComponent(term)}` +
      `&t=thread&c[title_only]=1&page=${page}`;
    const titleResults = await this.runSearch(titleUrl);

    const isSingleWord = !term.includes(' ') && term.length > 0;
    if (!isSingleWord || page !== 1) {
      return { list: titleResults, hasNextPage: titleResults.length >= 20 };
    }

    const authorUrl =
      `${SITE}/search/search?users=${encodeURIComponent(term)}` +
      `&user_content=thread`;
    let authorResults = [];
    try {
      authorResults = await this.runSearch(authorUrl);
    } catch (_e) {
      authorResults = [];
    }

    const seen = new Set();
    const merged = [];

    for (const n of [...titleResults, ...authorResults]) {
      if (!n.url || seen.has(n.url)) continue;
      seen.add(n.url);
      merged.push(n);
    }

    return { list: merged, hasNextPage: merged.length >= 20 };
  }

  extractChapters(doc, prefix) {
    const chapters = [];

    const items = doc.select('.structItemContainer .structItem--threadmark');
    for (const el of items) {
      const classAttr = el.attr('class') || '';
      if (classAttr.includes('structItem--threadmark-filler')) continue;

      const linkEl = el.select('.structItem-title a')[0];
      if (!linkEl) continue;
      const href = linkEl.attr('href');
      if (!href) continue;

      const rawName = linkEl.text.trim();
      const name = prefix ? `${prefix} - ${rawName}` : rawName;

      let dateUpload = null;
      const timeEl = el.select('time.structItem-latestDate')[0];

      if (timeEl) {
        const dataTime = timeEl.attr('data-time');
        if (dataTime && /^\d+$/.test(dataTime)) {
          dateUpload = (parseInt(dataTime, 10) * 1000).toString();
        } else {
          const dateStr = timeEl.attr('data-date-string');
          if (dateStr) {
            const parts = dateStr.split('/');
            if (parts.length === 3) {
              const d = parseInt(parts[0], 10);
              const m = parseInt(parts[1], 10);
              const y = parseInt(parts[2], 10);
              if (!isNaN(d) && !isNaN(m) && !isNaN(y)) {
                dateUpload = new Date(y, m - 1, d).getTime().toString();
              }
            }
          }
        }
      }

      const chapter = { name, url: href };
      if (dateUpload) chapter.dateUpload = dateUpload;
      chapters.push(chapter);
    }

    return chapters;
  }

  countChaptersAndPages(doc) {
    let count = 0;
    const statsList = doc.select('.threadmarkListingHeader-stats dl.pairs');
    for (const el of statsList) {
      const dt = el.select('dt')[0];
      if (dt && dt.text.trim() === 'Threadmarks') {
        const dd = el.select('dd')[0];
        if (dd) count = parseInt(dd.text.replace(/,/g, '') || '0', 10);
      }
    }
    return { count, pages: count > 0 ? Math.ceil(count / PER_PAGE) : 1 };
  }

  async fetchCategory(baseUrl, prefix) {
    const client = new Client();
    const firstUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}per_page=${PER_PAGE}`;
    const resFirst = await client.get(firstUrl, HEADERS);
    const docFirst = parseHtml(resFirst.body);

    const { pages } = this.countChaptersAndPages(docFirst);
    let chapters = this.extractChapters(docFirst, prefix);

    for (let p = 2; p <= pages; p++) {
      const pageUrl = `${firstUrl}&page=${p}`;
      const resP = await client.get(pageUrl, HEADERS);
      const docP = parseHtml(resP.body);
      chapters = chapters.concat(this.extractChapters(docP, prefix));
    }

    return chapters;
  }

  htmlToText(html) {
    return html
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async getDetail(url) {
    const slug = url
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/?threads\//, '')
      .replace(/\/threadmarks.*$/, '')
      .replace(/\/post-\d+.*$/, '')
      .replace(/\/unread.*$/, '')
      .replace(/\/latest.*$/, '')
      .replace(/\?.*$/, '')
      .replace(/\/$/, '');

    const client = new Client();
    const defaultUrl = `${SITE}/threads/${slug}/threadmarks`;
    const res = await client.get(`${defaultUrl}?per_page=${PER_PAGE}`, HEADERS);
    const doc = parseHtml(res.body);

    const titleEl = doc.selectFirst('.p-title-value');
    let rawTitle = 'Untitled';
    if (titleEl) {
      const removeEls = titleEl.select('.unreadLink, .labelLink, .label, .label-append');
      for (const e of removeEls) {
        e.remove();
      }
      rawTitle = titleEl.text.trim();
    }
    if (!rawTitle) {
      const ogTitle = doc.selectFirst('meta[property="og:title"]');
      if (ogTitle) rawTitle = ogTitle.attr('content') || 'Untitled';
    }
    const title = this.stripTitlePrefix(rawTitle);

    const authorEl = doc.selectFirst('.username');
    const author = authorEl ? authorEl.text.trim() : 'Unknown';

    let description = '';
    const headerDesc = doc.selectFirst('.threadmarkListingHeader-extraInfo .bbWrapper');
    if (headerDesc) {
      description = this.htmlToText(headerDesc.outerHtml || '').slice(0, 500);
    }

    let imageUrl = '';
    const threadMainUrl = `${SITE}/threads/${slug}/`;
    try {
      const resThread = await client.get(threadMainUrl, HEADERS);
      const docThread = parseHtml(resThread.body);
      const avatarImg = docThread.selectFirst('img[class^="avatar-u"]');
      if (avatarImg) {
        const src = avatarImg.attr('src') || avatarImg.attr('data-src');
        if (src) imageUrl = this.upgradeAvatar(src);
      }
    } catch (_e) {}

    const categories = [];
    const tabs = doc.select('.block-tabHeader--threadmarkCategoryTabs a.tabs-tab');
    for (const el of tabs) {
      const href = el.attr('href');
      const label = el.text.trim();
      if (!href) continue;

      const fullUrl = href.startsWith('http') ? href : SITE + href;
      const isMain = !href.includes('threadmark_category=');

      categories.push({ label, url: fullUrl, isMain });
    }

    if (categories.length === 0) {
      categories.push({ label: 'Threadmarks', url: defaultUrl, isMain: true });
    }

    const mainCat = categories.find(c => c.isMain) || categories[0];
    const mainChapters = await this.fetchCategory(mainCat.url, '');

    const extras = [];
    for (const cat of categories) {
      if (cat.isMain) continue;
      const catChapters = await this.fetchCategory(cat.url, cat.label);
      extras.push(...catChapters);
    }

    return {
      name: title,
      imageUrl,
      description,
      author,
      status: 0,
      chapters: [...mainChapters, ...extras],
    };
  }

  async getPageList(url) {
    return [url];
  }

  getFilterList() {
    return [];
  }
}
