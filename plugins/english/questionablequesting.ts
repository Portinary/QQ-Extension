import { CheerioAPI, load as cheerioLoad } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';

const SITE = 'https://forum.questionablequesting.com';
const NSFW_CREATIVE_WRITING_ID = 29;
const PER_PAGE = 200;

class QuestionableQuesting implements Plugin.PluginBase {
  id = 'questionablequesting';
  name = 'Questionable Questing';
  site = SITE;
  version = '1.3.5.3';
  icon = 'src/en/questionablequesting/icon.png';
  author = 'personal';

  async fetchPage(url: string): Promise<CheerioAPI> {
    const response = await fetchApi(url);
    const body = await response.text();
    return cheerioLoad(body);
  }

  upgradeAvatar(src: string): string {
    if (!src) return '';
    const upgraded = src.replace(/\/avatars\/[sm]\//, '/avatars/l/');
    return upgraded.startsWith('http') ? upgraded : SITE + upgraded;
  }

  stripTitlePrefix(title: string): string {
    return title.replace(/^\[(NSFW|Quest|CYOA)\]\s*/i, '').trim();
  }

  normalizeThreadUrl(href: string): string {
    if (!href) return href;
    let h = href;
    h = h.replace(/\/unread(\/|\?|$).*$/, '/');
    h = h.replace(/\/latest(\/|\?|$).*$/, '/');
    h = h.replace(/\/post-\d+.*$/, '/');
    h = h.replace(/\?.*$/, '');
    if (!h.endsWith('/')) h += '/';
    return h;
  }

  pickThreadRoot(hrefs: (string | undefined)[]): string | undefined {
    for (const h of hrefs) {
      if (!h) continue;
      if (!/\/(unread|latest)(\/|$|\?)/.test(h) && !/\/post-\d+/.test(h)) {
        return this.normalizeThreadUrl(h);
      }
    }
    if (hrefs[0]) return this.normalizeThreadUrl(hrefs[0]);
    return undefined;
  }

  // 1.2.0 style (no pickThreadRoot, no normalizeThreadUrl) + stripTitlePrefix + pagination
  async popularNovels(page: number = 1): Promise<Plugin.NovelItem[]> {
    const rawPage = Number(page);
    const safePage =
      Number.isFinite(rawPage) && rawPage > 1 ? Math.floor(rawPage) : 1;

    const baseUrl = `${SITE}/forums/nsfw-creative-writing.${NSFW_CREATIVE_WRITING_ID}`;
    const url = safePage === 1 ? `${baseUrl}/` : `${baseUrl}/page-${safePage}`;
    const $ = await this.fetchPage(url);

    const novels: Plugin.NovelItem[] = [];
    $('.structItem--thread').each((_i, el) => {
      if ($(el).find('.structItem-status--sticky').length > 0) return;

      const linkEl = $(el).find('.structItem-title a').last();
      const href = linkEl.attr('href');
      if (!href) return;

      const avatarImg = $(el).find('.structItem-cell--icon img').first();
      const src = avatarImg.attr('src') || avatarImg.attr('data-src');

      novels.push({
        name: this.stripTitlePrefix(linkEl.text().trim()),
        path: href,
        cover: src ? this.upgradeAvatar(src) : undefined,
      });
    });

    return novels;
  }

  async runSearch(url: string): Promise<Plugin.NovelItem[]> {
    const $ = await this.fetchPage(url);
    const novels: Plugin.NovelItem[] = [];

    $('.contentRow').each((_i, el) => {
      const linkEl = $(el).find('.contentRow-title a').first();
      const href = linkEl.attr('href');
      if (!href) return;

      const avatarImg = $(el).find('.contentRow-figure img').first();
      const src = avatarImg.attr('src') || avatarImg.attr('data-src');
      const cover = src ? this.upgradeAvatar(src) : '';

      novels.push({
        name: this.stripTitlePrefix(linkEl.text().trim()),
        path: this.normalizeThreadUrl(href),
        cover,
      });
    });

    return novels;
  }

  async searchNovels(
    searchTerm: string,
    page: number = 1,
  ): Promise<Plugin.NovelItem[]> {
    const term = searchTerm.trim();

    const titleUrl =
      `${SITE}/search/search?keywords=${encodeURIComponent(term)}` +
      `&t=thread&c[title_only]=1&page=${page}`;
    const titleResults = await this.runSearch(titleUrl);

    const isSingleWord = !term.includes(' ') && term.length > 0;
    if (!isSingleWord || page !== 1) return titleResults;

    const authorUrl =
      `${SITE}/search/search?users=${encodeURIComponent(term)}` +
      `&user_content=thread`;
    let authorResults: Plugin.NovelItem[] = [];
    try {
      authorResults = await this.runSearch(authorUrl);
    } catch (_e) {
      authorResults = [];
    }

    const seen = new Set<string>();
    const merged: Plugin.NovelItem[] = [];

    for (const n of [...titleResults, ...authorResults]) {
      if (!n.path || seen.has(n.path)) continue;
      seen.add(n.path);
      merged.push(n);
    }

    return merged;
  }

  extractChapters($page: CheerioAPI, prefix: string): Plugin.ChapterItem[] {
    const chapters: Plugin.ChapterItem[] = [];

    $page('.structItemContainer .structItem--threadmark').each((_i, el) => {
      const el$ = $page(el);
      if (el$.hasClass('structItem--threadmark-filler')) return;

      const linkEl = el$.find('.structItem-title a').first();
      const href = linkEl.attr('href');
      if (!href) return;

      const rawName = linkEl.text().trim();
      const name = prefix ? `${prefix} - ${rawName}` : rawName;

      let releaseTime: Date | undefined = undefined;
      const timeEl = el$.find('time.structItem-latestDate').first();

      const dataTime = timeEl.attr('data-time');
      if (dataTime && /^\d+$/.test(dataTime)) {
        releaseTime = new Date(parseInt(dataTime, 10) * 1000);
      } else {
        const dateStr = timeEl.attr('data-date-string');
        if (dateStr) {
          const parts = dateStr.split('/');
          if (parts.length === 3) {
            const d = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            const y = parseInt(parts[2], 10);
            if (!isNaN(d) && !isNaN(m) && !isNaN(y)) {
              releaseTime = new Date(y, m - 1, d);
            }
          }
        }
      }

      if (releaseTime) {
        chapters.push({ name, path: href, releaseTime: releaseTime as any });
      } else {
        chapters.push({ name, path: href });
      }
    });

    return chapters;
  }

  countChaptersAndPages($page: CheerioAPI): { count: number; pages: number } {
    const stats = $page('.threadmarkListingHeader-stats dl.pairs')
      .filter((_i, el) => $page(el).find('dt').text().trim() === 'Threadmarks')
      .first();
    const count = parseInt(
      stats.find('dd').text().replace(/,/g, '') || '0',
      10,
    );
    return { count, pages: count > 0 ? Math.ceil(count / PER_PAGE) : 1 };
  }

  async fetchCategory(
    baseUrl: string,
    prefix: string,
  ): Promise<Plugin.ChapterItem[]> {
    const firstUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}per_page=${PER_PAGE}`;
    const $first = await this.fetchPage(firstUrl);

    const { pages } = this.countChaptersAndPages($first);
    let chapters = this.extractChapters($first, prefix);

    for (let p = 2; p <= pages; p++) {
      const pageUrl = `${firstUrl}&page=${p}`;
      const $p = await this.fetchPage(pageUrl);
      chapters = chapters.concat(this.extractChapters($p, prefix));
    }

    return chapters;
  }

  extractSummary($thread: CheerioAPI): string {
    const firstPost = $thread('.message:first .bbWrapper').first();
    if (firstPost.length === 0) return '';

    firstPost
      .find(
        '.bbCodeBlock, .bbCodeSpoiler, .bbCodeBlock--quote, button, .bbCodeBlock-expandLink, .bbCodeBlock-shrinkLink',
      )
      .remove();

    let html = firstPost.html() || '';
    html = html
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

    return html;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = novelPath
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/?threads\//, '')
      .replace(/\/threadmarks.*$/, '')
      .replace(/\/post-\d+.*$/, '')
      .replace(/\/unread.*$/, '')
      .replace(/\/latest.*$/, '')
      .replace(/\?.*$/, '')
      .replace(/\/$/, '');

    const defaultUrl = `${SITE}/threads/${slug}/threadmarks`;
    const $ = await this.fetchPage(`${defaultUrl}?per_page=${PER_PAGE}`);

    const titleEl = $('.p-title-value').first();
    titleEl.find('.unreadLink, .labelLink, .label, .label-append').remove();
    const rawTitle =
      titleEl.text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      'Untitled';
    const title = this.stripTitlePrefix(rawTitle);

    const author = $('.username').first().text().trim() || 'Unknown';

    let cover = '';
    let summary = '';
    const threadMainUrl = `${SITE}/threads/${slug}/`;
    try {
      const $thread = await this.fetchPage(threadMainUrl);

      const avatarImg = $thread('img[class^="avatar-u"]').first();
      const src = avatarImg.attr('src') || avatarImg.attr('data-src');
      if (src) cover = this.upgradeAvatar(src);

      summary = this.extractSummary($thread).slice(0, 500);

      if (!summary || summary.length < 50) {
        summary =
          $('meta[name="description"]').attr('content')?.trim() || summary;
      }
    } catch (_e) {
      // Non-fatal
    }

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: title,
      cover,
      author,
      summary,
      status: 'Ongoing',
      chapters: [],
    };

    const categories: { label: string; url: string; isMain: boolean }[] = [];
    $('.block-tabHeader--threadmarkCategoryTabs a.tabs-tab').each((_i, el) => {
      const href = $(el).attr('href');
      const label = $(el).text().trim();
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

    const extras: Plugin.ChapterItem[] = [];
    for (const cat of categories) {
      if (cat.isMain) continue;
      const catChapters = await this.fetchCategory(cat.url, cat.label);
      extras.push(...catChapters);
    }

    novel.chapters = [...mainChapters, ...extras];
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = chapterPath.startsWith('http')
      ? chapterPath
      : SITE + '/' + chapterPath.replace(/^\//, '');

    const $ = await this.fetchPage(url);

    const postMatch = url.match(/post-(\d+)/);
    const postId = postMatch ? postMatch[1] : null;

    let post = postId ? $(`#js-post-${postId}`).first() : null;
    if (!post || post.length === 0) post = $('.message-body').first();

    let body = post.find('.bbWrapper').first();
    if (body.length === 0) body = $('.bbWrapper').first();

    body.find('img').each((_i, el) => {
      const $img = $(el);
      const realSrc =
        $img.attr('data-src') || $img.attr('data-url') || $img.attr('src');
      if (realSrc) {
        const absolute = realSrc.startsWith('http')
          ? realSrc
          : realSrc.startsWith('/')
            ? SITE + realSrc
            : SITE + '/' + realSrc;
        $img.attr('src', absolute);
        $img.removeAttr('data-src');
        $img.removeAttr('data-url');
        $img.removeClass('lazyload');
      }
    });

    body.find('.bbCodeSpoiler').each((_i, el) => {
      const $spoiler = $(el);
      const $button = $spoiler.find('.bbCodeSpoiler-button').first();
      const label = $button.text().trim().replace(/^Spoiler:\s*/i, '');
      const $content = $spoiler.find('.bbCodeSpoiler-content').first();

      if ($content.length === 0) {
        $spoiler.remove();
        return;
      }

      const heading = label
        ? `<p><strong>[Spoiler: ${label}]</strong></p>`
        : `<p><strong>[Spoiler]</strong></p>`;

      $spoiler.replaceWith(heading + $content.html());
    });

    body.find('.bbCodeBlock-expandLink, .bbCodeBlock-shrinkLink').remove();
    body.find('button').remove();

    body.find('img').each((_i, el) => {
      const src = $(el).attr('src');
      if (src && src.startsWith('/')) $(el).attr('src', SITE + src);
    });

    return body.html() || '<p>Chapter content not found.</p>';
  }
}

export default new QuestionableQuesting();
