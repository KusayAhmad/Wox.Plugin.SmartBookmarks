import { Plugin, Query, Result, Context, PublicAPI, PluginInitParams } from "@wox-launcher/wox-plugin";
import * as fs from "fs";
import * as path from "path";

// Import our new organized modules
import { Bookmark, Browser } from "./interfaces";
import { Logger } from "./logger";
import { SettingsManager } from "./settings-manager";
import { BrowserManager } from "./browser-manager";
import { SearchEngine } from "./search-engine";
import { IconManager } from "./icon-manager";
import { CacheManager } from "./cache-manager";
import { ActionManager } from "./action-manager";

class SmartBookmarksPlugin implements Plugin {
  private static instance: SmartBookmarksPlugin | null = null;
  private bookmarks: Bookmark[] = [];
  private pluginDir: string = "";
  private initialized: boolean = false;
  private watcher: fs.FSWatcher | null = null;
  private lastCheck: number = 0;
  
  // Organized components
  private settingsManager: SettingsManager;
  private browserManager: BrowserManager;
  private searchEngine: SearchEngine;
  private iconManager: IconManager;
  private actionManager: ActionManager;
  private cacheManager: CacheManager;

  private constructor() {
    Logger.log("Constructor called");
    
    // Initialize with empty state to prevent null access
    this.bookmarks = [];
    this.initialized = false;
    this.lastCheck = 0;
    this.watcher = null;

    // Initialize managers (will be updated in init with API)
    this.settingsManager = new SettingsManager(null);
    this.cacheManager = new CacheManager();
    this.browserManager = new BrowserManager(this.cacheManager);
    this.searchEngine = new SearchEngine(this.cacheManager);
    this.iconManager = new IconManager();
    this.actionManager = new ActionManager();

    // Bind methods to this instance
    this.init = this.init.bind(this);
    this.query = this.query.bind(this);
    this.action = this.action.bind(this);
    this.openUrl = this.openUrl.bind(this);
    
    Logger.log("Initial state:", {
      hasInstance: !!SmartBookmarksPlugin.instance,
      bookmarksLength: this.bookmarks.length,
      initialized: this.initialized
    });
  }

  public static getInstance(): SmartBookmarksPlugin {
    if (!SmartBookmarksPlugin.instance) {
      Logger.log("Creating new instance");
      SmartBookmarksPlugin.instance = new SmartBookmarksPlugin();
    } else {
      Logger.log("Returning existing instance");
    }
    return SmartBookmarksPlugin.instance;
  }

  async init(ctx: Context, params: PluginInitParams): Promise<void> {
    try {
      if (!params.PluginDirectory) {
        throw new Error("PluginDirectory not provided in init params");
      }
      
      this.pluginDir = params.PluginDirectory;
      
      // Update settings manager with API
      this.settingsManager = new SettingsManager(params.API);
      
      // Load settings
      await this.settingsManager.loadSettings(ctx);
      
      Logger.log("Initializing with settings:", this.settingsManager.getRawSettings());
      
      // Update icon manager with custom icons
      this.iconManager.setCustomIconsData(this.settingsManager.getCustomIcons());
      
      const localBookmarksPath = path.join(this.pluginDir, "bookmarks.json");
      Logger.log("Initializing with plugin directory:", this.pluginDir);
      
      // Load local bookmarks if enabled
      let localBookmarks: Bookmark[] = [];
      if (this.settingsManager.shouldIncludeLocalBookmarks()) {
        Logger.log("Looking for local bookmarks at:", localBookmarksPath);
        if (fs.existsSync(localBookmarksPath)) {
          const raw = fs.readFileSync(localBookmarksPath, "utf-8");
          const parsed = JSON.parse(raw);
          localBookmarks = Array.isArray(parsed) ? parsed : [];
          Logger.log(`Loaded ${localBookmarks.length} local bookmarks`);
        }
      }

      // Load browser bookmarks
      let browserBookmarks: Bookmark[] = [];
      const enabledBrowsers = this.settingsManager.getEnabledBrowsers();
      
      for (const browser of enabledBrowsers) {
        const bookmarks = await this.browserManager.loadBrowserBookmarks(browser, false); // Don't force on init
        browserBookmarks = browserBookmarks.concat(bookmarks);
      }

      // Combine bookmarks from both sources
      this.bookmarks = [...localBookmarks, ...browserBookmarks];
      Logger.log(`Total bookmarks loaded: ${this.bookmarks.length}`);
      Logger.log(`Sources: Local=${localBookmarks.length}, Browser=${browserBookmarks.length}`);
      
      // Set up file watcher
      this.setupWatcher();
      
      // Setup periodic cache maintenance
      this.setupCacheMaintenance();
      
      this.initialized = true;
      this.lastCheck = Date.now();
      Logger.log("Initialization complete, initialized =", this.initialized);
    } catch (error) {
      Logger.error("Error in init:", error);
      this.bookmarks = [];
      this.initialized = false;
      throw error;
    }
  }

