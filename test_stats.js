import { getDb, closeDb } from './src/core/db.js';
import { recordChapterSuccess, recordChapterFailure, getProviderStats } from './src/core/provider-stats.js';

recordChapterSuccess('test_prov', 'high');
console.log(getProviderStats('test_prov'));
recordChapterFailure('test_prov', 'Error 1');
console.log(getProviderStats('test_prov'));

closeDb();
