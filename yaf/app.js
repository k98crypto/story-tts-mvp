const API = window.location.origin;
const DB_NAME = 'yaf-audiobooks';
const DB_VERSION = 2;
const BOOK_STORE = 'books';
const PROGRESS_STORE = 'readingProgress';
const MAX_TTS_CHARS = 1100;
const SPEECH_BATCH_CHARS = 300;
const MAX_EPUB_BYTES = 100 * 1024 * 1024;
const MAX_EPUB_ENTRIES = 50000;
const MAX_EPUB_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_EPUB_TOTAL_BYTES = 250 * 1024 * 1024;

const ui = Object.fromEntries([
  'serviceState', 'installButton', 'accountButton', 'mobileSettingsButton', 'settingsCloseButton', 'tocPane', 'bookFile', 'bookSearch', 'bookList', 'bookCount', 'librarySaveStatus',
  'clearLibraryButton', 'currentBookCrumb', 'removeBookButton', 'emptyReader', 'bookReader', 'chapterCounter',
  'bookTitle', 'chapterSelect', 'bookProgressLabel', 'chapterProgressFill', 'textPage', 'pagePosition',
  'readingPlaybackBar', 'readingPlaybackStatus', 'readingPauseButton', 'readFromHereButton', 'returnToSpeechButton',
  'bookCover',
  'previousChapterButton', 'nextChapterButton', 'voiceSelect', 'speedRange', 'speedValue', 'sleepTimer',
  'nowPlayingTitle', 'playbackStatus', 'accountNote', 'positionLabel', 'positionRange', 'durationLabel',
  'playerBookTitle', 'playerChapterTitle', 'playButton', 'stopButton', 'previousParagraphButton',
  'nextParagraphButton', 'playState', 'playerRate', 'authDialog', 'authTitle', 'authDescription',
  'authEmail', 'authPassword', 'authSubmit', 'authModeButton', 'forgotPasswordButton', 'authMessage', 'toast'
].map(id => [id, document.getElementById(id)]));

let db;
let books = [];
let activeBookId = null;
let authConfig = null;
let accessToken = sessionStorage.getItem('yaf.accessToken') || '';
let userEmail = '';
let authMode = 'login';
let audio = null;
let audioReady = false;
let audioUrl = '';
let synthController = null;
let playing = false;
let speechPositionActive = false;
let speechRange = null;
let playGeneration = 0;
let sleepTimeout = null;
let chapterTimer = false;
let installPrompt = null;
let followSpeech = true;
let zipLoadPromise = null;
const coverUrlCache = new Map();