  private setupWatcher(): void {
    try {
      if (this.watcher) {
        this.watcher.close();
      }

      const enabledBrowsers = this.settingsManager.getEnabledBrowsers();
      this.browserManager.setupWatcher(enabledBrowsers, () => {
        this.refreshBookmarks(true); // Force reload when files change
      });

      Logger.log("File watcher setup complete");
    } catch (error) {
      Logger.error("Error setting up watcher:", error);
    }
  }

  private setupCacheMaintenance(): void {
    // Run cache optimization every 10 minutes
    setInterval(async () => {
      try {
        const optimization = await this.cacheManager.optimizeCacheSize();
        if (optimization.removedExpired > 0 || optimization.removedLRU > 0) {
          Logger.log(`Cache maintenance: removed ${optimization.removedExpired} expired, ${optimization.removedLRU} LRU entries`);
        }
      } catch (error) {
        Logger.error('Cache maintenance error:', error);
      }
    }, 10 * 60 * 1000); // 10 minutes

    // Run cache validation every 30 minutes
    setInterval(async () => {
      try {
        const validation = await this.cacheManager.validateCacheIntegrity();
        if (validation.invalid > 0 || validation.cleaned > 0) {
          Logger.log(`Cache validation: found ${validation.invalid} invalid, cleaned ${validation.cleaned} entries`);
        }
      } catch (error) {
        Logger.error('Cache validation error:', error);
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  private async refreshBookmarks(forceReload: boolean = false): Promise<void> {
    try {
      let allBookmarks: Bookmark[] = [];

      // Load local bookmarks if enabled
      if (this.settingsManager.shouldIncludeLocalBookmarks()) {
        const localBookmarksPath = path.join(this.pluginDir, "bookmarks.json");
        
        if (fs.existsSync(localBookmarksPath)) {
          try {
            const raw = await fs.promises.readFile(localBookmarksPath, "utf-8");
            const parsed = JSON.parse(raw);
            const localBookmarks = Array.isArray(parsed) ? parsed : [];
            allBookmarks = allBookmarks.concat(localBookmarks);
            Logger.log(`Refreshed ${localBookmarks.length} local bookmarks`);
          } catch (error) {
            Logger.error("Error loading local bookmarks:", error);
          }
        }
      }

      // Load browser bookmarks based on settings (now cached and async)
      const enabledBrowsers = this.settingsManager.getEnabledBrowsers();
      
      // If forceReload is true, clear cache first
      if (forceReload) {
        enabledBrowsers.forEach(browser => {
          this.browserManager.invalidateCache(browser);
        });
        Logger.log("Cleared browser caches for forced reload");
      }
      
      // Process browsers in parallel for better performance
      const browserPromises = enabledBrowsers.map(async (browser) => {
        try {
          return await this.browserManager.loadBrowserBookmarks(browser, forceReload);
        } catch (error) {
          Logger.error(`Error loading ${browser} bookmarks:`, error);
          return [];
        }
      });

      const browserResults = await Promise.all(browserPromises);
      const browserBookmarks = browserResults.flat();
      allBookmarks = allBookmarks.concat(browserBookmarks);

      // Update bookmarks and icon manager
      this.bookmarks = allBookmarks;
      this.iconManager.setCustomIconsData(this.settingsManager.getCustomIcons());
      this.lastCheck = Date.now();
      
      Logger.log(`Total bookmarks after refresh: ${this.bookmarks.length}`);
      Logger.log("Cache stats:", this.browserManager.getCacheStats());
    } catch (error) {
      Logger.error("Error refreshing bookmarks:", error);
    }
  }

  private buildDynamicDescription(bookmark: Bookmark, actionDesc: string, score?: number): string {
    const parts: string[] = [];
    
    // Add browser source if enabled
    if (this.settingsManager.shouldShowBrowserSource() && bookmark.source) {
      parts.push(`${bookmark.source.charAt(0).toUpperCase() + bookmark.source.slice(1)}`);
    }
    
    // Add domain if enabled
    if (this.settingsManager.shouldShowDomain() && bookmark.domain) {
      parts.push(bookmark.domain);
    }
    
    // Add date added if enabled
    if (this.settingsManager.shouldShowDateAdded() && bookmark.dateAdded) {
      const dateAdded = new Date(bookmark.dateAdded).toLocaleDateString();
      parts.push(`Added: ${dateAdded}`);
    }
    
    // Add last used if enabled
    if (this.settingsManager.shouldShowLastUsed() && bookmark.lastUsed) {
      if (bookmark.lastUsed === "Never") {
        parts.push(`Last used: Never`);
      } else {
        const lastUsedDate = new Date(bookmark.lastUsed).toLocaleDateString();
        parts.push(`Last used: ${lastUsedDate}`);
      }
    }
    
    // Add score if enabled and provided
    if (this.settingsManager.shouldShowScore() && score !== undefined) {
      parts.push(`Score: ${score}`);
    }
    
    // If no parts, show action description and URL
    if (parts.length === 0) {
      return `${actionDesc}: ${bookmark.url}`;
    }
    
    return parts.join(' • ');
  }

  async query(ctx: Context, query: Query): Promise<Result[]> {
    try {
      // Reload settings every time to get latest changes
      await this.settingsManager.loadSettings(ctx);
      this.iconManager.setCustomIconsData(this.settingsManager.getCustomIcons());
      
      // Check if we need to refresh bookmarks based on settings
      const refreshInterval = this.settingsManager.getRefreshInterval();
      const now = Date.now();
      if (now - this.lastCheck > refreshInterval) {
        Logger.log("Checking for bookmark updates...");
        await this.refreshBookmarks();
      }

      let searchTerm = query.Search.toLowerCase();
      const maxAllowedResults = this.settingsManager.getMaxResults();

      // Handle folder-specific commands
      if (searchTerm.startsWith('f:')) {
        return this.handleFolderSearch(searchTerm.substring(2).trim());
      }

      Logger.log(`Query received: "${query.Search}"`);
      Logger.log("Plugin state:", {
        initialized: this.initialized,
        bookmarksLength: this.bookmarks.length,
        pluginDir: this.pluginDir,
        lastCheck: new Date(this.lastCheck).toISOString()
      });

      if (!this.initialized) {
        Logger.warn("Plugin not initialized yet");
        return [{
          Title: "Plugin not initialized yet",
          SubTitle: "Please wait or restart Wox",
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 0
        }];
      }

      // Handle action-specific commands
      let actionType = 'open';
      
      if (searchTerm.startsWith('o ')) {
        actionType = 'open';
        searchTerm = query.Search.substring(2);
      } else if (searchTerm.startsWith('c ')) {
        actionType = 'copy';
        searchTerm = query.Search.substring(2);
      } else if (searchTerm.startsWith('i ')) {
        actionType = 'incognito';
        searchTerm = query.Search.substring(2);
      }
      
      // Handle special commands
      if (searchTerm === 'reload' || searchTerm === 'refresh') {
        // Clear all caches first
        try {
          if (typeof this.searchEngine.clearAllCaches === 'function') {
            this.searchEngine.clearAllCaches();
          } else {
            Logger.error("clearAllCaches method not found on searchEngine");
          }
          
          if (typeof this.browserManager.invalidateCache === 'function') {
            this.browserManager.invalidateCache();
          } else {
            Logger.error("invalidateCache method not found on browserManager");
          }
        } catch (error) {
          Logger.error("Error clearing caches:", error);
        }
        
        await this.settingsManager.loadSettings(ctx);
        await this.refreshBookmarks(true); // Force reload with cache clearing
        return [{
          Title: "Settings and Bookmarks Reloaded",
          SubTitle: `Loaded ${this.bookmarks.length} bookmarks with current settings`,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }

      if (searchTerm === 'cache' || searchTerm === 'cache stats') {
        try {
          const searchCacheStats = this.searchEngine.getCacheStats();
          const browserCacheStats = this.browserManager.getCacheStats();
          
          return [{
            Title: "Cache Statistics",
            SubTitle: `Memory: ${browserCacheStats.memoryUsage} | Search: ${searchCacheStats.searchCacheSize} | Bookmarks: ${browserCacheStats.bookmarkCacheSize}`,
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        } catch (error) {
          Logger.error("Error getting cache stats:", error);
          return [{
            Title: "Cache Stats Error",
            SubTitle: error instanceof Error ? error.message : String(error),
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        }
      }

      if (searchTerm === 'clear cache') {
        try {
          if (typeof this.searchEngine.clearAllCaches === 'function') {
            this.searchEngine.clearAllCaches();
          }
          if (typeof this.browserManager.invalidateCache === 'function') {
            this.browserManager.invalidateCache();
          }
          return [{
            Title: "Cache Cleared",
            SubTitle: "All caches have been cleared successfully",
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        } catch (error) {
          Logger.error("Error clearing cache:", error);
          return [{
            Title: "Clear Cache Error",
            SubTitle: error instanceof Error ? error.message : String(error),
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        }
      }
      
      if (searchTerm === 'settings' || searchTerm === 'config') {
        const enabledBrowsersList = this.settingsManager.getEnabledBrowsers().join(', ');
        const refreshInterval = this.settingsManager.getRefreshInterval() / 1000;
        const maxResults = this.settingsManager.getMaxResults();
        return [{
          Title: "Current Settings",
          SubTitle: `Browsers: ${enabledBrowsersList} | Interval: ${refreshInterval}s | Max: ${maxResults}`,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }

      if (searchTerm === 'help' || searchTerm === '?') {
        return [{
          Title: "Smart Bookmarks Help",
          SubTitle: "Usage: 'bm [term]' = Open | 'bm o [term]' = Open | 'bm c [term]' = Copy | 'bm i [term]' = Incognito",
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }

      if (searchTerm === 'debug' || searchTerm === 'info') {
        const enabledBrowsers = this.settingsManager.getEnabledBrowsers();
        const bookmarkCount = this.bookmarks.length;
        const searchCacheStats = this.searchEngine.getCacheStats();
        const browserCacheStats = this.browserManager.getCacheStats();
        
        let debugInfo = `Bookmarks: ${bookmarkCount} | `;
        debugInfo += `Browsers: [${enabledBrowsers.join(',')}] | `;
        debugInfo += `SearchCache: ${searchCacheStats.searchCacheSize} | `;
        debugInfo += `BrowserCache: ${browserCacheStats.bookmarkCacheSize} | `;
        debugInfo += `Memory: ${browserCacheStats.memoryUsage}`;
        
        return [{
          Title: "Debug Information",
          SubTitle: debugInfo,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }

      if (searchTerm === 'cache debug') {
        // Detailed cache debugging
        const enabledBrowsers = this.settingsManager.getEnabledBrowsers();
        const searchCacheStats = this.searchEngine.getCacheStats();
        const browserCacheStats = this.browserManager.getCacheStats();
        
        let debugInfo = `Total Bookmarks: ${this.bookmarks.length} | `;
        debugInfo += `Enabled Browsers: [${enabledBrowsers.join(',')}] | `;
        debugInfo += `Search Cache: Search=${searchCacheStats.searchCacheSize}, SearchBookmarks=${searchCacheStats.bookmarkCacheSize} | `;
        debugInfo += `Browser Cache: Bookmarks=${browserCacheStats.bookmarkCacheSize}, FileStats=${browserCacheStats.fileStatsCacheSize} | `;
        debugInfo += `Memory: ${browserCacheStats.memoryUsage}`;
        
        return [{
          Title: "Cache Debug Information",
          SubTitle: debugInfo,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }

      if (searchTerm === 'validate cache') {
        try {
          const validation = await this.cacheManager.validateCacheIntegrity();
          const summary = `Valid: ${validation.valid}, Invalid: ${validation.invalid}, Cleaned: ${validation.cleaned}`;
          const details = validation.report.length > 0 
            ? validation.report.slice(0, 3).join('; ') + (validation.report.length > 3 ? '...' : '')
            : 'All cache entries are valid';
          
          return [{
            Title: "✅ Cache Validation Complete",
            SubTitle: `${summary} | ${details}`,
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        } catch (error) {
          Logger.error('Failed to validate cache:', error);
          return [{
            Title: "❌ Cache Validation Error",
            SubTitle: `Failed to validate cache: ${error}`,
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        }
      }

      if (searchTerm === 'optimize cache') {
        try {
          const optimization = await this.cacheManager.optimizeCacheSize();
          const summary = `Expired: ${optimization.removedExpired}, LRU: ${optimization.removedLRU}, Preserved: ${optimization.preservedImportant}`;
          
          return [{
            Title: "🚀 Cache Optimization Complete",
            SubTitle: `${summary} | Memory: ${optimization.memoryFreed}`,
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        } catch (error) {
          Logger.error('Failed to optimize cache:', error);
          return [{
            Title: "❌ Cache Optimization Error",
            SubTitle: `Failed to optimize cache: ${error}`,
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        }
      }

      if (searchTerm === 'cache health') {
        try {
          const health = this.cacheManager.getCacheHealth();
          const statusIcon = health.status === 'healthy' ? '💚' : health.status === 'warning' ? '⚠️' : '❌';
          const metrics = `${health.metrics.totalEntries} entries, ${health.metrics.memoryUsage}, ${health.metrics.hitRate}% hit rate`;
          const issues = health.issues.length > 0 ? health.issues.join('; ') : 'No issues detected';
          
          return [{
            Title: `${statusIcon} Cache Health: ${health.status.toUpperCase()}`,
            SubTitle: `${metrics} | ${issues}`,
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        } catch (error) {
          Logger.error('Failed to get cache health:', error);
          return [{
            Title: "❌ Cache Health Error",
            SubTitle: `Failed to get cache health: ${error}`,
            Icon: { ImageType: "relative", ImageData: "icon.png" },
            Score: 1000
          }];
        }
      }

      if (searchTerm === 'force reload') {
        // Force complete reload
        this.searchEngine.clearAllCaches();
        this.browserManager.invalidateCache();
        await this.settingsManager.loadSettings(ctx);
        await this.refreshBookmarks(true);
        
        const cacheStats = this.searchEngine.getCacheStats();
        return [{
          Title: "Force Reload Complete",
          SubTitle: `Loaded ${this.bookmarks.length} bookmarks | Cache: ${cacheStats.bookmarkCacheSize} browsers`,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }
      
      // Show usage examples if only action prefix is entered
      if (searchTerm === 'o' || searchTerm === 'c' || searchTerm === 'i') {
        const actionInfo = this.actionManager.getActionInfo(searchTerm);
        
        return [{
          Title: `${actionInfo.icon} ${actionInfo.desc} - Enter search term`,
          SubTitle: `Type 'bm ${searchTerm} [search term]' to search and ${actionInfo.desc.toLowerCase()}`,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 1000
        }];
      }
      
      // Use smart search engine
      const searchResults = this.searchEngine.smartSearch(this.bookmarks, searchTerm, maxAllowedResults);
      
      // Get action info
      const actionInfo = this.actionManager.getActionInfo(actionType);
      
      return searchResults
        .map((result, index) => ({
          Title: `${actionInfo.icon} ${result.bookmark.title}`,
          SubTitle: result.bookmark.description || this.buildDynamicDescription(result.bookmark, actionInfo.desc, result.score),
          Icon: this.iconManager.getDynamicIcon(result.bookmark),
          Score: 1000 - index,
          ContextData: JSON.stringify({
            url: result.bookmark.url,
            title: result.bookmark.title,
            action: actionType
          }),
          Actions: [{
            Name: actionInfo.desc,
            Action: async () => {
              Logger.log(`${actionInfo.desc}: ${result.bookmark.url}`);
              await this.actionManager.executeAction(actionType, result.bookmark);
            }
          }]
        }));
    } catch (error) {
      Logger.error("Error in query:", error);
      return [{
        Title: "Error occurred while searching bookmarks",
        SubTitle: error instanceof Error ? error.message : String(error),
        Icon: { ImageType: "relative", ImageData: "icon.png" },
        Score: 0
      }];
    }
  }

  private handleFolderSearch(folderTerm: string): Result[] {
    if (!folderTerm) {
      // If no folder specified, list all available folders
      const folders = this.searchEngine.getAvailableFolders(this.bookmarks);
      return folders.map(folder => ({
        Title: `📁 ${folder}`,
        SubTitle: `Search bookmarks in folder: ${folder}`,
        Icon: { ImageType: "relative", ImageData: "icon.png" },
        Score: 1000,
        ContextData: JSON.stringify({ folder })
      }));
    }

    // Search in folder
    const filteredBookmarks = this.searchEngine.searchInFolder(this.bookmarks, folderTerm);

    // If no bookmarks found, show matching folders
    if (filteredBookmarks.length === 0) {
      const matchingFolders = this.searchEngine.getMatchingFolders(this.bookmarks, folderTerm);
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
        SubTitle: this.buildDynamicDescription(bm, 'Open'),
        Icon: this.iconManager.getDynamicIcon(bm),
        Score: 1000 - index,
        ContextData: JSON.stringify({
          url: bm.url,
          title: bm.title,
          folder: bm.folder,
          action: 'open'
        }),
        Actions: [{
          Name: 'Open',
          Action: async () => {
            await this.actionManager.executeAction('open', bm);
          }
        }]
      }));
  }

  async openUrl(ctx: Context, ...params: any[]): Promise<void> {
    try {
      const url = params[0] as string;
      Logger.log(`Opening URL: ${url} (params:`, params, `)`);
      
      if (!url) {
        Logger.error("No URL provided to openUrl method");
        return;
      }
      
      this.actionManager.openUrlDirectly(url);
    } catch (error) {
      Logger.error("Error in openUrl:", error);
    }
  }

  async action(ctx: Context, result: any): Promise<void> {
    try {
      Logger.log("Action called with result:", result);
      
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
        Logger.error("No URL found in result");
        return;
      }
      
      // Find the bookmark to update stats
      const bookmark = this.bookmarks.find(bm => bm.url === url);
      
      if (!bookmark) {
        Logger.error("Bookmark not found for URL:", url);
        return;
      }
      
      // Execute the action
      Logger.log(`Executing action: ${actionType} for URL: ${url}`);
      await this.actionManager.executeAction(actionType, bookmark);
    } catch (error) {
      Logger.error("Error in action:", error);
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
