import { Plugin, Query, Result, Context, PublicAPI, PluginInitParams } from "@wox-launcher/wox-plugin";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";

interface Bookmark {
  title: string;
  url: string;
  tags?: string;
  description?: string;
  source?: string;
}

interface ChromiumBookmark {
  date_added: string;
  date_last_used: string;
  guid: string;
  id: string;
  name: string;
  type: 'url' | 'folder';
  url?: string;
  children?: ChromiumBookmark[];
}

interface ChromiumBookmarks {
  checksum: string;
  roots: {
    bookmark_bar: {
      children: ChromiumBookmark[];
    };
    other: {
      children: ChromiumBookmark[];
    };
    synced: {
      children: ChromiumBookmark[];
    };
  };
}

class SmartBookmarksPlugin implements Plugin {
  private static instance: SmartBookmarksPlugin | null = null;
  private bookmarks: Bookmark[] = [];
  private pluginDir: string = "";
  private initialized: boolean = false;
  private watcher: fs.FSWatcher | null = null;
  private lastCheck: number = 0;
  private readonly CHECK_INTERVAL = 30000; // Default 30 seconds
  private settings: any = {};
  private api: PublicAPI | null = null;

  private getEnabledBrowsers(): Array<'edge' | 'chrome' | 'brave'> {
    const enabledBrowsers = this.settings.enabledBrowsers || 'all';
    
    if (enabledBrowsers === 'all') {
      return ['edge', 'chrome', 'brave'];
    }
    
    return enabledBrowsers.split(',').map((b: string) => b.trim()) as Array<'edge' | 'chrome' | 'brave'>;
  }

  private getRefreshInterval(): number {
    const interval = parseInt(this.settings.refreshInterval || '30');
    return Math.max(interval, 10) * 1000; // Minimum 10 seconds, convert to milliseconds
  }

  private getMaxResults(): number {
    return parseInt(this.settings.maxResults || '20');
  }

  private shouldIncludeLocalBookmarks(): boolean {
    return this.settings.includeLocalBookmarks !== 'false';
  }

  private shouldShowBrowserSource(): boolean {
    return this.settings.showBrowserSource !== 'false';
  }

  private async refreshBookmarks(): Promise<void> {
    try {
      let allBookmarks: Bookmark[] = [];

      // Load local bookmarks if enabled
      if (this.shouldIncludeLocalBookmarks()) {
        const localBookmarksPath = path.join(this.pluginDir, "bookmarks.json");
        
        if (fs.existsSync(localBookmarksPath)) {
          const raw = fs.readFileSync(localBookmarksPath, "utf-8");
          const parsed = JSON.parse(raw);
          const localBookmarks = Array.isArray(parsed) ? parsed : [];
          allBookmarks = allBookmarks.concat(localBookmarks);
          console.log(`[SmartBookmarks] Refreshed ${localBookmarks.length} local bookmarks`);
        }
      }

      // Load browser bookmarks based on settings
      const enabledBrowsers = this.getEnabledBrowsers();
      let browserBookmarks: Bookmark[] = [];
      
      for (const browser of enabledBrowsers) {
        const bookmarks = await this.loadBrowserBookmarks(browser);
        browserBookmarks = browserBookmarks.concat(bookmarks);
      }

      allBookmarks = allBookmarks.concat(browserBookmarks);

      // Update bookmarks
      this.bookmarks = allBookmarks;
      this.lastCheck = Date.now();
      console.log(`[SmartBookmarks] Total bookmarks after refresh: ${this.bookmarks.length}`);
      console.log(`[SmartBookmarks] Enabled browsers:`, enabledBrowsers);
    } catch (error) {
      console.error(`[SmartBookmarks] Error refreshing bookmarks:`, error);
    }
  }

  private async loadBrowserBookmarks(browser: 'edge' | 'chrome' | 'brave'): Promise<Bookmark[]> {
    try {
      const bookmarksPath = this.getBrowserBookmarksPath(browser);
      
      if (!fs.existsSync(bookmarksPath)) {
        console.log(`[SmartBookmarks] ${browser} bookmarks not found at: ${bookmarksPath}`);
        return [];
      }

      const raw = fs.readFileSync(bookmarksPath, "utf-8");
      const parsed = JSON.parse(raw) as ChromiumBookmarks;
      const bookmarks = this.convertChromiumBookmarks(parsed, browser);
      console.log(`[SmartBookmarks] Loaded ${bookmarks.length} ${browser} bookmarks`);
      return bookmarks;
    } catch (error) {
      console.error(`[SmartBookmarks] Error loading ${browser} bookmarks:`, error);
      return [];
    }
  }

