import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as sqlite3 from "sqlite3";
import { Browser, Bookmark, ChromiumBookmarks, ChromiumBookmark } from "./interfaces";
import { Logger } from "./logger";

export class BrowserManager {
  private statsReset: boolean = false;

  constructor() {}

  setStatsReset(reset: boolean): void {
    this.statsReset = reset;
  }

  getBrowserBookmarksPaths(browser: Browser): string[] {
    const home = os.homedir();
    let baseProfileDir: string;
    let pattern: RegExp;
    let filename: string;
    let results: string[] = [];

    switch (browser) {
      case 'chrome':
        baseProfileDir = path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
        pattern = /^Default$|^Profile \d+$/;
        filename = 'Bookmarks';
        break;
      case 'edge':
        baseProfileDir = path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data');
        pattern = /^Default$|^Profile \d+$/;
        filename = 'Bookmarks';
        break;
      case 'brave':
        baseProfileDir = path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data');
        pattern = /^Default$|^Profile \d+$/;
        filename = 'Bookmarks';
        break;
      case 'firefox':
        baseProfileDir = path.join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles');
        pattern = /default-release$|default-esr$|default$/;
        filename = 'places.sqlite';
        break;
      default:
        return [];
    }

    if (!fs.existsSync(baseProfileDir)) {
      Logger.log(`${browser} base directory not found: ${baseProfileDir}`);
      return [];
    }

    const dirs = fs.readdirSync(baseProfileDir, { withFileTypes: true });
    Logger.log(`Found ${browser} profiles:`, dirs.filter(d => d.isDirectory()).map(d => d.name));

    dirs.forEach(dir => {
      if (!dir.isDirectory()) return;
      if (!pattern.test(dir.name)) return;

      const filePath = path.join(baseProfileDir, dir.name, filename);
      if (fs.existsSync(filePath)) {
        results.push(filePath);
        Logger.log(`Found ${browser} bookmark file: ${filePath}`);
      }
    });

    return results;
  }

  async loadBrowserBookmarks(browser: Browser): Promise<Bookmark[]> {
    try {
      const bookmarkPaths = this.getBrowserBookmarksPaths(browser);
      
      if (bookmarkPaths.length === 0) {
        Logger.log(`No ${browser} bookmark files found`);
        return [];
      }

      let allBookmarks: Bookmark[] = [];

      for (const bookmarkPath of bookmarkPaths) {
        try {
          if (browser === 'firefox') {
            const firefoxBookmarks = await this.loadFirefoxBookmarks(bookmarkPath);
            allBookmarks = allBookmarks.concat(firefoxBookmarks);
          } else {
            const raw = fs.readFileSync(bookmarkPath, "utf-8");
            const parsed = JSON.parse(raw) as ChromiumBookmarks;
            const bookmarks = this.convertChromiumBookmarks(parsed, browser);
            allBookmarks = allBookmarks.concat(bookmarks);
          }
        } catch (error) {
          Logger.error(`Error loading bookmarks from ${bookmarkPath}:`, error);
        }
      }

      Logger.log(`Loaded ${allBookmarks.length} ${browser} bookmarks from ${bookmarkPaths.length} profiles`);
      return allBookmarks;
    } catch (error) {
      Logger.error(`Error loading ${browser} bookmarks:`, error);
      return [];
    }
  }