function currentBook() { return books.find(book => book.id === activeBookId) || null; }
function currentChapter(book = currentBook()) { return book?.chapters[book.progress.chapterIndex] || null; }
function readingLocation(book = currentBook()) {
  return book?.reading || {chapterIndex:book?.progress.chapterIndex || 0, paragraphIndex:book?.progress.paragraphIndex || 0};
}
function sameLocation(first, second) {
  return first.chapterIndex === second.chapterIndex && first.paragraphIndex === second.paragraphIndex;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(BOOK_STORE)) database.createObjectStore(BOOK_STORE, {keyPath:'id'});
      if (!database.objectStoreNames.contains(PROGRESS_STORE)) database.createObjectStore(PROGRESS_STORE, {keyPath:'id'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putBook(book) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(BOOK_STORE, 'readwrite').objectStore(BOOK_STORE).put(book);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function putProgress(progress) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(PROGRESS_STORE, 'readwrite').objectStore(PROGRESS_STORE).put(progress);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deleteBook(id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(BOOK_STORE, 'readwrite').objectStore(BOOK_STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deleteProgress(id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(PROGRESS_STORE, 'readwrite').objectStore(PROGRESS_STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function loadBooks() {
  return new Promise((resolve, reject) => {
    const request = db.transaction(BOOK_STORE).objectStore(BOOK_STORE).getAll();
    request.onsuccess = () => resolve(request.result.sort((a,b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error);
  });
}

function loadProgress() {
  return new Promise((resolve, reject) => {
    const request = db.transaction(PROGRESS_STORE).objectStore(PROGRESS_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function safeText(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function createBookId() {
  if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof window.crypto?.getRandomValues === 'function') window.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function showToast(message, duration = 2600) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => ui.toast.classList.remove('show'), duration);
}

function chapterHeading(line) {
  const text = line.trim();
  return /^#{1,6}\s+\S/.test(text)
    || /^(?:第\s*[0-9零〇一二三四五六七八九十百千万两\d]+\s*[章节卷部篇回].{0,45}|序章|楔子|引子|尾声|后记|番外\S{0,40})$/.test(text)
    || /^(?:chapter|prologue|epilogue)\s+(?:\d+|[ivxlcdm]+|\S.{0,30})$/i.test(text);
}

function parseBookText(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  const lines = text.split('\n');
  const chapters = [];
  let current = {title:'正文', paragraphs:[]};
  let paragraph = [];
  const flushParagraph = () => {
    const value = joinWrappedLines(paragraph).replace(/[ \t]+/g, ' ').trim();
    if (value) current.paragraphs.push(value);
    paragraph = [];
  };
  const flushChapter = () => {
    flushParagraph();
    if (current.paragraphs.length) chapters.push(current);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushParagraph(); continue; }
    if (chapterHeading(trimmed)) {
      flushChapter();
      current = {title:trimmed.replace(/^#{1,6}\s+/, ''), paragraphs:[]};
    } else {
      paragraph.push(trimmed.replace(/^>\s*/, '').replace(/^[-*]\s+/, ''));
    }
  }
  flushChapter();
  return chapters.length ? chapters : [{title:'正文', paragraphs:[text]}];
}

function joinWrappedLines(lines) {
  const cjk = /[\u2e80-\u9fff\uf900-\ufaff\uac00-\ud7af\u{20000}-\u{2fa1f}]/u;
  const noSpace = /[([{（［｛「『【《〈“‘]$/u;
  const noSpaceBefore = /^[,.;:!?，。；：！？、）］｝」』】》〉”’]/u;
  let result = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!result) { result = line; continue; }
    const previous = result.slice(-1);
    const next = line.charAt(0);
    result += noSpace.test(previous) || noSpaceBefore.test(next) || cjk.test(previous) || cjk.test(next) ? line : ` ${line}`;
  }
  return result;
}

function extractEpubText(root) {
  const output = [];
  const blockTags = new Set(['ADDRESS','ARTICLE','BLOCKQUOTE','DIV','LI','OL','P','PRE','SECTION','TABLE','TR']);
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) { output.push(node.nodeValue || ''); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toUpperCase();
    const heading = /^H[1-6]$/.test(tag);
    if (heading) {
      const title = node.textContent.trim();
      if (title) output.push(`\n${'#'.repeat(Number(tag.slice(1)))} ${title}\n`);
      return;
    }
    if (tag === 'BR') { output.push('\n'); return; }
    if (blockTags.has(tag)) output.push('\n');
    for (const child of node.childNodes) visit(child);
    if (blockTags.has(tag)) output.push('\n');
  }
  visit(root);
  return output.join('').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n');
}

function xmlElements(node, localName) {
  const namespaced = Array.from(node.getElementsByTagNameNS('*', localName));
  return namespaced.length ? namespaced : Array.from(node.getElementsByTagName(localName));
}

function parseEpubPath(basePath, href) {
  const url = new URL(href, `https://epub.invalid/${basePath}`);
  if (url.origin !== 'https://epub.invalid') throw new Error('EPUB 包含外部章节路径');
  return decodeURIComponent(url.pathname).replace(/^\/+/, '');
}

function parseXml(source, label) {
  const documentNode = new DOMParser().parseFromString(source, 'application/xml');
  if (documentNode.querySelector('parsererror')) throw new Error(`EPUB 的 ${label} 无法解析`);
  return documentNode;
}

async function parseEpubBook(file) {
  await loadZipLibrary();
  if (file.size > MAX_EPUB_BYTES) throw new Error('EPUB 文件超过 100 MB，暂不支持导入');
  const reader = new window.zip.ZipReader(new window.zip.BlobReader(file));
  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_EPUB_ENTRIES) throw new Error('EPUB 文件条目过多，无法安全导入');
    const archive = new Map(entries.map(entry => [entry.filename, entry]));
    const containerFile = archive.get('META-INF/container.xml');
    if (!containerFile) throw new Error('EPUB 缺少 container.xml');
    const container = parseXml(await containerFile.getData(new window.zip.TextWriter()), '容器目录');
    const packageLocation = xmlElements(container, 'rootfile')[0]?.getAttribute('full-path');
    if (!packageLocation) throw new Error('EPUB 没有有效的书籍目录');
    const packagePath = parseEpubPath('', packageLocation);
    const packageFile = archive.get(packagePath);
    if (!packageFile) throw new Error('EPUB 书籍目录文件不存在');
    const packageDocument = parseXml(await packageFile.getData(new window.zip.TextWriter()), '书籍目录');
    const bookTitle = xmlElements(packageDocument, 'title')[0]?.textContent.trim();
    const manifestItems = xmlElements(packageDocument, 'item');
    const manifest = new Map(manifestItems.map(item => [item.getAttribute('id'), item]));
    const metadata = xmlElements(packageDocument, 'meta');
    const legacyCoverId = metadata.find(meta => meta.getAttribute('name')?.toLowerCase() === 'cover')?.getAttribute('content');
    const epub3CoverId = metadata.find(meta => meta.getAttribute('property')?.toLowerCase() === 'cover')?.textContent.trim();
    const coverItem = manifestItems.find(item => item.getAttribute('properties')?.split(/\s+/).includes('cover-image'))
      || manifest.get(legacyCoverId) || manifest.get(epub3CoverId);
    let coverBlob = null;
    if (coverItem) {
      try {
        const coverEntry = archive.get(parseEpubPath(packagePath, coverItem.getAttribute('href')));
        const mediaType = coverItem.getAttribute('media-type') || '';
        if (coverEntry && /^image\/(?:jpeg|png|webp|gif)$/i.test(mediaType)
          && (coverEntry.uncompressedSize || 0) <= 5 * 1024 * 1024) {
          coverBlob = await coverEntry.getData(new window.zip.BlobWriter(mediaType));
        }
      } catch {}
    }
    const spine = xmlElements(packageDocument, 'spine')[0];
    if (!spine) throw new Error('EPUB 缺少阅读顺序目录');

    const chapters = [];
    const seenPaths = new Set();
    let totalBytes = 0;
    for (const reference of xmlElements(spine, 'itemref')) {
      if (reference.getAttribute('linear') === 'no') continue;
      const item = manifest.get(reference.getAttribute('idref'));
      if (!item || item.getAttribute('properties')?.split(/\s+/).includes('nav')) continue;
      if (!['application/xhtml+xml', 'text/html'].includes(item.getAttribute('media-type'))) continue;
      const chapterPath = parseEpubPath(packagePath, item.getAttribute('href'));
      if (seenPaths.has(chapterPath)) continue;
      seenPaths.add(chapterPath);
      const chapterFile = archive.get(chapterPath);
      if (!chapterFile) continue;
      const entryBytes = chapterFile.uncompressedSize || 0;
      if (entryBytes > MAX_EPUB_ENTRY_BYTES || totalBytes + entryBytes > MAX_EPUB_TOTAL_BYTES) {
        throw new Error('EPUB 正文过大，单章限制 32 MB，总正文限制 250 MB');
      }
      totalBytes += entryBytes;

      const chapterSource = await chapterFile.getData(new window.zip.TextWriter());
      const chapterDocument = new DOMParser().parseFromString(chapterSource, 'text/html');
      const content = (chapterDocument.body || chapterDocument.documentElement).cloneNode(true);
      content.querySelectorAll('script,style,nav,aside,svg,noscript,[hidden]').forEach(element => element.remove());
      const chapterTitle = content.querySelector('h1,h2,h3,h4,h5,h6')?.textContent.trim()
        || chapterDocument.title.trim() || item.getAttribute('id') || '未命名章节';
      const parsed = parseBookText(extractEpubText(content));
      if (!parsed.some(chapter => chapter.paragraphs.some(paragraph => paragraph.trim()))) continue;
      if (parsed.length === 1 && parsed[0].title === '正文') parsed[0].title = chapterTitle;
      chapters.push(...parsed);
    }

    if (!chapters.some(chapter => chapter.paragraphs.some(paragraph => paragraph.trim()))) throw new Error('EPUB 里没有可读取的正文');
    return {title:bookTitle, chapters, coverBlob};
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EPUB ')) throw error;
    throw new Error(`EPUB 解压失败：${error.message || '文件结构异常'}`);
  } finally {
    await reader.close().catch(() => {});
  }
}

function loadZipLibrary() {
  if (window.zip?.ZipReader && window.zip?.BlobReader) return Promise.resolve();
  if (zipLoadPromise) return zipLoadPromise;
  zipLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/zip.min.js?v=2.24.0';
    script.onload = () => window.zip?.ZipReader && window.zip?.BlobReader
      ? resolve()
      : reject(new Error('EPUB 解压组件加载失败，请重新选择文件'));
    script.onerror = () => {
      zipLoadPromise = null;
      reject(new Error('EPUB 解压组件加载失败，请检查网络后重试'));
    };
    document.head.append(script);
  });
  return zipLoadPromise;
}

function textCharCount(text) { return Array.from(text.replace(/\s/gu, '')).length; }
function chapterCharCount(chapter) { return chapter.paragraphs.reduce((total, paragraph) => total + textCharCount(paragraph), 0); }
function bookCharCount(book) { return book.chapters.reduce((total, chapter) => total + chapterCharCount(chapter), 0); }
function totalParagraphs(book) { return book.chapters.reduce((total, chapter) => total + chapter.paragraphs.length, 0); }
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2,'0')}:${String(remainder).padStart(2,'0')}`;
}

function currentBookOffset(book, position = book.reading || book.progress) {
  let offset = 0;
  for (let chapterIndex = 0; chapterIndex < position.chapterIndex; chapterIndex++) offset += chapterCharCount(book.chapters[chapterIndex]);
  const chapter = book.chapters[position.chapterIndex];
  for (let index = 0; index < position.paragraphIndex; index++) offset += textCharCount(chapter?.paragraphs[index] || '');
  return offset;
}

function bookCoverUrl(book) {
  if (!book.coverBlob) return '/assets/cover.webp';
  if (!coverUrlCache.has(book.id)) coverUrlCache.set(book.id, URL.createObjectURL(book.coverBlob));
  return coverUrlCache.get(book.id);
}

function releaseBookCover(bookId) {
  const url = coverUrlCache.get(bookId);
  if (url) URL.revokeObjectURL(url);
  coverUrlCache.delete(bookId);
}

function renderLibrary() {
  const query = ui.bookSearch.value.trim().toLocaleLowerCase();
  const visibleBooks = books.filter(book => book.title.toLocaleLowerCase().includes(query));
  ui.bookCount.textContent = `${books.length} 本书`;
  if (!visibleBooks.length) {
    ui.bookList.innerHTML = books.length ? '<p class="empty-library">没有匹配的小说</p>' : '<p class="empty-library">书架还空着。导入 TXT、Markdown 或 EPUB 小说开始听。</p>';
    return;
  }
  ui.bookList.innerHTML = visibleBooks.map(book => {
    const percent = Math.round(currentBookOffset(book) / Math.max(bookCharCount(book), 1) * 100);
    const recent = book.id === books[0]?.id;
    return `<button class="book-item" type="button" data-book="${safeText(book.id)}" aria-current="${book.id === activeBookId}">
      <span class="book-thumb" aria-hidden="true">${book.coverBlob ? `<img src="${safeText(bookCoverUrl(book))}" alt="">` : safeText(book.title.slice(0,1))}</span>
      <span class="book-meta"><strong>${safeText(book.title)}</strong><small>${recent ? '最近阅读 · ' : ''}${safeText(book.chapters[(book.reading || book.progress).chapterIndex]?.title || '未开始')} · ${percent}%</small></span>
    </button>`;
  }).join('');
  ui.bookList.querySelectorAll('[data-book]').forEach(button => button.addEventListener('click', () => selectBook(button.dataset.book)));
}

function renderReader({scroll = false} = {}) {
  const book = currentBook();
  ui.emptyReader.hidden = Boolean(book);
  ui.bookReader.hidden = !book;
  ui.removeBookButton.disabled = !book;
  if (!book) {
    ui.readingPlaybackBar.hidden = true;
    ui.librarySaveStatus.textContent = '仅保存在此设备';
    ui.currentBookCrumb.textContent = '未选择小说';
    ui.playerBookTitle.textContent = 'YAF 听书';
    ui.playerChapterTitle.textContent = '选择一本小说开始';
    ui.nowPlayingTitle.textContent = '还没有开始播放';
    ui.playbackStatus.textContent = '导入小说后，选择章节开始听';
    renderLibrary();
    return;
  }

  const speechChapter = currentChapter(book);
  const speechLocation = {chapterIndex:book.progress.chapterIndex, paragraphIndex:book.progress.paragraphIndex};
  const location = readingLocation(book);
  location.chapterIndex = Math.max(0, Math.min(book.chapters.length - 1, location.chapterIndex));
  const chapter = book.chapters[location.chapterIndex];
  const chapterIndex = location.chapterIndex;
  const paragraphIndex = Math.min(location.paragraphIndex, Math.max(0, chapter.paragraphs.length - 1));
  book.reading = {chapterIndex, paragraphIndex};
  ui.currentBookCrumb.textContent = book.title;
  ui.bookTitle.textContent = book.title;
  ui.bookCover.src = bookCoverUrl(book);
  ui.chapterCounter.textContent = `第 ${chapterIndex + 1} / ${book.chapters.length} 章`;
  ui.chapterSelect.innerHTML = book.chapters.map((item, index) => `<option value="${index}">${String(index + 1).padStart(2,'0')} · ${safeText(item.title)}</option>`).join('');
  ui.chapterSelect.value = String(chapterIndex);
  ui.playerBookTitle.textContent = book.title;
  ui.playerChapterTitle.textContent = speechChapter?.title || chapter.title;

  const totalChars = Math.max(bookCharCount(book), 1);
  const offset = currentBookOffset(book, book.reading);
  const percent = Math.min(100, Math.floor(offset / totalChars * 100));
  ui.bookProgressLabel.textContent = `${percent}%`;
  ui.positionRange.max = String(Math.max(totalParagraphs(book) - 1, 0));
  ui.positionRange.value = String(globalParagraphIndex(book, book.reading));
  const estimatedSeconds = totalChars / 6.8;
  ui.positionLabel.textContent = formatTime(estimatedSeconds * percent / 100);
  ui.durationLabel.textContent = formatTime(estimatedSeconds);
  ui.chapterProgressFill.style.width = `${Math.round((paragraphIndex + 1) / Math.max(chapter.paragraphs.length,1) * 100)}%`;
  ui.pagePosition.textContent = `段落 ${paragraphIndex + 1} / ${chapter.paragraphs.length} · ${chapterCharCount(chapter).toLocaleString()} 字`;
  ui.nowPlayingTitle.textContent = playing ? speechChapter.title : chapter.title;
  const positionDiffers = speechPositionActive && !sameLocation(speechLocation, book.reading);
  ui.readingPlaybackBar.hidden = !positionDiffers;
  ui.readingPlaybackStatus.textContent = `正在朗读：${speechChapter.title} · 第 ${speechLocation.paragraphIndex + 1} 段`;
  ui.readingPauseButton.textContent = audio && !audio.paused ? '暂停' : '继续';

  const start = Math.max(0, paragraphIndex - 5);
  const end = Math.min(chapter.paragraphs.length, Math.max(paragraphIndex + 10, 15));
  const excerpt = chapter.paragraphs.slice(start, end);
  ui.textPage.innerHTML = `<h3 class="chapter-title">${safeText(chapter.title)}</h3>${excerpt.map((text, index) => {
    const actualIndex = start + index;
    const isReading = actualIndex === paragraphIndex;
    const isSpeaking = speechRange
      ? speechRange.chapterIndex === chapterIndex && actualIndex >= speechRange.startIndex && actualIndex < speechRange.endIndex
      : speechLocation.chapterIndex === chapterIndex && actualIndex === speechLocation.paragraphIndex;
    return `<p class="novel-paragraph${isReading ? ' is-reading' : ''}${isSpeaking ? ' is-speaking' : ''}" data-paragraph="${actualIndex}">${safeText(text)}</p>`;
  }).join('')}`;
  ui.textPage.querySelectorAll('[data-paragraph]').forEach(node => node.addEventListener('click', () => jumpToParagraph(Number(node.dataset.paragraph))));
  ui.previousChapterButton.disabled = chapterIndex === 0;
  ui.nextChapterButton.disabled = chapterIndex >= book.chapters.length - 1;
  if (scroll) ui.textPage.querySelector('.is-reading')?.scrollIntoView({block:'center', behavior:'smooth'});
  saveCurrentProgress();
  renderLibrary();
}

function globalParagraphIndex(book, position = book.reading || book.progress) {
  let result = 0;
  for (let chapter = 0; chapter < position.chapterIndex; chapter++) result += book.chapters[chapter].paragraphs.length;
  return result + position.paragraphIndex;
}

function saveCurrentProgress() {
  const book = currentBook();
  if (!book) return;
  book.progress.offset = currentBookOffset(book);
  book.updatedAt = Date.now();
  books.sort((a,b) => b.updatedAt - a.updatedAt);
  ui.librarySaveStatus.textContent = '保存中…';
  putProgress({id:book.id, progress:{...book.progress}, reading:{...book.reading}, updatedAt:book.updatedAt})
    .then(() => { if (currentBook()?.id === book.id) ui.librarySaveStatus.textContent = '已保存在此设备'; })
    .catch(() => { ui.librarySaveStatus.textContent = '保存失败'; showToast('进度保存失败，请检查设备存储空间'); });
}

async function selectBook(id) {
  if (playing) stopPlayback();
  activeBookId = id;
  followSpeech = true;
  await renderReader({scroll:true});
}

function setStatus(message, ready = null) {
  const status = ui.serviceState;
  status.querySelector('span').textContent = message;
  if (ready !== null) status.dataset.ready = String(ready);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {...options, cache:'no-store'});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.msg || body.error_description || body.error || `请求失败 (${response.status})`);
  return body;
}

async function loadConfig() {
  try {
    authConfig = await fetchJson(`${API}/config`);
    if (!authConfig.authReady || !authConfig.localAuth) {
      throw new Error('本地账号服务未就绪');
    }
    ui.accountNote.textContent = '本地服务器管理账号和每日配额，无需邮箱验证。管理员首次注册需连接家中 Wi-Fi。书籍保存在当前设备。';
  } catch {
    ui.accountNote.textContent = '本地账号服务暂不可用；书架仍可在本机阅读。';
    ui.authSubmit.disabled = true;
    setStatus('账号服务未就绪', false);
  }
}

async function checkModel() {
  try {
    const health = await fetchJson(`${API}/health`);
    const ready = health.ready === true;
    setStatus(ready ? 'AI 语音就绪' : '模型加载中', ready);
    return ready;
  } catch {
    setStatus('语音服务离线', false);
    return false;
  }
}

function authHeaders(token = accessToken) {
  return {'Content-Type':'application/json', Authorization:`Bearer ${token}`};
}

async function verifySession(token) {
  const response = await fetch(`${API}/session`, {headers:authHeaders(token), cache:'no-store'});
  if (!response.ok) return null;
  return response.json();
}

function setSignedIn(email) {
  userEmail = email || '';
  ui.accountButton.textContent = userEmail ? '退出' : '登录';
  ui.accountButton.title = userEmail;
}

async function restoreSession() {
  if (!authConfig?.localAuth) return;
  if (accessToken) {
    const user = await verifySession(accessToken).catch(() => null);
    if (user?.email) { setSignedIn(user.email); return; }
  }
  accessToken = '';
  sessionStorage.removeItem('yaf.accessToken');
  setSignedIn('');
}

function openAuthDialog() {
  if (!authConfig?.localAuth) { showToast('本地账号服务暂不可用'); return; }
  authMode = 'login';
  updateAuthDialog();
  try {
    if (typeof ui.authDialog.showModal === 'function') ui.authDialog.showModal();
    else {
      ui.authDialog.classList.add('fallback-open');
      ui.authDialog.setAttribute('open', '');
    }
  } catch {
    ui.authDialog.classList.add('fallback-open');
    ui.authDialog.setAttribute('open', '');
  }
}

function updateAuthDialog() {
  const signingUp = authMode === 'signup';
  ui.authTitle.textContent = signingUp ? '创建本地账号' : '登录后开始听';
  ui.authDescription.textContent = signingUp
    ? '账号保存在听书服务器，无需邮箱验证。管理员账号首次注册需连接家中 Wi-Fi。'
    : '使用听书服务器的本地账号。';
  ui.authSubmit.textContent = signingUp ? '创建账号' : '登录';
  ui.authModeButton.hidden = false;
  ui.forgotPasswordButton.hidden = false;
  ui.forgotPasswordButton.textContent = '忘记密码';
  ui.authModeButton.textContent = signingUp ? '已有账号？登录' : '创建账号';
  ui.authPassword.autocomplete = signingUp ? 'new-password' : 'current-password';
  ui.authPassword.placeholder = signingUp ? '至少 8 个字符' : '';
  ui.authMessage.textContent = '';
}

async function submitAuth() {
  if (!authConfig?.localAuth) return;
  const email = ui.authEmail.value.trim();
  const password = ui.authPassword.value;
  if (!email || !password) { ui.authMessage.textContent = '请填写邮箱和密码。'; return; }
  if (password.length < 8) { ui.authMessage.textContent = '密码至少需要 8 个字符。'; return; }
  ui.authSubmit.disabled = true;
  const signup = authMode === 'signup';
  ui.authMessage.textContent = signup ? '正在创建本地账号…' : '正在登录…';
  try {
    const response = await fetch(`${API}/auth/local/${signup ? 'signup' : 'login'}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email, password})
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '账号请求失败');
    accessToken = result.accessToken || '';
    sessionStorage.setItem('yaf.accessToken', accessToken);
    setSignedIn(result.user?.email || email);
    ui.authDialog.close();
    ui.authPassword.value = '';
    showToast(signup ? '本地账号已创建' : '登录成功');
    if (currentBook()) play();
  } catch (error) {
    ui.authMessage.textContent = String(error.message || '账号请求失败');
  } finally {
    ui.authSubmit.disabled = false;
  }
}

async function resetPassword() {
  ui.authMessage.textContent = '本地账号不通过邮件找回密码，请联系服务器管理员在本机重置。';
}

async function logout() {
  stopPlayback();
  if (accessToken) await fetch(`${API}/auth/local/logout`, {method:'POST', headers:authHeaders()}).catch(() => {});
  accessToken = '';
  sessionStorage.removeItem('yaf.accessToken');
  setSignedIn('');
  showToast('已退出登录');
}

function splitText(text) {
  const parts = text.match(/[^。！？!?；;]+[。！？!?；;]?|[^。！？!?；;]+$/g) || [text];
  const chunks = [];
  let current = '';
  for (const part of parts) {
    let remaining = part.trim();
    if (!remaining) continue;
    while (remaining.length > MAX_TTS_CHARS) {
      if (current) { chunks.push(current); current = ''; }
      let cut = remaining.lastIndexOf('，', MAX_TTS_CHARS);
      if (cut < MAX_TTS_CHARS * .55) cut = MAX_TTS_CHARS;
      chunks.push(remaining.slice(0, cut + (cut < MAX_TTS_CHARS ? 1 : 0)));
      remaining = remaining.slice(cut + (cut < MAX_TTS_CHARS ? 1 : 0)).trim();
    }
    if (current.length + remaining.length > MAX_TTS_CHARS) {
      if (current) chunks.push(current);
      current = remaining;
    } else current += remaining;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function synthesize(text, signal) {
  const response = await fetch(`${API}/synthesize`, {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${accessToken}`},
    body:JSON.stringify({text, speaker:ui.voiceSelect.value, emotion:'neutral', direction:''}), signal
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) { accessToken = ''; setSignedIn(''); openAuthDialog(); }
    throw new Error(failure.error || failure.detail || `语音生成失败 (${response.status})`);
  }
  return response.blob();
}

function releaseAudio(clearSource = false) {
  if (audio) {
    audio.pause();
    audio.onended = null;
    audio.ontimeupdate = null;
    audio.onerror = null;
    if (clearSource) {
      audio.removeAttribute('src');
      audio.load();
      audioReady = false;
    }
  }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = ''; }
}

function getSpeechBatch(chapter, startIndex) {
  const paragraphs = [];
  let characterCount = 0;
  let endIndex = startIndex;
  while (endIndex < chapter.paragraphs.length) {
    const paragraph = chapter.paragraphs[endIndex];
    const added = Array.from(paragraph).length + (paragraphs.length ? 1 : 0);
    if (paragraphs.length && characterCount + added > SPEECH_BATCH_CHARS) break;
    paragraphs.push(paragraph);
    characterCount += added;
    endIndex++;
    if (characterCount >= SPEECH_BATCH_CHARS) break;
  }
  return {text:paragraphs.join('\n'), startIndex, endIndex};
}

function setPlayState(label) {
  ui.playState.textContent = label;
  ui.playbackStatus.textContent = label;
}

function setPlayButtonState(isPlaying, label = isPlaying ? '暂停' : '播放') {
  ui.playButton.classList.toggle('is-playing', isPlaying);
  ui.playButton.setAttribute('aria-pressed', String(isPlaying));
  ui.playButton.title = label;
  ui.playButton.setAttribute('aria-label', label);
}

function mediaSessionUpdate() {
  if (!('mediaSession' in navigator)) return;
  const book = currentBook();
  navigator.mediaSession.metadata = book && typeof MediaMetadata === 'function' ? new MediaMetadata({title:book.title, artist:'YAF 听书', album:currentChapter(book)?.title || ''}) : null;
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function currentParagraphText() {
  const chapter = currentChapter();
  return chapter?.paragraphs[currentBook().progress.paragraphIndex] || '';
}

async function playParagraph(generation, chunkIndex = 0, batch = null) {
  if (generation !== playGeneration) return;
  const book = currentBook();
  const chapter = currentChapter(book);
  if (!book || !chapter) { stopPlayback(); return; }
  batch ||= getSpeechBatch(chapter, book.progress.paragraphIndex);
  speechRange = {chapterIndex:book.progress.chapterIndex, startIndex:batch.startIndex, endIndex:batch.endIndex};
  renderReader({scroll:followSpeech});
  const text = batch.text || currentParagraphText();
  if (!text) { advanceParagraph(generation); return; }
  const chunks = splitText(text);
  if (chunkIndex >= chunks.length) { advanceParagraph(generation); return; }
  synthController = new AbortController();
  setPlayState(`生成语音 · ${book.progress.paragraphIndex + 1} / ${chapter.paragraphs.length}`);
  try {
    const blob = await synthesize(chunks[chunkIndex], synthController.signal);
    if (generation !== playGeneration) return;
    releaseAudio();
    audio ||= new Audio();
    audioUrl = URL.createObjectURL(blob);
    audio.src = audioUrl;
    audioReady = true;
    audio.playbackRate = Number(ui.speedRange.value);
    audio.ontimeupdate = () => {
      if (generation !== playGeneration || batch.endIndex - batch.startIndex < 2 || !Number.isFinite(audio.duration) || !audio.duration) return;
      const fraction = Math.min(1, audio.currentTime / audio.duration);
      const paragraphIndex = Math.min(batch.endIndex - 1, batch.startIndex + Math.floor(fraction * (batch.endIndex - batch.startIndex)));
      if (paragraphIndex === book.progress.paragraphIndex) return;
      book.progress.paragraphIndex = paragraphIndex;
      if (followSpeech) book.reading = {...book.progress};
      speechRange = {chapterIndex:book.progress.chapterIndex, startIndex:paragraphIndex, endIndex:paragraphIndex + 1};
      renderReader({scroll:followSpeech});
    };
    audio.onended = () => {
      releaseAudio();
      audioReady = false;
      if (chunkIndex + 1 < chunks.length) playParagraph(generation, chunkIndex + 1, batch);
      else advanceParagraph(generation, batch.endIndex - book.progress.paragraphIndex);
    };
    audio.onerror = () => { stopPlayback(); showToast('生成的音频无法播放'); };
    await audio.play();
    setPlayState('正在播放');
    mediaSessionUpdate();
  } catch (error) {
    if (error.name === 'AbortError' || generation !== playGeneration) return;
    if (error.name === 'NotAllowedError' && audioReady) {
      playing = false;
      setPlayButtonState(false, '继续');
      setPlayState('点播放继续');
      mediaSessionUpdate();
      showToast('浏览器阻止自动播放，点播放键继续当前语音', 5000);
      return;
    }
    stopPlayback();
    showToast(error.message || '语音生成失败', 4200);
  }
}

function advanceParagraph(generation, paragraphCount = 1) {
  if (generation !== playGeneration) return;
  const book = currentBook();
  const chapter = currentChapter(book);
  if (!book || !chapter) { stopPlayback(); return; }
  const nextParagraphIndex = Math.min(book.progress.paragraphIndex + paragraphCount, chapter.paragraphs.length);
  if (nextParagraphIndex < chapter.paragraphs.length) {
    book.progress.paragraphIndex = nextParagraphIndex;
    if (followSpeech) book.reading = {...book.progress};
    renderReader({scroll:followSpeech});
    playParagraph(generation);
    return;
  }
  book.progress.paragraphIndex = Math.max(0, chapter.paragraphs.length - 1);
  if (followSpeech) book.reading = {...book.progress};
  if (chapterTimer || book.progress.chapterIndex + 1 >= book.chapters.length) {
    const finishedChapter = chapterTimer;
    stopPlayback();
    setPlayState(finishedChapter ? '本章播放完成' : '全书播放完成');
    return;
  }
  book.progress.chapterIndex++;
  book.progress.paragraphIndex = 0;
  if (followSpeech) book.reading = {...book.progress};
  renderReader({scroll:followSpeech});
  playParagraph(generation);
}

async function play() {
  if (audioReady && audio?.paused) {
    const currentAudio = audio;
    currentAudio.play().then(() => {
      if (audio !== currentAudio) return;
      playing = true;
      setPlayState('正在播放');
      setPlayButtonState(true);
      mediaSessionUpdate();
    }).catch(error => {
      if (error.name !== 'AbortError') showToast('仍无法播放，请检查设备的静音与媒体播放设置');
    });
    return;
  }
  if (!accessToken) { openAuthDialog(); return; }
  const book = currentBook();
  if (!book) { showToast('先导入一本小说'); return; }
  audio ||= new Audio();
  if (!(await checkModel())) { showToast('语音模型暂不可用'); return; }
  clearTimeout(sleepTimeout);
  const timer = ui.sleepTimer.value;
  chapterTimer = timer === 'chapter';
  if (timer !== 'chapter' && Number(timer) > 0) sleepTimeout = setTimeout(() => { stopPlayback(); showToast('定时停止'); }, Number(timer) * 60_000);
  playing = true;
  speechPositionActive = true;
  followSpeech = true;
  book.reading = {...book.progress};
  setPlayButtonState(true);
  renderReader({scroll:true});
  mediaSessionUpdate();
  playParagraph(++playGeneration);
}

function pause() {
  if (!playing) return;
  playing = false;
  if (!audioReady) {
    playGeneration++;
    synthController?.abort();
  }
  if (audio) audio.pause();
  setPlayButtonState(false, '继续');
  setPlayState('已暂停');
  mediaSessionUpdate();
  if (currentBook()) renderReader();
}

function stopPlayback() {
  playing = false;
  speechPositionActive = false;
  playGeneration++;
  synthController?.abort();
  synthController = null;
  speechRange = null;
  releaseAudio(true);
  clearTimeout(sleepTimeout);
  chapterTimer = false;
  setPlayButtonState(false);
  mediaSessionUpdate();
  if (ui.playState) setPlayState('已停止');
  if (currentBook()) renderReader();
}

function jumpToParagraph(index) {
  const book = currentBook();
  const chapter = book?.chapters[book.reading?.chapterIndex ?? book.progress.chapterIndex];
  if (!book || !chapter) return;
  followSpeech = false;
  book.reading = {chapterIndex:book.reading?.chapterIndex ?? book.progress.chapterIndex, paragraphIndex:Math.max(0, Math.min(chapter.paragraphs.length - 1, index))};
  renderReader({scroll:true});
}

function changeChapter(index) {
  const book = currentBook();
  if (!book) return;
  const chapterIndex = Math.max(0, Math.min(book.chapters.length - 1, index));
  followSpeech = false;
  book.reading = {chapterIndex, paragraphIndex:0};
  renderReader({scroll:true});
}

async function startSpeechFromReading() {
  const book = currentBook();
  if (!book) return;
  book.progress = {...book.reading};
  followSpeech = true;
  renderReader({scroll:true});
  if (playing) {
    playGeneration++;
    synthController?.abort();
    releaseAudio(true);
    playParagraph(playGeneration);
  } else {
    releaseAudio(true);
    speechPositionActive = false;
    await play();
  }
}

function returnReaderToSpeech() {
  const book = currentBook();
  if (!book) return;
  followSpeech = true;
  book.reading = {...book.progress};
  renderReader({scroll:true});
}

function moveParagraph(step) {
  const book = currentBook();
  if (!book) return;
  let chapterIndex = book.reading.chapterIndex;
  let paragraphIndex = book.reading.paragraphIndex + step;
  if (paragraphIndex < 0 && chapterIndex > 0) {
    chapterIndex--;
    paragraphIndex = book.chapters[chapterIndex].paragraphs.length - 1;
  } else if (paragraphIndex >= book.chapters[chapterIndex].paragraphs.length && chapterIndex < book.chapters.length - 1) {
    chapterIndex++;
    paragraphIndex = 0;
  }
  followSpeech = false;
  book.reading = {chapterIndex, paragraphIndex};
  renderReader({scroll:true});
}

function moveSpeechParagraph(step) {
  const book = currentBook();
  if (!book) return;
  let chapterIndex = book.progress.chapterIndex;
  let paragraphIndex = book.progress.paragraphIndex + step;
  if (paragraphIndex < 0 && chapterIndex > 0) {
    chapterIndex--;
    paragraphIndex = book.chapters[chapterIndex].paragraphs.length - 1;
  } else if (paragraphIndex >= book.chapters[chapterIndex].paragraphs.length && chapterIndex < book.chapters.length - 1) {
    chapterIndex++;
    paragraphIndex = 0;
  }
  book.progress = {...book.progress, chapterIndex, paragraphIndex};
  if (followSpeech) book.reading = {chapterIndex, paragraphIndex};
  renderReader({scroll:followSpeech});
  if (playing) {
    playGeneration++;
    synthController?.abort();
    releaseAudio(true);
    playParagraph(playGeneration);
  }
}

async function importFile(file) {
  if (!file) return;
  try {
    const isEpub = /\.epub$/i.test(file.name);
    if (isEpub) showToast(`正在读取 ${file.name}…`, 30000);
    const epub = isEpub ? await parseEpubBook(file) : null;
    const content = isEpub ? '' : await file.text();
    const chapters = epub?.chapters || parseBookText(content);
    if (!chapters.some(chapter => chapter.paragraphs.some(paragraph => paragraph.trim()))) throw new Error('文件里没有可读取的正文');
    const book = {
      id:createBookId(), title:epub?.title || file.name.replace(/\.(txt|md|epub)$/i, '') || '未命名小说',
      sourceName:file.name, chapters, coverBlob:epub?.coverBlob || null, progress:{chapterIndex:0, paragraphIndex:0, offset:0}, updatedAt:Date.now()
    };
    await putBook(book);
    books.unshift(book);
    activeBookId = book.id;
    renderReader({scroll:true});
    showToast(`已导入 ${chapters.length} 章，正文只保存在本机`);
  } catch (error) { showToast(`${file.name}: ${error.message || '导入失败，请检查文件格式'}`, 6000); }
  finally { ui.bookFile.value = ''; }
}

async function removeCurrentBook() {
  const book = currentBook();
  if (!book) return;
  stopPlayback();
  await deleteBook(book.id);
  releaseBookCover(book.id);
  await deleteProgress(book.id);
  books = books.filter(item => item.id !== book.id);
  activeBookId = books[0]?.id || null;
  renderReader();
  showToast('已从本机书架移除');
}

async function clearLibrary() {
  if (!books.length) return;
  if (!confirm('清空本机书架和所有阅读进度？')) return;
  stopPlayback();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction([BOOK_STORE, PROGRESS_STORE], 'readwrite');
    transaction.objectStore(BOOK_STORE).clear();
    transaction.objectStore(PROGRESS_STORE).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  books = [];
  for (const id of coverUrlCache.keys()) releaseBookCover(id);
  activeBookId = null;
  renderReader();
}

function registerMediaActions() {
  if (!('mediaSession' in navigator)) return;
  for (const [action, handler] of Object.entries({
    play:() => play(), pause:() => pause(), stop:() => stopPlayback(),
    nexttrack:() => moveSpeechParagraph(1), previoustrack:() => moveSpeechParagraph(-1)
  })) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
  }
}

function bindEvents() {
  ui.bookFile.addEventListener('change', event => importFile(event.target.files?.[0]));
  ui.bookSearch.addEventListener('input', renderLibrary);
  ui.chapterSelect.addEventListener('change', () => changeChapter(Number(ui.chapterSelect.value)));
  ui.readingPauseButton?.addEventListener('click', () => playing && (!audioReady || !audio?.paused) ? pause() : play());
  ui.readFromHereButton?.addEventListener('click', startSpeechFromReading);
  ui.returnToSpeechButton?.addEventListener('click', returnReaderToSpeech);
  ui.previousChapterButton.addEventListener('click', () => changeChapter(currentBook().reading.chapterIndex - 1));
  ui.nextChapterButton.addEventListener('click', () => changeChapter(currentBook().reading.chapterIndex + 1));
  ui.previousParagraphButton.addEventListener('click', () => moveSpeechParagraph(-1));
  ui.nextParagraphButton.addEventListener('click', () => moveSpeechParagraph(1));
  ui.removeBookButton.addEventListener('click', removeCurrentBook);
  ui.clearLibraryButton.addEventListener('click', clearLibrary);
  ui.playButton.addEventListener('click', () => playing && (!audioReady || !audio?.paused) ? pause() : play());
  ui.stopButton.addEventListener('click', stopPlayback);
  ui.accountButton.addEventListener('click', () => userEmail ? logout() : openAuthDialog());
  ui.mobileSettingsButton.addEventListener('click', () => {
    const open = ui.tocPane.dataset.mobileOpen !== 'true';
    ui.tocPane.dataset.mobileOpen = String(open);
    ui.mobileSettingsButton.setAttribute('aria-expanded', String(open));
  });
  ui.settingsCloseButton.addEventListener('click', () => {
    ui.tocPane.dataset.mobileOpen = 'false';
    ui.mobileSettingsButton.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('pointerdown', event => {
    if (ui.tocPane.dataset.mobileOpen === 'true' && !ui.tocPane.contains(event.target) && !ui.mobileSettingsButton.contains(event.target)) {
      ui.tocPane.dataset.mobileOpen = 'false';
      ui.mobileSettingsButton.setAttribute('aria-expanded', 'false');
    }
  });
  ui.authModeButton.addEventListener('click', () => { authMode = authMode === 'login' ? 'signup' : 'login'; updateAuthDialog(); });
  ui.authSubmit.addEventListener('click', submitAuth);
  ui.forgotPasswordButton.addEventListener('click', resetPassword);
  ui.authPassword.addEventListener('keydown', event => { if (event.key === 'Enter') submitAuth(); });
  ui.speedRange.addEventListener('input', () => {
    const speed = Number(ui.speedRange.value);
    ui.speedValue.textContent = `${speed.toFixed(2)}×`;
    ui.playerRate.textContent = `${speed.toFixed(2)}×`;
    if (audio) audio.playbackRate = speed;
  });
  ui.positionRange.addEventListener('change', () => {
    const book = currentBook();
    if (!book) return;
    const target = Number(ui.positionRange.value);
    let seen = 0;
    for (let chapter = 0; chapter < book.chapters.length; chapter++) {
      if (target < seen + book.chapters[chapter].paragraphs.length) {
        book.reading = {chapterIndex:chapter, paragraphIndex:target - seen};
        break;
      }
      seen += book.chapters[chapter].paragraphs.length;
    }
    renderReader({scroll:true});
    if (playing) startSpeechFromReading();
  });
  ui.sleepTimer.addEventListener('change', () => {
    if (!playing) return;
    clearTimeout(sleepTimeout);
    chapterTimer = ui.sleepTimer.value === 'chapter';
    const minutes = Number(ui.sleepTimer.value);
    if (minutes) sleepTimeout = setTimeout(() => { stopPlayback(); showToast('定时停止'); }, minutes * 60_000);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && ui.tocPane.dataset.mobileOpen === 'true') {
      ui.tocPane.dataset.mobileOpen = 'false';
      ui.mobileSettingsButton.setAttribute('aria-expanded', 'false');
      return;
    }
    if (event.target.matches('input,textarea,select,[contenteditable="true"]') || ui.authDialog.open) return;
    if (event.code === 'Space') { event.preventDefault(); playing && (!audioReady || !audio?.paused) ? pause() : play(); }
    if (event.key === 'ArrowRight') moveParagraph(1);
    if (event.key === 'ArrowLeft') moveParagraph(-1);
  });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    ui.installButton.hidden = false;
  });
  ui.installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    ui.installButton.hidden = true;
  });
  window.addEventListener('pagehide', saveCurrentProgress);
}

async function init() {
  bindEvents();
  registerMediaActions();
  db = await openDatabase();
  const [storedBooks, storedProgress] = await Promise.all([loadBooks(), loadProgress()]);
  const progressById = new Map(storedProgress.map(progress => [progress.id, progress]));
  books = storedBooks.map(book => {
    const saved = progressById.get(book.id);
    return saved ? {...book, progress:saved.progress, reading:saved.reading || saved.progress, updatedAt:saved.updatedAt || book.updatedAt} : {...book, reading:book.reading || book.progress};
  }).sort((a,b) => b.updatedAt - a.updatedAt);
  activeBookId = books[0]?.id || null;
  renderReader();
  await Promise.all([loadConfig(), checkModel()]);
  await restoreSession();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('/service-worker.js?v=20261029-mobile-audio-settings-300').catch(() => {});
  }
}

init().catch(error => showToast(error.message || '听书应用启动失败'));