  private getBrowserBookmarksPath(browser: 'edge' | 'chrome' | 'brave'): string {
    const localAppData = process.env.LOCALAPPDATA || '';
    
    switch (browser) {
      case 'edge':
        return path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks');
      case 'chrome':
        return path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks');
      case 'brave':
        return path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Bookmarks');
      default:
        return '';
    }
  }

  private setupWatcher(): void {
    try {
      if (this.watcher) {
        this.watcher.close();
      }

      // Watch browser bookmark files based on enabled browsers
      const enabledBrowsers = this.getEnabledBrowsers();
      const watchedPaths: string[] = [];

      enabledBrowsers.forEach(browser => {
        const bookmarksPath = this.getBrowserBookmarksPath(browser);
        if (fs.existsSync(bookmarksPath)) {
          watchedPaths.push(bookmarksPath);
          
          // Create individual watchers for each browser
          fs.watch(bookmarksPath, async (eventType, filename) => {
            if (filename) {
              console.log(`[SmartBookmarks] Detected changes in ${browser} bookmarks`);
              // Add a small delay to ensure the file is fully written
              setTimeout(() => this.refreshBookmarks(), 1000);
            }
          });
        }
      });

      console.log(`[SmartBookmarks] Started watching browser bookmarks:`, watchedPaths);
    } catch (error) {
      console.error(`[SmartBookmarks] Error setting up watcher:`, error);
    }
  }

  private convertChromiumBookmarks(chromiumBookmarks: ChromiumBookmarks, browserName: string): Bookmark[] {
    const results: Bookmark[] = [];
    
    const processBookmarks = (items: ChromiumBookmark[]) => {
      for (const item of items) {
        if (item.type === 'url') {
          const dateAdded = parseInt(item.date_added) / 1000;
          const lastUsed = item.date_last_used !== "0" ? new Date(parseInt(item.date_last_used) / 1000).toLocaleDateString() : "Never";
          
          results.push({
            title: item.name,
            url: item.url!,
            description: `${browserName.charAt(0).toUpperCase() + browserName.slice(1)} • Added: ${new Date(dateAdded).toLocaleDateString()} • Last used: ${lastUsed}`,
            source: browserName
          });
        } else if (item.type === 'folder' && item.children) {
          processBookmarks(item.children);
        }
      }
    };

    // Process all bookmark sections
    processBookmarks(chromiumBookmarks.roots.bookmark_bar.children);
    processBookmarks(chromiumBookmarks.roots.other.children);
    processBookmarks(chromiumBookmarks.roots.synced.children);

    return results;
  }

  private convertEdgeBookmarks(edgeBookmarks: ChromiumBookmarks): Bookmark[] {
    const results: Bookmark[] = [];
    
    const processBookmarks = (items: ChromiumBookmark[]) => {
      for (const item of items) {
        if (item.type === 'url') {
          results.push({
            title: item.name,
            url: item.url!,
            description: `Edge Bookmark - ${new Date(parseInt(item.date_added) / 1000).toLocaleDateString()}`,
            source: 'edge'
          });
        } else if (item.type === 'folder' && item.children) {
          processBookmarks(item.children);
        }
      }
    };

    // Process all bookmark sections
    processBookmarks(edgeBookmarks.roots.bookmark_bar.children);
    processBookmarks(edgeBookmarks.roots.other.children);
    processBookmarks(edgeBookmarks.roots.synced.children);

    return results;
  }

  private constructor() {
    console.log(`[SmartBookmarks] Constructor called`);
    
    // Ensure this is properly initialized
    if (!this) {
      console.error(`[SmartBookmarks] Constructor called with undefined 'this'`);
      return;
    }
    
    // Initialize with empty state to prevent null access
    this.bookmarks = [];
    this.initialized = false;
    this.lastCheck = 0;
    this.watcher = null;

    // Bind methods to this instance
    this.init = this.init.bind(this);
    this.query = this.query.bind(this);
    this.refreshBookmarks = this.refreshBookmarks.bind(this);
    this.openUrl = this.openUrl.bind(this);
    this.action = this.action.bind(this);
    
    console.log(`[SmartBookmarks] Methods bound:`, {
      init: typeof this.init,
      query: typeof this.query,
      openUrl: typeof this.openUrl,
      action: typeof this.action,
      hasThis: !!this
    });
    // Log the current instance state
    console.log(`[SmartBookmarks] Initial state:`, {
      hasInstance: !!SmartBookmarksPlugin.instance,
      bookmarksLength: this.bookmarks.length,
      initialized: this.initialized
    });
  }

