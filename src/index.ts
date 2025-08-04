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
  visitCount?: number;
  lastUsed?: string;
  dateAdded?: string;
  folder?: string;
  domain?: string;
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
  private statsReset: boolean = false; // Track if stats have been reset

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

  private calculateScore(bookmark: Bookmark, searchTerm: string): number {
    if (!searchTerm || searchTerm.trim() === '') return 50;
    
    const term = searchTerm.toLowerCase().trim();
    const title = bookmark.title.toLowerCase();
    const url = bookmark.url.toLowerCase();
    const description = (bookmark.description || '').toLowerCase();
    const tags = (bookmark.tags || '').toLowerCase();
    const source = (bookmark.source || '').toLowerCase();
    
    let score = 0;

    // 🔥 Special bonus for browser-specific searches
    const browserSearchBonus = this.getBrowserSearchBonus(term, source);
    score += browserSearchBonus;

    // 🎯 Exact title match (highest score)
    if (title === term) score += 1000;
    else if (title.includes(term)) {
      // Match at beginning of title
      if (title.startsWith(term)) score += 800;
      // Whole word match
      else if (title.includes(` ${term} `) || title.includes(` ${term}`)) score += 600;
      // Partial match
      else score += 400;
    }

    // 🔗 URL matching
    if (url.includes(term)) {
      // Domain matching (high priority)
      const domain = url.replace(/^https?:\/\//, '').split('/')[0];
      if (domain.includes(term)) score += 300;
      else score += 150;
    }

    // 📝 Description matching
    if (description.includes(term)) score += 200;

    // 🏷️ Tags matching
    if (tags.includes(term)) score += 250;

    // 🌐 Browser source matching
    if (source.includes(term)) score += 100;

    // 📊 Additional factors for smart sorting
    
    // Visit frequency
    const visitCount = bookmark.visitCount || 0;
    if (visitCount > 0) {
      score += Math.min(visitCount * 2, 100); // Max 100 points for visits
    }

    // Recency of use
    if (bookmark.lastUsed && bookmark.lastUsed !== "0" && bookmark.lastUsed !== "Never") {
      try {
        const lastUsedDate = new Date(bookmark.lastUsed);
        const daysSinceUsed = (Date.now() - lastUsedDate.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceUsed < 1) score += 80;        // Used today
        else if (daysSinceUsed < 7) score += 60;   // Used this week
        else if (daysSinceUsed < 30) score += 40;  // Used this month
        else if (daysSinceUsed < 90) score += 20;  // Used within 3 months
      } catch (e) {
        // Ignore date parsing errors
      }
    }

    // Title length (shorter titles are usually better)
    if (title.length < 30) score += 10;
    else if (title.length > 100) score -= 10;

    // Site type (popular sites)
    const popularSites = ['github', 'stackoverflow', 'google', 'youtube', 'facebook', 'twitter', 'linkedin'];
    for (const site of popularSites) {
      if (url.includes(site)) {
        score += 30;
        break;
      }
    }

    // 🚫 Reduce priority for local bookmarks when searching for specific browser
    if (!bookmark.source && this.isSearchingForSpecificBrowser(term)) {
      score = Math.max(score - 500, 1); // Significant score reduction
    }

    return Math.max(score, 1); // ضمان وجود نقطة واحدة على الأقل
  }

  private getBrowserSearchBonus(searchTerm: string, bookmarkSource: string): number {
    const term = searchTerm.toLowerCase();
    const source = bookmarkSource.toLowerCase();
    
    // If search includes browser name and bookmark is from same browser
    if ((term.includes('chrome') && source === 'chrome') ||
        (term.includes('edge') && source === 'edge') ||
        (term.includes('brave') && source === 'brave')) {
      return 2000; // Very high bonus
    }
    
    return 0;
  }

  private isSearchingForSpecificBrowser(searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    return term.includes('chrome') || term.includes('edge') || term.includes('brave');
  }

  private smartSearch(searchTerm: string): Array<{bookmark: Bookmark, score: number}> {
    if (!searchTerm || searchTerm.trim() === '') {
      // If no search term, show most recently used
      return this.bookmarks
        .sort((a, b) => {
          const aLastUsed = a.lastUsed && a.lastUsed !== "0" && a.lastUsed !== "Never" ? new Date(a.lastUsed).getTime() : 0;
          const bLastUsed = b.lastUsed && b.lastUsed !== "0" && b.lastUsed !== "Never" ? new Date(b.lastUsed).getTime() : 0;
          return bLastUsed - aLastUsed;
        })
        .slice(0, this.getMaxResults())
        .map(bookmark => ({ bookmark, score: 50 })); // Default score for no search
    }

    const term = searchTerm.toLowerCase().trim();
    const maxResults = this.getMaxResults();

    // Apply search and sorting
    return this.bookmarks
      .map(bookmark => ({
        bookmark,
        score: this.calculateScore(bookmark, term)
      }))
      .filter(item => item.score > 0) // Only results with positive scores
      .sort((a, b) => b.score - a.score) // Sort descending by score
      .slice(0, maxResults);
  }

  private shouldIncludeLocalBookmarks(): boolean {
    return this.settings.includeLocalBookmarks !== 'false';
  }

  private shouldShowBrowserSource(): boolean {
    return this.settings.showBrowserSource !== 'false';
  }

  private shouldShowDomain(): boolean {
    return this.settings.showDomain !== 'false';
  }

  private shouldShowDateAdded(): boolean {
    return this.settings.showDateAdded !== 'false';
  }

  private shouldShowLastUsed(): boolean {
    return this.settings.showLastUsed !== 'false';
  }

  private shouldShowScore(): boolean {
    return this.settings.showScore === 'true';
  }

  private buildDynamicDescription(bookmark: Bookmark, actionDesc: string, score?: number): string {
    const parts: string[] = [];
    
    // Add browser source if enabled
    if (this.shouldShowBrowserSource() && bookmark.source) {
      parts.push(`${bookmark.source.charAt(0).toUpperCase() + bookmark.source.slice(1)}`);
    }
    
    // Add domain if enabled
    if (this.shouldShowDomain() && bookmark.domain) {
      parts.push(bookmark.domain);
    }
    
    // Add date added if enabled
    if (this.shouldShowDateAdded() && bookmark.dateAdded) {
      const dateAdded = new Date(bookmark.dateAdded).toLocaleDateString();
      parts.push(`Added: ${dateAdded}`);
    }
    
    // Add last used if enabled
    if (this.shouldShowLastUsed() && bookmark.lastUsed) {
      if (bookmark.lastUsed === "Never") {
        parts.push(`Last used: Never`);
      } else {
        const lastUsedDate = new Date(bookmark.lastUsed).toLocaleDateString();
        parts.push(`Last used: ${lastUsedDate}`);
      }
    }
    
    // Add score if enabled and provided
    if (this.shouldShowScore() && score !== undefined) {
      parts.push(`Score: ${score}`);
    }
    
    // If no parts, show action description and URL
    if (parts.length === 0) {
      return `${actionDesc}: ${bookmark.url}`;
    }
    
    return parts.join(' • ');
  }

  private async loadSettings(ctx: Context): Promise<void> {
    if (this.api) {
      this.settings = {
        enabledBrowsers: await this.api.GetSetting(ctx, "enabledBrowsers") || "all",
        refreshInterval: await this.api.GetSetting(ctx, "refreshInterval") || "30",
        maxResults: await this.api.GetSetting(ctx, "maxResults") || "20",
        includeLocalBookmarks: await this.api.GetSetting(ctx, "includeLocalBookmarks") || "true",
        showBrowserSource: await this.api.GetSetting(ctx, "showBrowserSource") || "true",
        showDomain: await this.api.GetSetting(ctx, "showDomain") || "true",
        showDateAdded: await this.api.GetSetting(ctx, "showDateAdded") || "true",
        showLastUsed: await this.api.GetSetting(ctx, "showLastUsed") || "true",
        showScore: await this.api.GetSetting(ctx, "showScore") || "false",
        customicons: await this.api.GetSetting(ctx, "customicons") || "[]"
      };
    } else {
      // Fallback to default settings if API is not available
      this.settings = {
        enabledBrowsers: "all",
        refreshInterval: "30",
        maxResults: "20",
        includeLocalBookmarks: "true",
        showBrowserSource: "true",
        showDomain: "true",
        showDateAdded: "true",
        showLastUsed: "true",
        showScore: "false",
        customicons: "[]"
      };
    }
    
    console.log(`[SmartBookmarks] Settings loaded:`, this.settings);
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
    
    const processBookmarks = (items: ChromiumBookmark[], folderPath: string = '') => {
      for (const item of items) {
        if (item.type === 'url') {
          const chromeEpochDiff = 11644473600;
          const dateAddedMs = parseInt(item.date_added) / 1000 - chromeEpochDiff * 1000;
          const lastUsedMs = item.date_last_used !== "0" ? (parseInt(item.date_last_used) / 1000 - chromeEpochDiff * 1000) : 0;
          const lastUsed = lastUsedMs > 0 ? new Date(lastUsedMs).toISOString() : "Never";
          
          // Extract domain name from URL
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
            description: '', // Will be built dynamically based on settings
            source: browserName,
            visitCount: 0, // Chrome doesn't store visit count in bookmarks, and reset if stats cleared
            lastUsed: this.statsReset ? "Never" : lastUsed,
            dateAdded: new Date(dateAddedMs).toISOString(),
            folder: folderPath,
            tags: `${browserName} ${domain} ${folderPath}`.toLowerCase(),
            domain: domain // Store domain separately for easy access
          });
        } else if (item.type === 'folder' && item.children) {
          const newFolderPath = folderPath ? `${folderPath}/${item.name}` : item.name;
          processBookmarks(item.children, newFolderPath);
        }
      }
    };

      // Process all bookmark sections
      processBookmarks(chromiumBookmarks.roots.bookmark_bar.children, 'Bookmarks Bar');
      processBookmarks(chromiumBookmarks.roots.other.children, 'Other Bookmarks');
      processBookmarks(chromiumBookmarks.roots.synced.children, 'Mobile Bookmarks');

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
    this.copyUrlToClipboard = this.copyUrlToClipboard.bind(this);
    this.openUrlInIncognito = this.openUrlInIncognito.bind(this);
    
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
      await this.loadSettings(ctx);
      
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
      // Reload settings every time to get latest changes
      await this.loadSettings(ctx);
      
      // Check if we need to refresh bookmarks based on settings
      const refreshInterval = this.getRefreshInterval();
      const now = Date.now();
      if (now - this.lastCheck > refreshInterval) {
        console.log(`[SmartBookmarks] Checking for bookmark updates...`);
        await this.refreshBookmarks();
      }

      let searchTerm = query.Search.toLowerCase();
      const maxAllowedResults = this.getMaxResults();

      // Handle folder-specific commands
      const folderSearchQuery = query.Search.toLowerCase();

      // Handle folder-specific commands
      if (folderSearchQuery.startsWith('folder:')) {
        const folderTerm = folderSearchQuery.substring(7).trim();

        if (!folderTerm) {
          // If no folder specified, list all available folders
          const folders = this.getAvailableFolders();
          return folders.map(folder => ({
            Title: `📁 ${folder}`,
            SubTitle: `Search bookmarks in folder: ${folder}`,
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000,
            ContextData: JSON.stringify({ folder })
          }));
        }

        // Split folder term and additional search term
        const [folderName, ...additionalTerms] = folderTerm.split(' ');
        const folderNameLower = folderName.toLowerCase();
        const additionalSearchTerm = additionalTerms.join(' ').toLowerCase();

        // إذا كان هناك تطابق جزئي أو كامل مع اسم المجلد، اعرض المفضلات داخله
        const filteredBookmarks = this.bookmarks.filter(bm => 
            bm.folder && bm.folder.toLowerCase().includes(folderNameLower) &&
            (!additionalSearchTerm || bm.title.toLowerCase().includes(additionalSearchTerm))
        );

        // إذا لم يوجد أي مفضلة، اعرض اقتراحات المجلدات المطابقة
        if (filteredBookmarks.length === 0) {
            const matchingFolders = this.getAvailableFolders().filter(folder => 
                folder.toLowerCase().includes(folderTerm.toLowerCase())
            );
            if (matchingFolders.length > 0) {
                return matchingFolders.map(folder => ({
                  Title: `📁 ${folder}`,
                  SubTitle: `Search bookmarks in folder: ${folder}`,
                  Icon: { ImageType: "relative", ImageData: "icon.png" },
                  Score: 1000,
                  ContextData: JSON.stringify({ folder })
                }));
            }
        }

        return filteredBookmarks
            .map((bm, index) => ({
                Title: bm.title,
                SubTitle: this.buildDynamicDescription(bm, 'Open', this.calculateScore(bm, additionalSearchTerm)),
                Icon: this.getDynamicIcon(bm),
                Score: 1000 - index,
                ContextData: JSON.stringify({
                    url: bm.url,
                    title: bm.title,
                    folder: bm.folder
                }),
                Actions: [{
                    Name: 'Open',
                    Action: async () => this.openUrlDirectly(bm.url)
                }]
            }));
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
      
      // Handle action-specific commands
      let actionType = 'open';
      
      if (term.startsWith('o ')) {
        actionType = 'open';
        searchTerm = query.Search.substring(2); // Remove 'o '
      } else if (term.startsWith('c ')) {
        actionType = 'copy';
        searchTerm = query.Search.substring(2); // Remove 'c '
      } else if (term.startsWith('i ')) {
        actionType = 'incognito';
        searchTerm = query.Search.substring(2); // Remove 'i '
      }
      
      // Special commands
      if (term === 'reload' || term === 'refresh') {
        await this.loadSettings(ctx);
        await this.refreshBookmarks();
        return [{
          Title: "Settings and Bookmarks Reloaded",
          SubTitle: `Loaded ${this.bookmarks.length} bookmarks with current settings`,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }
      
      if (term === 'settings' || term === 'config') {
        return [{
          Title: "Current Settings",
          SubTitle: `Browsers: ${this.settings.enabledBrowsers} | Interval: ${this.settings.refreshInterval}s | Max: ${this.settings.maxResults}`,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }

      if (term === 'help' || term === '?') {
        return [{
          Title: "Smart Bookmarks Help",
          SubTitle: "Usage: 'bm [term]' = Open | 'bm o [term]' = Open | 'bm c [term]' = Copy | 'bm i [term]' = Incognito",
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }
      
      // Show usage examples if only action prefix is entered
      if (term === 'o' || term === 'c' || term === 'i') {
        const actionNames = {
          'o': '🌐 Open in Browser',
          'c': '📋 Copy URL',
          'i': '🕵️ Open in Incognito'
        };
        
        return [{
          Title: `${actionNames[term as keyof typeof actionNames]} - Enter search term`,
          SubTitle: `Type 'bm ${term} [search term]' to search and ${actionNames[term as keyof typeof actionNames].toLowerCase()}`,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }
      
      // Use new smart search
      const searchResults = this.smartSearch(searchTerm);
      
      // Get action icon and description
      const getActionInfo = (action: string) => {
        switch (action) {
          case 'copy':
            return { icon: '📋', desc: 'Copy URL' };
          case 'incognito':
            return { icon: '🕵️', desc: 'Open in Incognito' };
          default:
            return { icon: '🌐', desc: 'Open in Browser' };
        }
      };
      
      const actionInfo = getActionInfo(actionType);
      
      return searchResults
        .map((result, index) => ({
          Title: `${actionInfo.icon} ${result.bookmark.title}`,
          SubTitle: result.bookmark.description || this.buildDynamicDescription(result.bookmark, actionInfo.desc, result.score),
          Icon: this.getDynamicIcon(result.bookmark),
          Score: 1000 - index,
          ContextData: JSON.stringify({
            url: result.bookmark.url,
            title: result.bookmark.title,
            action: actionType
          }),
          Actions: [{
            Name: actionInfo.desc,
            Action: async (context: any) => {
              console.log(`[SmartBookmarks] ${actionInfo.desc}: ${result.bookmark.url}`);
              
              switch (actionType) {
                case 'copy':
                  this.copyUrlToClipboard(result.bookmark.url);
                  break;
                case 'incognito':
                  this.updateBookmarkStats(result.bookmark);
                  this.openUrlInIncognito(result.bookmark.url);
                  break;
                default:
                  this.updateBookmarkStats(result.bookmark);
                  this.openUrlDirectly(result.bookmark.url);
                  break;
              }
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

  private getAvailableFolders(): string[] {
    const folders = new Set<string>();
    this.bookmarks.forEach(bm => {
      if (bm.folder) {
        folders.add(bm.folder);
      }
    });
    return Array.from(folders);
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

  private updateBookmarkStats(bookmark: Bookmark): void {
    try {
      // Update last used time
      bookmark.lastUsed = new Date().toISOString();
      
      // Increment visit count
      bookmark.visitCount = (bookmark.visitCount || 0) + 1;
      
      console.log(`[SmartBookmarks] Updated stats for: ${bookmark.title} (visits: ${bookmark.visitCount})`);
    } catch (error) {
      console.error(`[SmartBookmarks] Error updating bookmark stats:`, error);
    }
  }

  private getBrowserIcon(source?: string): string {
    switch (source) {
      case 'edge':
        return 'icon.png'; // Can add Edge-specific icon
      case 'chrome':
        return 'icon.png'; // Can add Chrome-specific icon
      case 'brave':
        return 'icon.png'; // Can add Brave-specific icon
      default:
        return 'icon.png';
    }
  }

  private getCustomIconUrl(domain: string): string | null {
    try {
      const customIconsData = this.settings.customicons || "[]";
      
      // Try to parse as JSON array (table format)
      try {
        const customicons = JSON.parse(customIconsData);
        
        if (Array.isArray(customicons)) {
          // Table format with keys: domain, iconUrl
          for (const entry of customicons) {
            if (entry.domain && entry.iconUrl) {
              const entryDomain = entry.domain.toLowerCase().trim();
              const targetDomain = domain.toLowerCase();
              
              // Check for exact match
              if (entryDomain === targetDomain) {
                return entry.iconUrl.trim();
              }
              
              // Check for domain without www prefix
              const domainWithoutWww = targetDomain.replace(/^www\./, '');
              if (entryDomain === domainWithoutWww) {
                return entry.iconUrl.trim();
              }
              
              // Check for domain with www prefix
              const domainWithWww = `www.${domainWithoutWww}`;
              if (entryDomain === domainWithWww) {
                return entry.iconUrl.trim();
              }
            }
          }
        }
      } catch (jsonError) {
        // If JSON parsing fails, try simple line format for backward compatibility
        if (customIconsData.includes('|')) {
          const lines = customIconsData.split('\n');
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine && trimmedLine.includes('|')) {
              const [entryDomain, iconUrl] = trimmedLine.split('|');
              if (entryDomain && iconUrl) {
                const cleanEntryDomain = entryDomain.trim().toLowerCase();
                const targetDomain = domain.toLowerCase();
                
                if (cleanEntryDomain === targetDomain) {
                  return iconUrl.trim();
                }
                
                const domainWithoutWww = targetDomain.replace(/^www\./, '');
                if (cleanEntryDomain === domainWithoutWww) {
                  return iconUrl.trim();
                }
                
                const domainWithWww = `www.${domainWithoutWww}`;
                if (cleanEntryDomain === domainWithWww) {
                  return iconUrl.trim();
                }
              }
            }
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error(`[SmartBookmarks] Error parsing custom icons:`, error);
      return null;
    }
  }

  private getDynamicIcon(bookmark: Bookmark): { ImageType: "relative" | "url"; ImageData: string } {
    const url = bookmark.url.toLowerCase();
    const domain = this.extractDomain(url);
    
    // First, check for custom icons
    if (domain) {
      const customIconUrl = this.getCustomIconUrl(domain);
      if (customIconUrl) {
        console.log(`[SmartBookmarks] Using custom icon for ${domain}: ${customIconUrl}`);
        return { ImageType: "url", ImageData: customIconUrl };
      }
    }
    
    // If we have a valid domain, use real favicon
    if (domain && domain.includes('.')) {
      // Use Google Favicons service to get favicon
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
      return { ImageType: "url", ImageData: faviconUrl };
    }
    
    // Default icon if favicon fails
    return { ImageType: "relative", ImageData: "icon.png" };
  }

  private extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.toLowerCase();
    } catch (e) {
      // If URL parsing fails, extract domain manually
      const parts = url.replace(/^https?:\/\//, '').split('/');
      return parts[0]?.toLowerCase() || '';
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

  private copyUrlToClipboard(url: string): void {
    try {
      console.log(`[SmartBookmarks] Copying URL to clipboard: ${url}`);
      
      // Use PowerShell to copy URL to clipboard (more reliable than clip)
      const powershellCommand = `powershell -Command "Set-Clipboard -Value '${url.replace(/'/g, "''")}'"`;
      
      exec(powershellCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`[SmartBookmarks] Error copying URL: ${error.message}`);
          // Fallback to clip command
          exec(`echo|set /p="${url}"|clip`, (error2) => {
            if (error2) {
              console.error(`[SmartBookmarks] Fallback copy also failed: ${error2.message}`);
            } else {
              console.log(`[SmartBookmarks] Successfully copied URL to clipboard (fallback): ${url}`);
            }
          });
          return;
        }
        if (stderr) {
          console.error(`[SmartBookmarks] stderr: ${stderr}`);
          return;
        }
        console.log(`[SmartBookmarks] Successfully copied URL to clipboard: ${url}`);
      });
    } catch (error) {
      console.error(`[SmartBookmarks] Error in copyUrlToClipboard:`, error);
    }
  }

  private openUrlInIncognito(url: string): void {
    try {
      console.log(`[SmartBookmarks] Opening URL in incognito: ${url}`);
      
      // Try different browsers for incognito mode
      const browsers = [
        { name: 'Chrome', command: `start chrome --incognito "${url}"` },
        { name: 'Edge', command: `start msedge --inprivate "${url}"` },
        { name: 'Firefox', command: `start firefox --private-window "${url}"` },
        { name: 'Brave', command: `start brave --incognito "${url}"` }
      ];

      // Try Chrome first (most common)
      exec(browsers[0].command, (error, stdout, stderr) => {
        if (error) {
          console.log(`[SmartBookmarks] Chrome not available, trying Edge...`);
          // If Chrome fails, try Edge
          exec(browsers[1].command, (error2, stdout2, stderr2) => {
            if (error2) {
              console.log(`[SmartBookmarks] Edge not available, falling back to default browser...`);
              // If both fail, fall back to default browser
              this.openUrlDirectly(url);
            } else {
              console.log(`[SmartBookmarks] Successfully opened URL in Edge incognito: ${url}`);
            }
          });
        } else {
          console.log(`[SmartBookmarks] Successfully opened URL in Chrome incognito: ${url}`);
        }
      });
    } catch (error) {
      console.error(`[SmartBookmarks] Error in openUrlInIncognito:`, error);
    }
  }

  async action(ctx: Context, result: any): Promise<void> {
    try {
      console.log(`[SmartBookmarks] Action called with result:`, result);
      
      let url = '';
      let actionType = 'open';
      
      // Try to parse ContextData if it exists
      if (result.ContextData) {
        try {
          const contextData = JSON.parse(result.ContextData);
          url = contextData.url;
          actionType = contextData.action || 'open';
        } catch (e) {
          // If parsing fails, treat ContextData as URL directly
          url = result.ContextData;
        }
      }
      
      if (!url) {
        console.error(`[SmartBookmarks] No URL found in result`);
        return;
      }
      
      // Find the bookmark to update stats
      const bookmark = this.bookmarks.find(bm => bm.url === url);
      
      // Execute the appropriate action based on type
      console.log(`[SmartBookmarks] Executing action: ${actionType} for URL: ${url}`);
      
      switch (actionType) {
        case 'copy':
          console.log(`[SmartBookmarks] Copying URL: ${url}`);
          this.copyUrlToClipboard(url);
          break;
        case 'incognito':
          console.log(`[SmartBookmarks] Opening in incognito: ${url}`);
          if (bookmark) this.updateBookmarkStats(bookmark);
          this.openUrlInIncognito(url);
          break;
        case 'open':
        default:
          console.log(`[SmartBookmarks] Opening in browser: ${url}`);
          if (bookmark) this.updateBookmarkStats(bookmark);
          this.openUrlDirectly(url);
          break;
      }
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
