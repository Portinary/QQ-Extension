const mangayomiSources = [{
  "name": "Questionable Questing",
  "lang": "en",
  "baseUrl": "https://forum.questionablequesting.com",
  "apiUrl": "https://forum.questionablequesting.com",
  "iconUrl": "https://forum.questionablequesting.com/favicon.ico",
  "typeSource": "single",
  "itemType": 2,
  "version": "1.3.0",
  "pkgPath": "",
  "notes": ""
}];

const SITE = 'https://forum.questionablequesting.com';
const NSFW_CREATIVE_WRITING_ID = 29;
const PER_PAGE = 200;

class DefaultExtension extends MProvider {
  getHeaders(url) {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Referer': SITE
    };
  }

  upgradeAvatar(src) {
    if (!src) return '';
    const upgraded = src.replace(/\/avatars\/[sm]\//, '/avatars/l/');
    return upgraded.startsWith('http') ? upgraded : SITE + upgraded;
  }

  stripTitlePrefix(title) {
    if (!title) return '';
    return title
      .replace(/^(?:\[\s*(?:NSFW\vert{}Quest\vert{}CYOA\vert{}SFW)\s*\]|\b(?:NSFW|Quest|CYOA|SFW)\b)\s*/i, '')
      .trim();
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

  normalizeChapterUrl(href) {
    if (!href) return href;

    if (!href.startsWith('http')) {
      return SITE + (href.startsWith('/') ? href : '/' + href);
    }
    return href;
  }

  async getPopular(page) {
    const safePage = page > 1 ? page : 1;
    const baseUrl = `${SITE}/forums/nsfw-creative-writing.${NSFW_CREATIVE_WRITING_ID}`;
    const url = safePage === 1 ? `${baseUrl}/` : `${baseUrl}/page-${safePage}`;

    const client = new Client();
    const res = await client.get(url, this.getHeaders(url));
    const doc = new Document(res.body);

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

      const avatarImg = el.selectFirst('.structItem-cell--icon img');
      const src = avatarImg
        ? (avatarImg.attr('src') || avatarImg.attr('data-src'))
        : '';

      novels.push({
        name: this.stripTitlePrefix(linkEl.text.trim()),
        link: href,
        imageUrl: src ? this.upgradeAvatar(src) : '',
      });
    }

    return { list: novels, hasNextPage: novels.length >= 20 };
  }

  async runSearch(url) {
    const client = new Client();
    let res = await client.get(url, this.getHeaders(url));

    if (res.statusCode === 303 || res.statusCode === 302 || res.statusCode === 301) {
      const location = res.headers && (res.headers['location'] || res.headers['Location']);
      if (location) {
        const absoluteLocation = location.startsWith('http') ? location : SITE + location;
        res = await client.get(absoluteLocation, this.getHeaders(absoluteLocation));
      }
    }

    const doc = new Document(res.body);

    const novels = [];
    const rows = doc.select('.contentRow');
    for (const el of rows) {
      const linkEl = el.selectFirst('.contentRow-title a');
      if (!linkEl) continue;
      const href = linkEl.attr('href');
      if (!href) continue;

      const avatarImg = el.selectFirst('.contentRow-figure img');
      const src = avatarImg
        ? (avatarImg.attr('src') || avatarImg.attr('data-src'))
        : '';

      novels.push({
        name: this.stripTitlePrefix(linkEl.text.trim()),
        link: this.normalizeThreadUrl(href),
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

    let authorResults = [];
    if (page === 1) {
      const authorUrl =
        `${SITE}/search/search?users=${encodeURIComponent(term)}` +
        `&user_content=thread`;
      try {
        authorResults = await this.runSearch(authorUrl);
      } catch (_e) {
        authorResults = [];
      }
    }

    const seen = new Set();
    const merged = [];

    for (const n of [...titleResults, ...authorResults]) {
      if (!n.link || seen.has(n.link)) continue;
      seen.add(n.link);
      merged.push(n);
    }

    return { list: merged, hasNextPage: merged.length >= 20 };
  }

  extractChapters(doc, prefix) {
    const chapters = [];
    const items = doc.select('.structItem--threadmark, .threadmarkItem, .structItemContainer .structItem');

    for (const el of items) {
      const classAttr = el.attr('class') || '';
      if (classAttr.includes('structItem--threadmark-filler')) continue;

      const linkEl = el.selectFirst('.structItem-title a, .threadmark-title a, a[href*="/threads/"], a[href*="/posts/"]');
      if (!linkEl) continue;

      const rawHref = linkEl.attr('href');
      if (!rawHref) continue;

      const href = this.normalizeChapterUrl(rawHref);
      const rawName = linkEl.text.trim();
      if (!rawName) continue;

      const name = prefix ? `${prefix} - ${rawName}` : rawName;

      let dateUpload = null;
      const timeEl = el.selectFirst('time');
      if (timeEl) {
        const dataTime = timeEl.attr('data-time');
        if (dataTime && /^\d+$/.test(dataTime)) {
          dateUpload = (parseInt(dataTime, 10) * 1000).toString();
        }
      }

      chapters.push({
        name,
        url: href,
        ...(dateUpload && { dateUpload })
      });
    }

    return chapters;
  }

  countChaptersAndPages(doc) {
    let count = 0;
    const statsList = doc.select('.threadmarkListingHeader-stats dl.pairs');
    for (const el of statsList) {
      const dt = el.selectFirst('dt');
      if (dt && dt.text.trim() === 'Threadmarks') {
        const dd = el.selectFirst('dd');
        if (dd) count = parseInt(dd.text.replace(/,/g, '') || '0', 10);
      }
    }
    return { count, pages: count > 0 ? Math.ceil(count / PER_PAGE) : 1 };
  }

  async fetchCategory(baseUrl, prefix) {
    const client = new Client();
    const firstUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}per_page=${PER_PAGE}`;
    const resFirst = await client.get(firstUrl, this.getHeaders(firstUrl));
    const docFirst = new Document(resFirst.body);

    const { pages } = this.countChaptersAndPages(docFirst);
    let chapters = this.extractChapters(docFirst, prefix);

    for (let p = 2; p <= pages; p++) {
      const pageUrl = `${firstUrl}&page=${p}`;
      const resP = await client.get(pageUrl, this.getHeaders(pageUrl));
      const docP = new Document(resP.body);
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
    const res = await client.get(`${defaultUrl}?per_page=${PER_PAGE}`, this.getHeaders(defaultUrl));
    const doc = new Document(res.body);

    const titleEl = doc.selectFirst('.p-title-value');
    let rawTitle = 'Untitled';
    if (titleEl) {
      let titleHtml = titleEl.outerHtml || titleEl.text || '';
      titleHtml = titleHtml.replace(/<span class="unreadLink[^>]*>.*?<\/span>/gi, '');
      titleHtml = titleHtml.replace(/<span class="labelLink[^>]*>.*?<\/span>/gi, '');
      titleHtml = titleHtml.replace(/<span class="label[^>]*>.*?<\/span>/gi, '');
      titleHtml = titleHtml.replace(/<span class="label-append[^>]*>.*?<\/span>/gi, '');

      const tempDoc = new Document(titleHtml);
      rawTitle = (tempDoc.text || '').trim() || (titleEl.text || '').trim();
    }
    if (!rawTitle || rawTitle === 'Untitled') {
      const ogTitle = doc.selectFirst('meta[property="og:title"]');
      if (ogTitle) rawTitle = ogTitle.attr('content') || 'Untitled';
    }
    const title = this.stripTitlePrefix(rawTitle);

    const authorEl = doc.selectFirst('.username');
    const author = authorEl ? (authorEl.text || '').trim() : 'Unknown';

    let description = '';
    const headerDesc = doc.selectFirst('.threadmarkListingHeader-extraInfo .bbWrapper');
    if (headerDesc) {
      description = this.htmlToText(headerDesc.outerHtml || '').slice(0, 500);
    }

    let imageUrl = '';
    const threadMainUrl = `${SITE}/threads/${slug}/`;
    try {
      const resThread = await client.get(threadMainUrl, this.getHeaders(threadMainUrl));
      const docThread = new Document(resThread.body);
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
      const label = (el.text || '').trim();
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

    const sortByDate = (a, b) => {
      const da = a.dateUpload ? parseInt(a.dateUpload, 10) : 0;
      const db = b.dateUpload ? parseInt(b.dateUpload, 10) : 0;
      return da - db;
    };

    const sortedMain = mainChapters
      .map((ch, i) => ({ ch, i }))
      .sort((a, b) => sortByDate(a.ch, b.ch) || a.i - b.i)
      .map(x => x.ch);

    const sortedExtras = extras
      .map((ch, i) => ({ ch, i }))
      .sort((a, b) => sortByDate(a.ch, b.ch) || a.i - b.i)
      .map(x => x.ch);

    const allChapters = [...sortedMain.reverse(), ...sortedExtras.reverse()];

    return {
      name: title,
      link: url,
      imageUrl,
      description,
      author,
      status: 0,
      chapters: allChapters,
    };
  }

  async getPageList(url) {
    const absoluteUrl = this.normalizeChapterUrl(url);
    return [{ url: absoluteUrl }];
  }

  async getHtmlContent(name, url) {
    const absoluteUrl = this.normalizeChapterUrl(url);
    const client = new Client();

    // 1. Resolve redirect chain manually up to 3 deep
    let currentUrl = absoluteUrl;
    let res = await client.get(currentUrl, this.getHeaders(currentUrl));
    
    let redirectCount = 0;
    while ((res.statusCode >= 300 && res.statusCode < 400) && redirectCount < 3) {
      const location = res.headers && (res.headers['location'] || res.headers['Location']);
      if (!location) break;
      currentUrl = location.startsWith('http') ? location : SITE + location;
      res = await client.get(currentUrl, this.getHeaders(currentUrl));
      redirectCount++;
    }

    const doc = new Document(res.body);

    // 2. Extract Post ID from URL or anchor fragment
    let postId = null;
    const postMatch = absoluteUrl.match(/(?:post-|\/posts\/|#post-)(\d+)/) || currentUrl.match(/(?:post-|\/posts\/|#post-)(\d+)/);
    if (postMatch) {
      postId = postMatch[1];
    }

    let body = null;

    // 3. Robust XenForo post target checking
    if (postId) {
      const targetArticle = 
        doc.selectFirst(`#post-${postId}`) || 
        doc.selectFirst(`#js-post-${postId}`) || 
        doc.selectFirst(`[data-content="post-${postId}"]`) ||
        doc.selectFirst(`article[data-author][id*="${postId}"]`);

      if (targetArticle) {
        body = targetArticle.selectFirst('.bbWrapper') || targetArticle.selectFirst('.message-body');
      }
    }

    // 4. Fallback selectors
    if (!body) body = doc.selectFirst('.message--post .bbWrapper');
    if (!body) body = doc.selectFirst('.message-body .bbWrapper');
    if (!body) body = doc.selectFirst('.bbWrapper');

    if (!body) {
      return '<html><body><p>Chapter content not found.</p></body></html>';
    }

    const cleanedHtml = await this.cleanHtmlContent(body.outerHtml || '');
    return `<html><body>${cleanedHtml}</body></html>`;
  }

  async cleanHtmlContent(html) {
    if (!html) return '<p>Chapter content not found.</p>';
    
    let cleaned = html;

    // Remove script and iframe elements
    cleaned = cleaned.replace(/<(script|noscript|iframe|video|audio|object|embed)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, '');

    // Transform XenForo spoilers safely without recursive loop bugs
    cleaned = cleaned.replace(/<div[^>]*class="[^"]*bbCodeSpoiler[^"]*"[^>]*>[\s\S]*?<button[^>]*>([\s\S]*?)<\/button>[\s\S]*?<div[^>]*class="[^"]*bbCodeSpoiler-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi, (match, button, content) => {
      const title = button.replace(/<[^>]+>/g, '').trim() || 'Spoiler';
      return `<div style="margin: 10px 0; padding: 8px; border: 1px solid #ccc; background: #f9f9f9;"><p><strong>[${title}]</strong></p>${content}</div>`;
    });

    // Fix images
    cleaned = this.fixImages(cleaned);

    return cleaned;
  }

  fixImages(html) {
    return html.replace(/<img([^>]*?)>/gi, (match, attrs) => {
      const dataSrcMatch = attrs.match(/data-src=["']([^"']+)["']/i);
      const dataUrlMatch = attrs.match(/data-url=["']([^"']+)["']/i);
      const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);

      let realSrc = '';
      if (dataSrcMatch && !dataSrcMatch[1].startsWith('data:')) realSrc = dataSrcMatch[1];
      else if (dataUrlMatch && !dataUrlMatch[1].startsWith('data:')) realSrc = dataUrlMatch[1];
      else if (srcMatch && !srcMatch[1].startsWith('data:')) realSrc = srcMatch[1];

      if (!realSrc) return match;

      let absolute = realSrc.trim();
      if (!absolute.startsWith('http://') && !absolute.startsWith('https://')) {
        if (!absolute.startsWith('/')) absolute = '/' + absolute;
        absolute = SITE + absolute;
      }

      return `<img src="${absolute}" style="max-width:100%; height:auto; display:block; margin: 10px auto;" />`;
    });
  }

  async getVideoList(url) {
    return [];
  }

  getFilterList() {
    return [];
  }

  getSourcePreferences() {
    return [];
  }
}
