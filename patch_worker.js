import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('src/download/worker.js', 'utf8');

const importAdd = `
import { setChapterQuality } from '../core/repo.js';
import { recordChapterSuccess, recordChapterFailure } from '../core/provider-stats.js';
`;
content = content.replace(/import \{ cleanupStaging, bindChapter, bindVolume, notifyBindery, notifyError, resolveVolumes \} from '\.\.\/core\/binder\.js';/, "import { cleanupStaging, bindChapter, bindVolume, notifyBindery, notifyError, resolveVolumes } from '../core/binder.js';" + importAdd);

const successAdd = `
        setChapterState(ch.id, 'downloaded', { staging_path: dir, pages: pageCount, prog_done: pageCount, prog_total: pageCount });
        if (scanQuality && scanQuality !== 'unknown') {
          setChapterQuality(ch.id, scanQuality, minPageWidth);
          recordChapterSuccess(activeProvider.name, scanQuality);
        } else if (pageCount && typeof scanQuality === 'undefined') {
          // Fallback or archive downloads may not have calculated this.
          // The spec implies only downloader.js computes it directly now.
        }
`;

content = content.replace(/let dir, pageCount;/, `let dir, pageCount, scanQuality, minPageWidth;`);
content = content.replace(/ \(\{ dir, pageCount \} = await downloadArchiveChapter/g, ` ({ dir, pageCount } = await downloadArchiveChapter`);
content = content.replace(/ \(\{ dir, pageCount \} = await downloadChapter/g, ` ({ dir, pageCount, scanQuality, minPageWidth } = await downloadChapter`);
content = content.replace(/ \(\{ dir, pageCount \} = await downloadChapterViaFallback/g, ` ({ dir, pageCount, scanQuality, minPageWidth } = await downloadChapterViaFallback`);

content = content.replace(/setChapterState\(ch\.id, 'downloaded', \{ staging_path: dir, pages: pageCount, prog_done: pageCount, prog_total: pageCount \}\);/g, `setChapterState(ch.id, 'downloaded', { staging_path: dir, pages: pageCount, prog_done: pageCount, prog_total: pageCount });
        if (scanQuality) {
          setChapterQuality(ch.id, scanQuality, minPageWidth);
          recordChapterSuccess(activeProvider.name, scanQuality);
        }
`);

const failureAdd = `
          setChapterState(ch.id, exhausted ? 'failed' : 'wanted', { error: errMsg, prog_done: null, prog_total: null });
          logHistory('chapter.failed', { seriesId: series.id, chapterId: ch.id, message: errMsg });
          if (exhausted) {
             notifyError(series.title, \`Chapter \${ch.number}\`, errMsg);
             recordChapterFailure(activeProvider.name, errMsg);
          }
`;

content = content.replace(/setChapterState\(ch\.id, exhausted \? 'failed' : 'wanted', \{ error: errMsg, prog_done: null, prog_total: null \}\);\n          logHistory\('chapter\.failed', \{ seriesId: series\.id, chapterId: ch\.id, message: errMsg \}\);\n          if \(exhausted\) notifyError\(series\.title, `Chapter \$\{ch\.number\}`, errMsg\);/g, failureAdd.trim());


writeFileSync('src/download/worker.js', content);
