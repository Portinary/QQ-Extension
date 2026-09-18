const mangayomiSources = [{
  "name": "Questionable Questing",
  "lang": "en",
  "baseUrl": "https://forum.questionablequesting.com",
  "apiUrl": "https://forum.questionablequesting.com",
  "iconUrl": "https://forum.questionablequesting.com/favicon.ico",
  "typeSource": "single",
  "itemType": 2,
  "version": "1.3.3",
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

      novels.push({
        'name': this.stripTitlePrefix(linkEl.text.trim()),
        'link': this.normalizeThreadUrl(rawHref),
        'imageUrl': (el.selectFirst('.structItem-cell--icon img') ? this.upgradeAvatar(el.selectFirst('.structItem-cell--icon img').attr('src') || el.selectFirst('.structItem-cell--icon img').attr('data-src')) : ''),
      });
    }

    return { 'list': novels, 'hasNextPage': novels.length >= 20 };
  }

  async runSearch(url) {
    const client = new Client();
    let res = await client.get(url, this.getHeaders(url));

    if (res.statusCode >= 300 && res.statusCode < 400) {
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

      novels.push({
        'name': this.stripTitlePrefix(linkEl.text.trim()),
        'link': this.normalizeThreadUrl(href),
        'imageUrl': (el.selectFirst('.contentRow-figure img') ? this.upgradeAvatar(el.selectFirst('.contentRow-figure img').attr('src') || el.selectFirst('.contentRow-figure img').attr('data-src')) : ''),
      });
    }

    return novels;
  }

  async search(query, page, filters) {
    const term = query.trim();
    const titleUrl = `${SITE}/search/search?keywords=${encodeURIComponent(term)}&t=thread&c[title_only]=1&page=${page}`;
    const titleResults = await this.runSearch(titleUrl);

    let authorResults = [];
    if (page === 1) {
      const authorUrl = `${SITE}/search/search?users=${encodeURIComponent(term)}&user_content=thread`;
      try { authorResults = await this.runSearch(authorUrl); } catch (_e) {}
    }

    const seen = new Set();
    const merged = [];
    for (const n of [...titleResults, ...authorResults]) {
      if (!n.link || seen.has(n.link)) continue;
      seen.add(n.link);
      merged.push(n);
    }

    return { 'list': merged, 'hasNextPage': merged.length >= 20 };
  }

  extractChapters(doc, prefix) {
    const chapters = [];
    const items = doc.select('.structItem--threadmark');

    for (const el of items) {
      const linkEl = el.selectFirst('.structItem-title a');
      if (!linkEl) continue;

      const rawHref = linkEl.attr('href');
      if (!rawHref) continue;

      const href = rawHref.startsWith('http') ? rawHref : SITE + (rawHref.startsWith('/') ? rawHref : '/' + rawHref);
      const rawName = linkEl.text.trim();
      if (!rawName) continue;

      let dateUpload = null;
      const timeEl = el.selectFirst('time');
      if (timeEl) {
        const dataTime = timeEl.attr('data-time');
        if (dataTime && /^\d+$/.test(dataTime)) {
          dateUpload = (parseInt(dataTime, 10) * 1000).toString();
        }
      }

      chapters.push({
        'name': prefix ? `${prefix} - ${rawName}` : rawName,
        'url': href,
        'scanlator': prefix || "",
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
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
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
      .replace(/\?.*$/, '')
      .replace(/\/$/, '');

    const client = new Client();
    const defaultUrl = `${SITE}/threads/${slug}/threadmarks`;
    const res = await client.get(`${defaultUrl}?per_page=${PER_PAGE}`, this.getHeaders(defaultUrl));
    const doc = new Document(res.body);

    const titleEl = doc.selectFirst('.p-title-value');
    let rawTitle = 'Untitled';
    if (titleEl) rawTitle = (titleEl.text || '').trim();
    const title = this.stripTitlePrefix(rawTitle);

    const authorEl = doc.selectFirst('.username');
    const author = authorEl ? (authorEl.text || '').trim() : 'Unknown';

    let description = '';
    const headerDesc = doc.selectFirst('.threadmarkListingHeader-extraInfo .bbWrapper');
    if (headerDesc) {
      description = this.htmlToText(headerDesc.outerHtml || '').slice(0, 500);
    }

    const categories = [];
    const tabs = doc.select('.block-tabHeader--threadmarkCategoryTabs a.tabs-tab');
    for (const el of tabs) {
      const href = el.attr('href');
      if (!href) continue;
      categories.push({ 
        label: (el.text || '').trim(), 
        url: href.startsWith('http') ? href : SITE + href, 
        isMain: !href.includes('threadmark_category=') 
      });
    }

    if (categories.length === 0) {
      categories.push({ label: 'Threadmarks', url: defaultUrl, isMain: true });
    }

    const mainCat = categories.find(c => c.isMain) || categories[0];
    const mainChapters = await this.fetchCategory(mainCat.url, '');

    const extras = [];
    for (const cat of categories) {
      if (cat.isMain) continue;
      extras.push(...(await this.fetchCategory(cat.url, cat.label)));
    }

    return {
      'name': title,
      'link': url,
      'imageUrl': '',
      'description': description,
      'author': author,
      'status': 0,
      'chapters': [...mainChapters.reverse(), ...extras.reverse()],
    };
  }

  async getHtmlContent(name, url) {
    const client = new Client();
    let targetUrl = url.startsWith('http') ? url : SITE + (url.startsWith('/') ? url : '/' + url);

    let res = await client.get(targetUrl, this.getHeaders(targetUrl));

    // Follow redirect if XenForo redirects post permalink to thread page
    let redirectCount = 0;
    while ((res.statusCode >= 300 && res.statusCode < 400) && redirectCount < 3) {
      const location = res.headers && (res.headers['location'] || res.headers['Location']);
      if (!location) break;
      targetUrl = location.startsWith('http') ? location : SITE + location;
      res = await client.get(targetUrl, this.getHeaders(targetUrl));
      redirectCount++;
    }

    const doc = new Document(res.body);

    // Extract post ID from original or redirected URL (e.g., post-12366882)
    const postMatch = url.match(/post-(\d+)/) || targetUrl.match(/post-(\d+)/);
    const postId = postMatch ? postMatch[1] : null;

    let body = null;

    if (postId) {
      const targetArticle = 
        doc.selectFirst(`article#js-post-${postId}`) || 
        doc.selectFirst(`article#post-${postId}`) || 
        doc.selectFirst(`[data-content="post-${postId}"]`) ||
        doc.selectFirst(`article[id*="${postId}"]`);

      if (targetArticle) {
        body = targetArticle.selectFirst('.bbWrapper') || targetArticle.selectFirst('.message-body');
      }
    }

    // Fallbacks if post ID selection isn't reached directly
    if (!body) body = doc.selectFirst('.message-inner .bbWrapper');
    if (!body) body = doc.selectFirst('article.message .bbWrapper');
    if (!body) body = doc.selectFirst('.message-body .bbWrapper');
    if (!body) body = doc.selectFirst('.bbWrapper');

    if (!body) {
      throw new Error("Could not find chapter content");
    }

    return this.cleanHtmlContent(body.outerHtml || '');
  }

  cleanHtmlContent(html) {
    if (!html) return "";

    let cleaned = html
      .replace(/<(script|noscript|iframe|video|audio|object|embed)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/\sclass=["'][^"']*["']/g, "")
      .replace(/\sid=["'][^"']*["']/g, "");

    return this.fixImages(cleaned);
  }

  fixImages(html) {
    return html.replace(/<img([^>]*?)>/gi, (match, attrs) => {
      const dataSrcMatch = attrs.match(/data-src=["']([^"']+)["']/i);
      const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);

      let realSrc = '';
      if (dataSrcMatch && !dataSrcMatch[1].startsWith('data:')) realSrc = dataSrcMatch[1];
      else if (srcMatch && !srcMatch[1].startsWith('data:')) realSrc = srcMatch[1];

      if (!realSrc) return match;

      let absolute = realSrc.trim();
      if (!absolute.startsWith('http://') && !absolute.startsWith('https://')) {
        if (!absolute.startsWith('/')) absolute = '/' + absolute;
        absolute = SITE + absolute;
      }

      return `<img src="${absolute}" style="max-width:100%; height:auto;" />`;
    });
  }

  get supportsLatest() {
    return false;
  }

  async getLatestUpdates(page) {
    return await this.getPopular(page);
  }

  async getVideoList(url) {
    throw new Error("getVideoList not implemented");
  }

  async getPageList(url) {
    throw new Error("getPageList not implemented");
  }

  getFilterList() {
    return [];
  }

  getSourcePreferences() {
    return [];
  }
}
