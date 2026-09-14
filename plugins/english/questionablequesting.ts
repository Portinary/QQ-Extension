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
  version = '1.1.7';
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

  // Pick the thread-root link from a XenForo thread title block.
  // Skips /unread, /post-NNN, /latest which break parseNovel.
  pickThreadRoot(hrefs: (string | undefined)[]): string | undefined {
    for (const h of hrefs) {
      if (!h) continue;
      if (!/\/(unread|latest)(\/|$)/.test(h) && !/\/post-\d+/.test(h)) {
        return h;
      }
    }
    return hrefs[0];
  }

  async popularNovels(): Promise<Plugin.NovelItem[]> {
    const url = `${SITE}/forums/nsfw-creative-writing.${NSFW_CREATIVE_WRITING_ID}/`;
    const $ = await this.fetchPage(url);

    const novels: Plugin.NovelItem[] = [];
    $('.structItem--thread').each((_i, el) => {
      if ($(el).find('.structItem-status--sticky').length > 0) return;

      const links = $(el).find('.structItem-title a');
      const titleText = links.last().text().trim();

      // Collect all hrefs and pick the thread-root one
      const hrefs: (string | undefined)[] = [];
      links.each((_j, a) => {
        hrefs.push($(a).attr('href'));
      });
      const href = this.pickThreadRoot(hrefs);
      if (!href) return;

      const avatarImg = $(el).find('.structItem-cell--icon img').first();
      const src = avatarImg.attr('src') || avatarImg.attr('data-src');

      novels.push({
        name: titleText,
        path: href,
        cover: src ? this.upgradeAvatar(src) : undefined,
      });
    });

    return novels;
  }

  async searchNovels(
    searchTerm: string,
    page: number = 1,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      `${SITE}/search/search?keywords=${encodeURIComponent(searchTerm)}` +
      `&t=thread&c[title_only]=1&page=${page}`;
    const $ = await this.fetchPage(url);

    const novels: Plugin.NovelItem[] = [];
    $('.contentRow').each((_i, el) => {
      const linkEl = $(el).find('.contentRow-title a').first();
      const href = linkEl.attr('href');
      if (!href) return;

      const avatarImg = $(el).find('.contentRow-figure img').first();
      const src = avatarImg.attr('src') || avatarImg.attr('data-src');

      novels.push({
        name: linkEl.text().trim(),
        path: href,
        cover: src ? this.upgradeAvatar(src) : undefined,
      });
    });

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    // Normalize any URL shape to a bare slug:
    // full URL, /threads/slug.123/, /threads/slug.123/post-999,
    // /threads/slug.123/unread, /threads/slug.123/latest, query strings
    const slug = novelPath
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/?threads\//, '')
      .replace(/\/threadmarks.*$/, '')
      .replace(/\/post-\d+.*$/, '')
      .replace(/\/unread.*$/, '')
      .replace(/\/latest.*$/, '')
      .replace(/\?.*$/, '')
      .replace(/\/$/, '');

    const threadUrl = `${SITE}/threads/${slug}/threadmarks?per_page=${PER_PAGE}`;
    const $ = await this.fetchPage(threadUrl);

    // --- Title ---
    const titleEl = $('.p-title-value').first();
    titleEl.find('.unreadLink, .labelLink, .label, .label-append').remove();
    const title =
      titleEl.text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      'Untitled';

    // --- Author ---
    const author = $('.username').first().text().trim() || 'Unknown';

    // --- Avatar + summary from main thread page ---
    let cover = '';
    let summary = '';
    const threadMainUrl = `${SITE}/threads/${slug}/`;
    try {
      const $thread = await this.fetchPage(threadMainUrl);

      const avatarImg = $thread('img[class^="avatar-u"]').first();
      const src = avatarImg.attr('src') || avatarImg.attr('data-src');
      if (src) cover = this.upgradeAvatar(src);

      const firstPost = $thread('.message:first .bbWrapper').first();
      if (firstPost.length > 0) {
        summary = firstPost.text().trim().slice(0, 300);
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

    // --- Threadmark pagination ---
    const threadmarkStats = $('.threadmarkListingHeader-stats dl.pairs')
      .filter((_i, el) => $(el).find('dt').text().trim() === 'Threadmarks')
      .first();
    const totalCount = parseInt(
      threadmarkStats.find('dd').text().replace(/,/g, '') || '0',
      10,
    );
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / PER_PAGE) : 1;

    // --- Chapters ---
    const allChapters: Plugin.ChapterItem[] = [];
    for (let page = 1; page <= totalPages; page++) {
      const pageUrl =
        page === 1
          ? threadUrl
          : `${SITE}/threads/${slug}/threadmarks?per_page=${PER_PAGE}&page=${page}`;
      const $p = page === 1 ? $ : await this.fetchPage(pageUrl);

      $p('.structItemContainer .structItem--threadmark').each((_i, el) => {
        const el$ = $p(el);
        if (el$.hasClass('structItem--threadmark-filler')) return;

        const linkEl = el$.find('.structItem-title a').first();
        const href = linkEl.attr('href');
        if (!href) return;

        // --- Date extraction: force integer seconds -> ms ---
        const timeEl = el$.find('time.structItem-latestDate').first();
        let releaseTime: number | undefined = undefined;

        const dataTime = timeEl.attr('data-time');
        if (dataTime && /^\d+$/.test(dataTime)) {
          const ts = parseInt(dataTime, 10);
          releaseTime = Math.floor(dataTime.length === 13 ? ts : ts * 1000);
        } else {
          const dateStr = timeEl.attr('data-date-string');
          if (dateStr) {
            const parts = dateStr.split('/');
            if (parts.length === 3) {
              const d = parseInt(parts[0], 10);
              const m = parseInt(parts[1], 10);
              const y = parseInt(parts[2], 10);
              if (!isNaN(d) && !isNaN(m) && !isNaN(y)) {
                releaseTime = Math.floor(new Date(y, m - 1, d).getTime());
              }
            }
          }
        }

        allChapters.push({
          name: linkEl.text().trim(),
          path: href,
          releaseTime,
        });
      });
    }

    novel.chapters = allChapters.reverse();
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

    body.find('.bbCodeBlock-expandLink, .bbCodeBlock-shrinkLink').remove();
    body.find('.bbCodeSpoiler button').remove();

    body.find('img').each((_i, el) => {
      const src = $(el).attr('src');
      if (src && src.startsWith('/')) $(el).attr('src', SITE + src);
    });

    return body.html() || '<p>Chapter content not found.</p>';
  }
}

export default new QuestionableQuesting();
