import { homeStorage } from './home-storage.mjs';

export const storage = homeStorage({
  url: process.env.HOME_STORAGE_URL || 'http://127.0.0.1:9100',
  project: process.env.HOME_STORAGE_PROJECT || 'fc-inspect',
  key: process.env.HOME_STORAGE_KEY,
});
