const mangayomiSources = [{
  "name": "Questionable Questing",
  "lang": "en",
  "baseUrl": "https://forum.questionablequesting.com",
  "apiUrl": "https://forum.questionablequesting.com",
  "iconUrl": "https://forum.questionablequesting.com/favicon.ico",
  "typeSource": "single",
  "isManga": false,
  "itemType": 0,
  "version": "1.0.1",
  "dateFormat": "",
  "dateFormatLocale": "",
  "isNsfw": true,
  "pkgName": "questionablequesting"
}];

const SITE = 'https://forum.questionablequesting.com';
const NSFW_CREATIVE_WRITING_ID = 29;
const PER_PAGE = 200;

class DefaultExtension extends MProvider {
  getHeaders(url) {
    return {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    };
  }

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
    const res = await client.get(url, this.getHeaders(url));
    const doc = new Document(res.body);

    const novels = [];
    doc.querySelectorAll('.structItem--thread').forEach((el) => {
      if (el.querySelectorAll('.structItem-status--sticky').length > 0) return;

      const linkEls = el.querySelectorAll('.structItem-title a');
      if (linkEls.length === 0) return;
      const linkEl = linkEls[linkEls.length - 1];

      const rawHref = linkEl.getAttribute('href');
      if (!rawHref) return;

      const href = this.normalizeThreadUrl(rawHref);

      const avatarImg = el.querySelectorAll('.structItem-cell--icon img')[0];
      const src = avatarImg
        ? (avatarImg.getAttribute('src') || avatarImg.getAttribute('data-src'))
        : '';

      novels.push({
        name: this.stripTitlePrefix(linkEl.text.trim()),
        url: href,
        imageUrl: src ? this.upgradeAvatar(src) : '',
      });
    });