  public static getInstance(): SmartBookmarksPlugin {
    if (!SmartBookmarksPlugin.instance) {
      console.log(`[SmartBookmarks] Creating new instance`);
      SmartBookmarksPlugin.instance = new SmartBookmarksPlugin();
    } else {
      console.log(`[SmartBookmarks] Returning existing instance`);
    }
    return SmartBookmarksPlugin.instance;
  }

  async init(ctx: Context, params: PluginInitParams): Promise<void> {
    try {
      if (!params.PluginDirectory) {
        throw new Error("PluginDirectory not provided in init params");
      }
      
      this.pluginDir = params.PluginDirectory;
      this.api = params.API;
      
      // Load settings
      if (this.api) {
        this.settings = {
          enabledBrowsers: await this.api.GetSetting(ctx, "enabledBrowsers") || "all",
          refreshInterval: await this.api.GetSetting(ctx, "refreshInterval") || "30",
          maxResults: await this.api.GetSetting(ctx, "maxResults") || "20",
          includeLocalBookmarks: await this.api.GetSetting(ctx, "includeLocalBookmarks") || "true",
          showBrowserSource: await this.api.GetSetting(ctx, "showBrowserSource") || "true"
        };
      }
      
      console.log(`[SmartBookmarks] Initializing with settings:`, this.settings);
      
      const localBookmarksPath = path.join(this.pluginDir, "bookmarks.json");
      console.log(`[SmartBookmarks] Initializing with plugin directory: ${this.pluginDir}`);
      
      // Load local bookmarks
      let localBookmarks: Bookmark[] = [];
      console.log(`[SmartBookmarks] Looking for local bookmarks at: ${localBookmarksPath}`);
      if (fs.existsSync(localBookmarksPath)) {
        const raw = fs.readFileSync(localBookmarksPath, "utf-8");
        const parsed = JSON.parse(raw);
        localBookmarks = Array.isArray(parsed) ? parsed : [];
        console.log(`[SmartBookmarks] Loaded ${localBookmarks.length} local bookmarks`);
      }

      // Load browser bookmarks
      let browserBookmarks: Bookmark[] = [];
      
      // Edge bookmarks
      const edgeBookmarks = await this.loadBrowserBookmarks('edge');
      browserBookmarks = browserBookmarks.concat(edgeBookmarks);
      
      // Chrome bookmarks
      const chromeBookmarks = await this.loadBrowserBookmarks('chrome');
      browserBookmarks = browserBookmarks.concat(chromeBookmarks);
      
      // Brave bookmarks
      const braveBookmarks = await this.loadBrowserBookmarks('brave');
      browserBookmarks = browserBookmarks.concat(braveBookmarks);

      // Combine bookmarks from both sources
      this.bookmarks = [...localBookmarks, ...browserBookmarks];
      console.log(`[SmartBookmarks] Total bookmarks loaded: ${this.bookmarks.length}`);
      console.log(`[SmartBookmarks] Sources: Local=${localBookmarks.length}, Edge=${edgeBookmarks.length}, Chrome=${chromeBookmarks.length}, Brave=${braveBookmarks.length}`);
      
      // Set up file watcher for Edge bookmarks
      this.setupWatcher();
      
      this.initialized = true;
      this.lastCheck = Date.now();
      console.log(`[SmartBookmarks] Initialization complete, initialized = ${this.initialized}`);
    } catch (error) {
      console.error(`[SmartBookmarks] Error in init:`, error);
      this.bookmarks = [];
      this.initialized = false;
      throw error;
    }
  }