  private async loadFirefoxBookmarks(placesPath: string): Promise<Bookmark[]> {
    return new Promise((resolve) => {
      if (!placesPath || !fs.existsSync(placesPath)) {
        Logger.log(`Firefox places.sqlite not found at: ${placesPath}`);
        resolve([]);
        return;
      }
      
      const bookmarks: Bookmark[] = [];
      const db = new sqlite3.Database(placesPath, sqlite3.OPEN_READONLY, (err: Error | null) => {
        if (err) {
          Logger.error(`Error opening Firefox database:`, err);
          resolve([]);
          return;
        }
        
        const query = `
          SELECT 
            b.title,
            p.url,
            b.dateAdded,
            b.lastModified,
            p.visit_count,
            p.last_visit_date,
            f.title as folder_title
          FROM moz_bookmarks b
          JOIN moz_places p ON b.fk = p.id
          LEFT JOIN moz_bookmarks f ON b.parent = f.id
          WHERE b.type = 1 
            AND p.url IS NOT NULL 
            AND p.url NOT LIKE 'place:%'
            AND b.title IS NOT NULL
          ORDER BY b.dateAdded DESC
        `;
        
        db.all(query, [], (err: Error | null, rows: any[]) => {
          if (err) {
            Logger.error(`Error querying Firefox bookmarks:`, err);
            resolve([]);
            return;
          }
          
          rows.forEach(row => {
            const dateAdded = row.dateAdded ? new Date(row.dateAdded / 1000).toISOString() : new Date().toISOString();
            const lastUsed = row.last_visit_date && row.last_visit_date > 0 ? new Date(row.last_visit_date / 1000).toISOString() : "Never";
            
            let domain = '';
            try {
              const urlObj = new URL(row.url);
              domain = urlObj.hostname.replace('www.', '');
            } catch (e) {
              domain = row.url.split('/')[2] || '';
            }
            
            bookmarks.push({
              title: row.title || 'Untitled',
              url: row.url,
              description: '',
              source: 'firefox',
              visitCount: row.visit_count || 0,
              lastUsed: this.statsReset ? "Never" : lastUsed,
              dateAdded: dateAdded,
              folder: row.folder_title || 'Other Bookmarks',
              tags: `firefox ${domain} ${row.folder_title || ''}`.toLowerCase(),
              domain: domain
            });
          });
          
          Logger.log(`Loaded ${bookmarks.length} Firefox bookmarks from ${placesPath}`);
          resolve(bookmarks);
        });
        
        db.close();
      });
    });
  }

  private convertChromiumBookmarks(chromiumBookmarks: ChromiumBookmarks, browserName: string): Bookmark[] {
    const results: Bookmark[] = [];
    
    const processBookmarks = (items: ChromiumBookmark[], folderPath: string = '') => {
      for (const item of items) {
        if (item.type === 'url') {
          const chromeEpochDiff = 11644473600;
          const dateAddedMs = parseInt(item.date_added) / 1000 - chromeEpochDiff * 1000;
          const lastUsedMs = item.date_last_used !== "0" ? (parseInt(item.date_last_used) / 1000 - chromeEpochDiff * 1000) : 0;
          const lastUsed = lastUsedMs > 0 ? new Date(lastUsedMs).toISOString() : "Never";
          
          let domain = '';
          try {
            const urlObj = new URL(item.url!);
            domain = urlObj.hostname.replace('www.', '');
          } catch (e) {
            domain = item.url!.split('/')[2] || '';
          }

          results.push({
            title: item.name,
            url: item.url!,
            description: '',
            source: browserName,
            visitCount: 0,
            lastUsed: this.statsReset ? "Never" : lastUsed,
            dateAdded: new Date(dateAddedMs).toISOString(),
            folder: folderPath,
            tags: `${browserName} ${domain} ${folderPath}`.toLowerCase(),
            domain: domain
          });
        } else if (item.type === 'folder' && item.children) {
          const newFolderPath = folderPath ? `${folderPath}/${item.name}` : item.name;
          processBookmarks(item.children, newFolderPath);
        }
      }
    };

    processBookmarks(chromiumBookmarks.roots.bookmark_bar.children, 'Bookmarks Bar');
    processBookmarks(chromiumBookmarks.roots.other.children, 'Other Bookmarks');
    processBookmarks(chromiumBookmarks.roots.synced.children, 'Mobile Bookmarks');

    return results;
  }

  setupWatcher(enabledBrowsers: Browser[], onFileChange: () => void): void {
    try {
      // Watch browser bookmark files based on enabled browsers
      const watchedPaths: string[] = [];

      enabledBrowsers.forEach(browser => {
        const bookmarkPaths = this.getBrowserBookmarksPaths(browser);
        
        bookmarkPaths.forEach(bookmarkPath => {
          if (fs.existsSync(bookmarkPath)) {
            watchedPaths.push(bookmarkPath);
            
            // Create individual watchers for each bookmark file
            fs.watch(bookmarkPath, async (eventType, filename) => {
              if (filename) {
                Logger.log(`Detected changes in ${browser} bookmarks: ${bookmarkPath}`);
                // Add a small delay to ensure the file is fully written
                setTimeout(onFileChange, 1000);
              }
            });
          }
        });
      });

      Logger.log(`Started watching bookmark files:`, watchedPaths);
    } catch (error) {
      Logger.error(`Error setting up watcher:`, error);
    }
  }
}