    return { list: novels, hasNextPage: novels.length >= 20 };
  }

  async runSearch(url) {
    const client = new Client();
    const res = await client.get(url, this.getHeaders(url));
    const doc = new Document(res.body);

    const novels = [];
    doc.querySelectorAll('.contentRow').forEach((el) => {
      const linkEl = el.querySelectorAll('.contentRow-title a')[0];
      if (!linkEl) return;
      const href = linkEl.getAttribute('href');
      if (!href) return;

      const avatarImg = el.querySelectorAll('.contentRow-figure img')[0];
      const src = avatarImg
        ? (avatarImg.getAttribute('src') || avatarImg.getAttribute('data-src'))
        : '';

      novels.push({
        name: this.stripTitlePrefix(linkEl.text.trim()),
        url: this.normalizeThreadUrl(href),
        imageUrl: src ? this.upgradeAvatar(src) : '',
      });
    });

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

    doc.querySelectorAll('.structItemContainer .structItem--threadmark').forEach((el) => {
      if (el.classList.contains('structItem--threadmark-filler')) return;

      const linkEl = el.querySelectorAll('.structItem-title a')[0];
      if (!linkEl) return;
      const href = linkEl.getAttribute('href');
      if (!href) return;

      const rawName = linkEl.text.trim();
      const name = prefix ? `${prefix} - ${rawName}` : rawName;

      let dateUpload = null;
      const timeEl = el.querySelectorAll('time.structItem-latestDate')[0];

      if (timeEl) {
        const dataTime = timeEl.getAttribute('data-time');
        if (dataTime && /^\d+$/.test(dataTime)) {
          dateUpload = (parseInt(dataTime, 10) * 1000).toString();
        } else {
          const dateStr = timeEl.getAttribute('data-date-string');
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
    });

    return chapters;
  }

  countChaptersAndPages(doc) {
    let count = 0;
    const statsList = doc.querySelectorAll('.threadmarkListingHeader-stats dl.pairs');
    statsList.forEach((el) => {
      const dt = el.querySelectorAll('dt')[0];
      if (dt && dt.text.trim() === 'Threadmarks') {
        const dd = el.querySelectorAll('dd')[0];
        if (dd) count = parseInt(dd.text.replace(/,/g, '') || '0', 10);
      }
    });
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

    const titleEl = doc.querySelectorAll('.p-title-value')[0];
    let rawTitle = 'Untitled';
    if (titleEl) {
      titleEl.querySelectorAll('.unreadLink, .labelLink, .label, .label-append').forEach((e) => e.remove());
      rawTitle = titleEl.text.trim();
    }
    if (!rawTitle) {
      const ogTitle = doc.querySelectorAll('meta[property="og:title"]')[0];
      if (ogTitle) rawTitle = ogTitle.getAttribute('content') || 'Untitled';
    }
    const title = this.stripTitlePrefix(rawTitle);

    const authorEl = doc.querySelectorAll('.username')[0];
    const author = authorEl ? authorEl.text.trim() : 'Unknown';

    let description = '';
    const headerDesc = doc.querySelectorAll('.threadmarkListingHeader-extraInfo .bbWrapper')[0];
    if (headerDesc) {
      description = this.htmlToText(headerDesc.innerHTML || '').slice(0, 500);
    }

    let imageUrl = '';
    const threadMainUrl = `${SITE}/threads/${slug}/`;
    try {
      const resThread = await client.get(threadMainUrl, this.getHeaders(threadMainUrl));
      const docThread = new Document(resThread.body);
      const avatarImg = docThread.querySelectorAll('img[class^="avatar-u"]')[0];
      if (avatarImg) {
        const src = avatarImg.getAttribute('src') || avatarImg.getAttribute('data-src');
        if (src) imageUrl = this.upgradeAvatar(src);
      }
    } catch (_e) {}

    const categories = [];
    doc.querySelectorAll('.block-tabHeader--threadmarkCategoryTabs a.tabs-tab').forEach((el) => {
      const href = el.getAttribute('href');
      const label = el.text.trim();
      if (!href) return;

      const fullUrl = href.startsWith('http') ? href : SITE + href;
      const isMain = !href.includes('threadmark_category=');

      categories.push({ label, url: fullUrl, isMain });
    });

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
    const client = new Client();
    const res = await client.get(url, this.getHeaders(url));
    const doc = new Document(res.body);

    const postMatch = url.match(/post-(\d+)/);
    const postId = postMatch ? postMatch[1] : null;

    let post = postId ? doc.querySelectorAll(`#js-post-${postId}`)[0] : null;
    if (!post) post = doc.querySelectorAll('.message-body')[0];

    let body = post ? post.querySelectorAll('.bbWrapper')[0] : null;
    if (!body) body = doc.querySelectorAll('.bbWrapper')[0];

    if (!body) {
      return ['<p>Chapter content not found.</p>'];
    }

    body.querySelectorAll('script, noscript, iframe, video, audio, embed, object').forEach((e) => e.remove());

    body.querySelectorAll('img').forEach((img) => {
      const realSrc = img.getAttribute('data-src') || img.getAttribute('data-url') || img.getAttribute('src');
      if (realSrc) {
        const absolute = realSrc.startsWith('http')
          ? realSrc
          : realSrc.startsWith('/')
            ? SITE + realSrc
            : SITE + '/' + realSrc;
        img.setAttribute('src', absolute);
        img.removeAttribute('data-src');
        img.removeAttribute('data-url');
        img.classList.remove('lazyload');
      }
    });

    body.querySelectorAll('.bbCodeSpoiler').forEach((spoiler) => {
      const button = spoiler.querySelectorAll('.bbCodeSpoiler-button')[0];
      const label = button ? button.text.trim().replace(/^Spoiler:\s*/i, '') : '';
      const content = spoiler.querySelectorAll('.bbCodeSpoiler-content')[0];

      if (!content) {
        spoiler.remove();
        return;
      }

      content.querySelectorAll('script, noscript, iframe, video, audio, embed, object').forEach((e) => e.remove());

      const heading = label
        ? `<p><strong>[Spoiler: ${label}]</strong></p>`
        : `<p><strong>[Spoiler]</strong></p>`;

      spoiler.outerHTML = heading + content.innerHTML;
    });

    body.querySelectorAll('.bbCodeBlock-expandLink, .bbCodeBlock-shrinkLink').forEach((e) => e.remove());
    body.querySelectorAll('button').forEach((e) => e.remove());

    body.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (src && src.startsWith('/')) img.setAttribute('src', SITE + src);
    });

    return [body.innerHTML || '<p>Chapter content not found.</p>'];
  }

  getFilterList() {
    return [];
  }
}