  async query(ctx: Context, query: Query): Promise<Result[]> {
    try {
      // Check if we need to refresh bookmarks based on settings
      const refreshInterval = this.getRefreshInterval();
      const now = Date.now();
      if (now - this.lastCheck > refreshInterval) {
        console.log(`[SmartBookmarks] Checking for bookmark updates...`);
        await this.refreshBookmarks();
      }

      console.log(`[SmartBookmarks] Query received: "${query.Search}"`);
      console.log(`[SmartBookmarks] Plugin state:`, {
        initialized: this.initialized,
        bookmarksLength: this.bookmarks.length,
        pluginDir: this.pluginDir,
        lastCheck: new Date(this.lastCheck).toISOString(),
        settings: this.settings
      });

      if (!this.initialized) {
        console.warn(`[SmartBookmarks] Plugin not initialized yet`);
        return [{
          Title: "Plugin not initialized yet",
          SubTitle: "Please wait or restart Wox",
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 0
        }];
      }

      const term = query.Search.toLowerCase();
      const maxResults = this.getMaxResults();
      const showBrowserSource = this.shouldShowBrowserSource();
      
      return this.bookmarks
        .filter(bm =>
          bm.title.toLowerCase().includes(term) ||
          (bm.tags && bm.tags.toLowerCase().includes(term)) ||
          (bm.source && bm.source.toLowerCase().includes(term))
        )
        .slice(0, maxResults)
        .map(bm => ({
          Title: bm.title,
          SubTitle: showBrowserSource ? 
            (bm.description || `${bm.url} ${bm.source ? `• ${bm.source.toUpperCase()}` : ''}`) :
            (bm.description || bm.url),
          Icon: { ImageType: "relative", ImageData: this.getBrowserIcon(bm.source) },
          Score: 100,
          Actions: [{
            Name: "Open in Browser",
            Action: async (context: any) => {
              console.log(`[SmartBookmarks] Action triggered for URL: ${bm.url}`);
              this.openUrlDirectly(bm.url);
            }
          }]
        }));
    } catch (error) {
      console.error(`[SmartBookmarks] Error in query:`, error);
      return [{
        Title: "Error occurred while searching bookmarks",
        SubTitle: error instanceof Error ? error.message : String(error),
        Icon: { ImageType: "relative", ImageData: "icon.png" },
        Score: 0
      }];
    }
  }

  async openUrl(ctx: Context, ...params: any[]): Promise<void> {
    try {
      const url = params[0] as string;
      console.log(`[SmartBookmarks] Opening URL: ${url} (params:`, params, `)`);
      
      if (!url) {
        console.error(`[SmartBookmarks] No URL provided to openUrl method`);
        return;
      }
      
      this.openUrlDirectly(url);
    } catch (error) {
      console.error(`[SmartBookmarks] Error in openUrl:`, error);
    }
  }

  private getBrowserIcon(source?: string): string {
    switch (source) {
      case 'edge':
        return 'icon.png'; // يمكن إضافة أيقونة Edge مخصصة
      case 'chrome':
        return 'icon.png'; // يمكن إضافة أيقونة Chrome مخصصة
      case 'brave':
        return 'icon.png'; // يمكن إضافة أيقونة Brave مخصصة
      default:
        return 'icon.png';
    }
  }

  private openUrlDirectly(url: string): void {
    try {
      console.log(`[SmartBookmarks] Opening URL directly: ${url}`);
      
      // Use Windows 'start' command to open URL in default browser
      exec(`start "" "${url}"`, (error, stdout, stderr) => {
        if (error) {
          console.error(`[SmartBookmarks] Error opening URL: ${error.message}`);
          return;
        }
        if (stderr) {
          console.error(`[SmartBookmarks] stderr: ${stderr}`);
          return;
        }
        console.log(`[SmartBookmarks] Successfully opened URL: ${url}`);
      });
    } catch (error) {
      console.error(`[SmartBookmarks] Error in openUrlDirectly:`, error);
    }
  }

  async action(ctx: Context, result: any): Promise<void> {
    try {
      const url = result.ContextData;
      console.log(`[SmartBookmarks] Action called with URL: ${url}`);
      
      if (!url) {
        console.error(`[SmartBookmarks] No URL in ContextData`);
        return;
      }
      
      // Use Windows 'start' command to open URL in default browser
      exec(`start "" "${url}"`, (error, stdout, stderr) => {
        if (error) {
          console.error(`[SmartBookmarks] Error opening URL: ${error.message}`);
          return;
        }
        if (stderr) {
          console.error(`[SmartBookmarks] stderr: ${stderr}`);
          return;
        }
        console.log(`[SmartBookmarks] Successfully opened URL: ${url}`);
      });
    } catch (error) {
      console.error(`[SmartBookmarks] Error in action:`, error);
    }
  }
}

// Export plugin functions directly instead of a singleton instance
const pluginInstance = SmartBookmarksPlugin.getInstance();

export const plugin = {
  init: async (ctx: Context, params: PluginInitParams) => {
    return await pluginInstance.init(ctx, params);
  },
  query: async (ctx: Context, query: Query) => {
    return await pluginInstance.query(ctx, query);
  },
  action: async (ctx: Context, result: any) => {
    return await pluginInstance.action(ctx, result);
  },
  openUrl: async (ctx: Context, ...params: any[]) => {
    return await pluginInstance.openUrl(ctx, ...params);
  }
};
