const mangayomiSources = [{
  "name": "Questionable Questing",
  "lang": "en",
  "baseUrl": "https://forum.questionablequesting.com",
  "apiUrl": "https://forum.questionablequesting.com",
  "iconUrl": "https://forum.questionablequesting.com/favicon.ico",
  "typeSource": "single",
  "itemType": 2,
  "version": "1.2.1",
  "pkgPath": "",
  "notes": ""
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
    const res = await client.get(url, this.getHeaders(url));
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

    // keywords= is the legacy XenForo parameter that returns results.
    // Node constraints narrow to NSFW Creative Writing forum.
    // Title-only filter removed for testing.
    const searchUrl =
      `${SITE}/search/search?keywords=${encodeURIComponent(term)}` +
      `&t=post&c[child_nodes]=1` +
      `&c[nodes][0]=${NSFW_CREATIVE_WRITING_ID}` +
      `&o=date&page=${page}`;

    const results = await this.runSearch(searchUrl);
    return { list: results, hasNextPage: results.length >= 20 };
  }

  extractChapters(doc, prefix) {
    const chapters = [];

    const items = doc.select('.structItemContainer .structItem--threadmark');
    for (const el of items) {
      const classAttr = el.attr('class') || '';
      if (classAttr.includes('structItem--threadmark-filler')) continue;

      const linkEl = el.selectFirst('.structItem-title a');
      if (!linkEl) continue;
      const href = linkEl.attr('href');
      if (!href) continue;

      const rawName = linkEl.text.trim();
      const name = prefix ? `${prefix} - ${rawName}` : rawName;

      let dateUpload = null;
      const timeEl = el.selectFirst('time.structItem-latestDate');

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

    // Sort chapters by dateUpload, with stable ordering for ties.
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

    // Reverse both so the newest is first (Mangayomi reader convention).
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

  async getHtmlContent(name, url) {
    const client = new Client();
    const res = await client.get(url, this.getHeaders(url));
    const doc = new Document(res.body);

    const postMatch = url.match(/post-(\d+)/);
    const postId = postMatch ? postMatch[1] : null;

    let post = postId ? doc.selectFirst(`#js-post-${postId}`) : null;
    if (!post) post = doc.selectFirst('.message-body');

    let body = post ? post.selectFirst('.bbWrapper') : null;
    if (!body) body = doc.selectFirst('.bbWrapper');

    if (!body) {
      return '<p>Chapter content not found.</p>';
    }

    return this.cleanHtmlContent(body.outerHtml || '');
  }

  async cleanHtmlContent(html) {
    if (!html) return '<p>Chapter content not found.</p>';
    let cleaned = html;

    // Remove dangerous elements
    cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    cleaned = cleaned.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
    cleaned = cleaned.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
    cleaned = cleaned.replace(/<video\b[^<]*(?:(?!<\/video>)<[^<]*)*<\/video>/gi, '');
    cleaned = cleaned.replace(/<audio\b[^<]*(?:(?!<\/audio>)<[^<]*)*<\/audio>/gi, '');
    cleaned = cleaned.replace(/<embed\b[^>]*>/gi, '');
    cleaned = cleaned.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');

    // Unwrap spoilers using index-based string manipulation
    cleaned = this.unwrapSpoilers(cleaned);

    // Fix lazy-loaded images
    cleaned = this.fixImages(cleaned);

    // Remove remaining classes and IDs
    cleaned = cleaned.replace(/\sclass=["'][^"']*["']/g, '');
    cleaned = cleaned.replace(/\sid=["'][^"']*["']/g, '');

    return cleaned;
  }

  unwrapSpoilers(html) {
    let result = html;
    let safety = 0;

    // Find spoiler blocks and replace them with their content
    while (result.includes('bbCodeSpoiler') && safety < 20) {
      safety++;

      // Find the start of a spoiler
      const startIdx = result.indexOf('bbCodeSpoiler');
      if (startIdx === -1) break;

      // Find the start of the div containing this class
      let divStart = result.lastIndexOf('<div', startIdx);
      if (divStart === -1) break;

      // Find the label (button title)
      const labelStart = result.indexOf('bbCodeSpoiler-button-title', divStart);
      let label = '';
      if (labelStart !== -1) {
        const labelOpen = result.indexOf('>', labelStart) + 1;
        const labelClose = result.indexOf('</span>', labelOpen);
        if (labelClose !== -1) {
          label = result.substring(labelOpen, labelClose).replace(/<[^>]+>/g, '').trim();
        }
      }

      // Find the content div
      const contentStart = result.indexOf('bbCodeSpoiler-content', divStart);
      if (contentStart === -1) break;

      const contentDivOpen = result.indexOf('>', contentStart) + 1;

      // Find the matching closing div for the content
      let depth = 1;
      let pos = contentDivOpen;
      while (depth > 0 && pos < result.length) {
        const nextOpen = result.indexOf('<div', pos);
        const nextClose = result.indexOf('</div>', pos);

        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          pos = nextOpen + 4;
        } else {
          depth--;
          pos = nextClose + 6;
        }
      }

      const contentEnd = pos - 6;
      let content = result.substring(contentDivOpen, contentEnd);

      // Strip the inner bbCodeBlock wrapper if present
      const blockStart = content.indexOf('bbCodeBlock');
      if (blockStart !== -1) {
        const blockDivOpen = content.indexOf('>', blockStart) + 1;
        const blockDivClose = content.lastIndexOf('</div>');
        if (blockDivClose > blockDivOpen) {
          content = content.substring(blockDivOpen, blockDivClose);
        }
      }

      const heading = label
        ? `<p><strong>[Spoiler: ${label}]</strong></p>`
        : `<p><strong>[Spoiler]</strong></p>`;

      // Replace the entire spoiler block
      result = result.substring(0, divStart) + heading + content + result.substring(pos);
    }

    return result;
  }

  fixImages(html) {
    return html.replace(/<img([^>]*?)>/gi, (match, attrs) => {
      const dataSrcMatch = attrs.match(/data-src=["']([^"']+)["']/i);
      const dataUrlMatch = attrs.match(/data-url=["']([^"']+)["']/i);
      const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);

      let realSrc = '';
      if (dataSrcMatch) realSrc = dataSrcMatch[1];
      else if (dataUrlMatch) realSrc = dataUrlMatch[1];
      else if (srcMatch) realSrc = srcMatch[1];

      if (!realSrc) return match;

      let absolute = realSrc;
      if (!absolute.startsWith('http')) {
        absolute = absolute.startsWith('/') ? SITE + absolute : SITE + '/' + absolute;
      }

      let newAttrs = attrs
        .replace(/data-src=["'][^"']*["']/gi, '')
        .replace(/data-url=["'][^"']*["']/gi, '')
        .replace(/class=["'][^"']*lazyload[^"']*["']/gi, '')
        .replace(/\bsrc=["'][^"']*["']/gi, '');

      return `<img${newAttrs} src="${absolute}">`;
    });
  }

  async getVideoList(url) {
    return [];
  }

  async getPageList(url) {
    return [];
  }

  getFilterList() {
    return [];
  }

  getSourcePreferences() {
    return [];
  }
}
